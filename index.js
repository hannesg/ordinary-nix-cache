import process from "node:process";
import child_process from "node:child_process";
import { createReadStream, mkdirSync, openSync } from "node:fs";
import { open, mkdir, rename, stat, readdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from "node:timers/promises";
import { createHash } from "crypto"
import * as core from "@actions/core";
import * as cache from "@actions/cache";

const LISTEN = 18008;

const STATE_STARTED = "MNC_STARTED";
const PREFIX = "nix0:"

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
		const configFile = "/tmp/ghn-nix.conf";
		const autoUpload = `${import.meta.dirname}/upload.mjs`;
		await writeFile(configFile, `extra-substituters = http://localhost:18008?priority=10&trusted=true
post-build-hook = ${autoUpload}
`, {})
		core.exportVariable("ORDINARY_NIX_CACHE", "http://localhost:18008")
		core.exportVariable("NIX_USER_CONF_FILES", configFile)
	}
}

async function stop() {
	await shutdown()
	const outlog = await readFile("/tmp/output.log");
	console.log(outlog.toString());
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

const parseNarInfo = (narinfo) => {
	return narinfo.toString().split("\n").map(l => l.split(": ")).filter(l => l.length > 1).reduce((obj, k) => { obj[k[0]] ||= []; obj[k[0]].push(k[1]); return obj }, {})
}

const hash = async (algo, file) => {
	const hsh = createHash(algo)
	const stream = createReadStream(file)
	for await (const chunk of stream) {
		hsh.update(chunk)
	}
	return hsh.digest("hex")
}

const nixBase32Alpha = "0123456789abcdfghijklmnpqrsvwxyz";
export const nixBase32 = (input) => {
	// see https://github.com/NixOS/nix/blob/master/src/libutil/hash.cc#L83-L107
	const src = Buffer.from(input, "hex")
	const b32length = Math.ceil(src.byteLength * 8 / 5)
	const r = Buffer.alloc(b32length)
	for (let n = b32length - 1; n >= 0; n -= 1) {
		const b = n * 5;
		const i = b >> 3;
		const j = b % 8;
		const c2 = i >= (src.length - 1) ? 0 : (src.readUint8(i + 1) << (8 - j));
		const c = ((src.readUint8(i) >> j) | c2) & 0x1f;
		r.write(nixBase32Alpha.charAt(c), b32length - 1 - n)
	}
	return r.toString()
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
		if (url.pathname == "/upload") {
			const b = await body(req);
			const paths = b.toString().split(' ')
			res.writeHead(204, {})
			res.end()
			core.debug(`running nix copy --to http://localhost:18008 ${paths}`)
			child_process.spawn("nix", ["copy", "--to", "http://localhost:18008", ...paths], { detached: true, stdio: ["ignore", "inherit", "inherit"] });

			return
		}
		const nm = narinfo.exec(url.pathname);
		if (nm) {
			// narinfo
			if (req.method == 'GET') {
				core.debug(`trying to restore narinfo "${nm[1]}"`)
				await chc.restoreCache([`./${nm[1]}`], PREFIX + nm[1]);
				try {
					const f = await readFile(`./${nm[1]}/narinfo`, { encoding: "utf8" });
					const url = urlFromNarInfo(f);
					narsFiles[url] = nm[1]
					res.writeHead(200, {
						'Content-Length': Buffer.byteLength(f),
						'Content-Type': 'text/x-nix-narinfo',
					});
					await pipeline(f, res);

					core.info(`✅ ${nm[1]} found in cache, referencing ${url}`)
					return;
				} catch (e) {

					core.info(`❌ ${nm[1]} not found in cache `)
					res.writeHead(404).end();
					return
				}
			} else if (req.method == 'PUT') {
				const b = await body(req);
				const info = parseNarInfo(b);
				if (!info["URL"]) {
					core.error(`${nm[1]} should have an URL: ${b}`)
					res.writeHead(400).end();
					return
				}
				const url = info["URL"][0];
				const h = nixBase32(await hash("sha256", `./${url}`));
				if (info["FileHash"][0] != `sha256:${h}`) {
					core.warning(`expected ${info["FileHash"][0]}, got sha256:${h}`)
				}
				await mkdir(`./${nm[1]}`, { recursive: true });
				await writeFile(`./${nm[1]}/narinfo`, b)
				await mkdir(`./${nm[1]}/nar`, { recursive: true })
				await rename(`./${url}`, `./${nm[1]}/${url}`)
				await chc.saveCache([`./${nm[1]}`], PREFIX + nm[1]);
				core.debug(`narinfo ${nm[1]} added to cache, referencing ${url}`);
				res.writeHead(204, {})
				res.end()
				core.info(`💾 added cache ${nm[1]}`)
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
				await pipeline(req, f.createWriteStream(), { end: false });
				await f.close();
				const h = await hash("sha256", `./${nam[1]}`);
				core.debug(`${nam[1]} added to files ( hash sha256:${nixBase32(h)})`);
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
