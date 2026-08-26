import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = resolve(HERE, "..");

const HOOK_SCRIPTS = [
	"block-destructive-bash.mjs",
	"block-claude-attribution.mjs",
	"block-prisma-db-push.mjs",
	"block-destructive-sql.mjs",
	"block-shared-env-sql-writes.mjs",
	"block-secret-paths.mjs",
	"enforce-branch-naming.mjs",
	"pr-quality-gate.mjs",
];

/**
 * @param {string} hookFile
 * @param {string} stdinPayload
 */
function runRaw(hookFile, stdinPayload) {
	const scriptPath = resolve(HOOKS_DIR, hookFile);
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, [scriptPath], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stderrChunks = [];
		child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
		child.on("error", rejectPromise);
		child.on("close", (exitCode) => {
			resolvePromise({
				exitCode,
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
			});
		});
		child.stdin.end(stdinPayload);
	});
}

describe("hooks fail open on malformed input", () => {
	for (const hook of HOOK_SCRIPTS) {
		it(`${hook}: exits 0 on garbage JSON`, async () => {
			const { exitCode } = await runRaw(hook, "this is not json");
			assert.equal(
				exitCode,
				0,
				`${hook} returned ${exitCode}; a broken hook must never lock devs out`,
			);
		});

		it(`${hook}: exits 0 on empty stdin`, async () => {
			const { exitCode } = await runRaw(hook, "");
			assert.equal(
				exitCode,
				0,
				`${hook} returned ${exitCode} on empty stdin`,
			);
		});
	}
});
