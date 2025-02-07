import process from "node:process";
import child_process from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from 'node:path';
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
		req.on("close", () => { console.debug(`closed ${path}`) })
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
		console.debug(`quit: ${res.statusCode} ${res.body}`)
	} catch (err) {
		console.log(`quit: ${err}`);
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
	}
}

async function stop() {
	if (await shutdown()) {
		return;
	}
};
async function start() {
	if (await checkReady()) {
		return;
	}
	const output = openSync("output.log", "a");
	console.debug("running", process.argv0, import.meta.filename);
	const server = child_process.spawn(process.argv0, [import.meta.filename, "serve"], { detached: true, stdio: ["ignore", output, output] });
	server.unref();
	for (; ;) {
		await setTimeout(1000);
		if (await checkReady()) {
			break;
		}
	}
	console.log("ready!");
	return;
};


export function memoryCache() {
	const storage = {};
	return {
		isFeatureAvailable: () => true,
		saveCache: async (paths, key) => {
			const files = {}
			for (const path of paths) {
				files[path] = await readFile(path);
			}
			storage[key] = files
		},
		restoreCache: async (paths, key, restoreKeys) => {
			if (!restoreKeys) {
				restoreKeys = [];
			}
			const allKeys = [key, ...restoreKeys];
			for (const key of allKeys) {
				const files = storage[key];
				if (!files) {
					continue
				}
				for (const path of paths) {
					if (!files[path]) {
						throw new Error(`${path} is not a valid path for ${key}`)
					}
					await writeFile(path, files[path]);
				}
				return key;
			}
			return undefined;
		}
	};
}


const CACHE_INFO = `StoreDir: /nix/store
WantMassQuery: 1
Priority: 41`;


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
				const restored = await chc.restoreCache([`./${nm[1]}.narinfo`], nm[1]);
				if (restored === undefined) {
					core.debug(`${nm[1]} is not in cache`);
					res.writeHead(404).end();
					return
				}
				core.debug(`${nm[1]} is in cache`);
				const f = await readFile(`./${nm[1]}.narinfo`, { encoding: "utf8" });
				const url = urlFromNarInfo(f);
				core.debug(`${url} is now known`)
				narsFiles[url] = nm[1]
				res.writeHead(200, {
					'Content-Length': Buffer.byteLength(f),
					'Content-Type': 'text/plain',
				});
				await pipeline(f, res);
				return;
			} else if (req.method == 'PUT') {
				const b = await body(req);
				const url = urlFromNarInfo(b);
				if (!url) {
					core.error(`${nm[1]} should have an URL: ${b}`)
					res.writeHead(400).end();
					return
				}
				const f = await open(`./${nm[1]}.narinfo`, 'w');
				await pipeline(b, f, { end: false });
				await f.close();
				// TODO: check that nar exists
				await chc.saveCache([`./${nm[1]}.narinfo`, `./${url}`], nm[1]);
				core.debug(`${nm[1]} added to cache`);
				res.writeHead(204, {})
				res.end()
				return
			}
		}
		const path = url.pathname.replace(/^\//, "")
		if (narsFiles[path]) {
			const narFile = narsFiles[path]
			if (req.method == 'GET') {
				const key = await chc.restoreCache([`./${path}`], narFile);
				if (!key) {
					core.error(`${path} should have been in ${narFile} but it's not`)
					res.writeHead(404).end();
					return
				}
				const f = await open(`./${path}`, 'r');
				const s = await f.stat();
				res.writeHead(200, {
					'Content-Length': s.size,
					'Content-Type': 'text/plain',
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
		}
		res.writeHead(404).end();
	}
}

export function serve(options) {
	if (options.cache.isFeatureAvailable()) {
		console.error("Github cache is not available");
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
		const id = inflight;
		inflight++;
		reqs[id] = { url: url };
		res.on("close", () => delete (reqs[id]));
		s(req, res);
	});
	core.debug(`Listening on ${LISTEN}`)
	srv.listen(LISTEN);
};

if (process.argv[2] == "run") {
	await run();
} else if (process.argv[2] == "serve") {
	serve({ cache: cache, dir: "/tmp" });
} else if (process.argv[2] == "serve-local") {
	serve({ cache: memoryCache(), dir: "/tmp" });
}
