#!/usr/bin/env node
import { request } from "node:http"

const main = () => {
	const paths = process.env["OUT_PATHS"]
	return new Promise((resolve, reject) => {
		try {
			const req = request("http://localhost:18008/upload", { method: "POST" }, (res) => {
				res.on("error", reject)
			})
			req.on("error", reject)
			req.on("close", resolve)
			req.write(paths)
			req.end()
		} catch (e) {
			reject(e)
		}
	})
}
try {
	await main()
} catch (e) {
	console.debug(e)
}
