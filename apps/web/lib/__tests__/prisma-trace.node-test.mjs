import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
	new URL("../../next.config.ts", import.meta.url),
	"utf8",
);
const providers = runInNewContext(
	source.match(/const PRISMA_UNUSED_DB_PROVIDERS = ([\s\S]*?) as const;/)[1],
);
const expression = source
	.slice(source.indexOf('"/*": PRISMA_UNUSED_DB_PROVIDERS') + '"/*": '.length)
	.split("\n\t},")[0]
	.trim()
	.replace(/,$/, "");
const globs = runInNewContext(`(${expression})`, {
	PRISMA_UNUSED_DB_PROVIDERS: providers,
});
const traced = (file) =>
	`../../node_modules/.pnpm/@prisma+client@7.10.1/node_modules/@prisma/client/runtime/${file}`;

test("Prisma tracing excludes both Prisma 7 compiler builds for unused providers", () => {
	for (const provider of providers) {
		for (const build of ["fast", "small"]) {
			for (const extension of [
				"js",
				"mjs",
				"wasm-base64.js",
				"wasm-base64.mjs",
			]) {
				const file = `query_compiler_${build}_bg.${provider}.${extension}`;
				assert.ok(
					globs.some((glob) => matchesGlob(traced(file), glob)),
					file,
				);
			}
		}
	}
});

test("Prisma tracing keeps the PostgreSQL compilers and client runtime", () => {
	for (const file of [
		"client.js",
		"client.mjs",
		"query_compiler_fast_bg.postgresql.js",
		"query_compiler_small_bg.postgresql.wasm-base64.mjs",
	]) {
		assert.equal(
			globs.some((glob) => matchesGlob(traced(file), glob)),
			false,
			file,
		);
	}
});
