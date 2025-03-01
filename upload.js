#!/usr/bin/env node
import { request } from "node:http"

const main = () => {
	const paths = process.env["OUT_PATHS"]
	return new Promise((resolve, reject) => {
		const req = request("http://localhost:18008/upload", { method: "POST" }, (res) => {
			res.on("end", resolve)
			res.on("error", reject)
		})
		req.write(paths)
		req.end()
	})
}
await main()
