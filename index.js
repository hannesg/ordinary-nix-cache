import process from "node:process";
import child_process from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { open, mkdir, rename, stat, readdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { join, dirname } from 'node:path';
const { pipeline } = require('node:stream/promises');
import { setTimeout } from "node:timers/promises";
import * as core from "@actions/core";
import * as cache from "@actions/cache";

const LISTEN = 18008;

const STATE_STARTED = "MNC_STARTED";

function req(path) {
	return new Promise((resolve, reject) => {
		const req = http.request(`http://localhost:${LISTEN}/${path}`);
		req.on("response", (rep) => {
			const body = [];
			rep.on("error", (err) => {
				reject(err)
			});
			rep.on("data", (chunk) => {
				body.push(chunk.toString());
			})
			rep.on("end", () => resolve({ statusCode: rep.statusCode, body: body.join() }));
		});
		req.on("error", (err) => reject(err));
		req.end();
	});
}

async function checkReady() {
	const prom = req("readyz")
	try {
		const res = await prom;
		if (res.statusCode == 200) {
			return true
		}
		core.debug(`not ready: ${res.statusCode} ${res.body}`)

	} catch (err) {
		core.debug(`not ready: ${err}`);
	}
	return false;
}

async function shutdown() {
	const prom = req("quit")
	try {
		const res = await prom;
		core.debug(`quit: ${res.statusCode} ${res.body}`)
	} catch (err) {
		core.log(`quit: ${err}`);
	}
	return false;
}


export async function run() {
	const started = core.getState(STATE_STARTED);
	if (started != "") {
		await stop();
	} else {
		await start();
		core.saveState(STATE_STARTED, "1");
		core.exportVariable("NIX_CONFIG", "extra-substituters = http://localhost:18008?priority=10")
	}
}

async function stop() {
	await shutdown()
	const outlog = await readFile("/tmp/output.log");
	core.log(outlog.toString());
};
async function start() {
	if (await checkReady()) {
		return;
	}
	const output = openSync("/tmp/output.log", "a");
	core.debug(`running ${process.argv0} ${import.meta.filename} serve`);
	const server = child_process.spawn(process.argv0, [import.meta.filename, "serve"], { detached: true, stdio: ["ignore", output, output] });
	server.unref();
	for (let i = 0; i < 20; i++) {
		await setTimeout(1000);
		if (await checkReady()) {
			return;
		}
	}
	const outlog = await readFile("/tmp/output.log");
	console.log(outlog.toString());
	throw new Error("unable to start nix cache");
};

export function memoryCache() {
	const storage = {};
	const readRecursive = async (path, result = {}) => {
		const s = await stat(path);
		if (s.isDirectory()) {
			const files = await readdir(path);
			for (const file of files) {
				await readRecursive(join(path, file), result)
			}
		} else if (s.isFile()) {
			result[path] = await readFile(path);
		}
		return result;
	}
	const writeRecursive = async (files) => {
		for (const path in files) {
			await mkdir(dirname(path), { recursive: true })
			await writeFile(path, files[path])
		}
	}
	return {
		isFeatureAvailable: () => true,
		saveCache: async (paths, key) => {
			const pathSpec = JSON.stringify(paths)
			const files = []
			for (const path of paths) {
				files.push(await readRecursive(path));
			}
			storage[key] = {
				pathSpec: pathSpec,
				files: files
			}
		},
		restoreCache: async (paths, key, restoreKeys) => {
			if (!restoreKeys) {
				restoreKeys = [];
			}
			const pathSpec = JSON.stringify(paths)
			const allKeys = [key, ...restoreKeys];
			for (const key of allKeys) {
				const files = storage[key];
				if (!files) {
					continue
				}
				if (files.pathSpec != pathSpec) {
					throw new Error(`paths mismatch in cache ${key}`)
				}
				for (const file in files.files) {
					await writeRecursive(file)
				}
				return key;
			}
			return undefined;
		}
	};
}


const CACHE_INFO = `StoreDir: /nix/store
WantMassQuery: 1
Priority: 10`;


const urlFromNarInfo = (narinfo) => {
	const m = /^URL: (.+)$/m.exec(narinfo)
	if (m) {
		return m[1]
	}
	return undefined
}

const body = (req) => {
	return new Promise((resolve, reject) => {
		let body = [];
		req.on('data', (chunk) => {
			body.push(chunk);
		}).on('end', () => {
			resolve(Buffer.concat(body))
		}).on('error', err => reject(err));
	});
}

export function server(options) {
	const chc = options.cache || cache;
	const dir = options.dir;
	mkdirSync(join(dir, "nar"), { recursive: true });
	process.chdir(dir);
	const narsFiles = {};
	const narinfo = /^\/([a-z0-9]{32})\.narinfo$/
	const narfile = /^\/(nar\/[a-z0-9]{52}\.nar(?:\..+))$/
	return async (req, res) => {
		const url = new URL(`http://localhost${req.url}`);
		if (!chc.isFeatureAvailable()) {
			throw new Error("cache is not available");
		}
		core.debug(`${req.method} ${url.pathname}`)
		if (url.pathname == "/nix-cache-info") {
			res.writeHead(200, {
				'Content-Length': Buffer.byteLength(CACHE_INFO),
				'Content-Type': 'text/plain',
			}).end(CACHE_INFO);
			return;
		}
		const nm = narinfo.exec(url.pathname);
		if (nm) {
			// narinfo
			if (req.method == 'GET') {
				core.debug(`trying to restore narinfo "${nm[1]}"`)
				await chc.restoreCache([`./${nm[1]}`], nm[1]);
				try {
					const f = await readFile(`./${nm[1]}/narinfo`, { encoding: "utf8" });
					const url = urlFromNarInfo(f);
					core.debug(`narinfo ${nm[1]} is in cache, referencing ${url}`);
					narsFiles[url] = nm[1]
					res.writeHead(200, {
						'Content-Length': Buffer.byteLength(f),
						'Content-Type': 'text/x-nix-narinfo',
					});
					await pipeline(f, res);
					return;
				} catch (e) {
					core.debug(`narinfo ${nm[1]} is not in cache`);
					res.writeHead(404).end();
					return
				}
			} else if (req.method == 'PUT') {
				const b = await body(req);
				const url = urlFromNarInfo(b);
				if (!url) {
					core.error(`${nm[1]} should have an URL: ${b}`)
					res.writeHead(400).end();
					return
				}
				await mkdir(`./${nm[1]}`, { recursive: true });
				await writeFile(`./${nm[1]}/narinfo`, b)
				await mkdir(`./${nm[1]}/nar`, { recursive: true })
				await rename(`./${url}`, `./${nm[1]}/${url}`)
				// TODO: check that nar exists
				await chc.saveCache([`./${nm[1]}`], nm[1]);
				core.debug(`narinfo ${nm[1]} added to cache, referencing ${url}`);
				res.writeHead(204, {})
				res.end()
				return
			}
		}
		const path = url.pathname.replace(/^\//, "")
		if (narsFiles[path]) {
			const narFile = narsFiles[path]
			core.debug(`narinfo ${narFile} found referencing ${path}`);
			if (req.method == 'GET') {
				const f = await open(`./${narFile}/${path}`, 'r');
				const s = await f.stat();
				res.writeHead(200, {
					'Content-Length': s.size,
					'Content-Type': 'application/x-nix-nar',
				});
				await pipeline(f.createReadStream(), res);
				return;
			}
		}
		const nam = narfile.exec(url.pathname);
		if (nam) {
			if (req.method == 'PUT') {
				const f = await open(`./${nam[1]}`, 'w');
				await pipeline(req, f, { end: false });
				await f.close();
				core.debug(`${nam[1]} added to files`);
				res.writeHead(204, {})
				res.end()
				return
			}
			if (req.method == 'GET' || req.method == 'HEAD') {
				res.writeHead(404).end();
				return
			}
		}
		core.error(`unhandled request ${req.method} ${url.pathname}`);
		res.writeHead(404).end();
	}
}

export function serve(options) {
	if (!options.cache.isFeatureAvailable()) {
		core.error("Github cache is not available");
	}
	let inflight = 0;
	const reqs = {};
	const srv = http.createServer();
	const s = server(options);
	srv.on('request', (req, res) => {
		const url = new URL(`http://localhost${req.url}`);
		if (url.pathname == "/quit") {
			res.writeHead(200).write("Goodbye");
			res.end();
			srv.close();
			return;
		}
		if (url.pathname == "/readyz") {
			res.writeHead(200).write("ok");
			res.end();
			return;
		}
		const id = inflight;
		inflight++;
		reqs[id] = { url: url };
		res.on("close", () => delete (reqs[id]));
		s(req, res);
	});
	core.debug(`Listening on ${LISTEN}`)
	srv.listen(LISTEN);
};

if (process.argv[2] == "serve") {
	serve({ cache: cache, dir: "/tmp" });
} else if (process.argv[2] == "serve-local") {
	serve({ cache: memoryCache(), dir: "/tmp/ghn" });
} else {
	await run();
}
