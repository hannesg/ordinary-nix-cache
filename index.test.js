import { expect, test, describe, mock } from "bun:test";
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nixBase32 } from ".";

describe("nixBase32", () => {
	const cases = [
		["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "1b8m03r63zqhnjf7l5wnldhh7c134ap5vpj0850ymkq1iyzicy5s"]
	]
	test.each(cases)("nixBase32(%p) == %p", (hex, result) => {
		expect(nixBase32(hex)).toBe(result)
	})
})
