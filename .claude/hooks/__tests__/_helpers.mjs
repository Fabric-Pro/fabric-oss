import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = resolve(HERE, "..");

/**
 * @typedef {Object} RunHookResult
 * @property {number|null} exitCode
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Spawns a hook script as a real child process and pipes the given
 * tool-input JSON to its stdin. Exercises the full stdin→exit path so
 * tests catch wiring bugs the way Claude Code would hit them.
 *
 * @param {string} hookFile      relative to `.claude/hooks/` (e.g. `block-destructive-bash.mjs`).
 * @param {{tool_name?: string, tool_input: Record<string, unknown>}} payload
 * @param {{env?: Record<string, string|undefined>}} [opts]
 * @returns {Promise<RunHookResult>}
 */
export function runHook(hookFile, payload, opts = {}) {
	const scriptPath = resolve(HOOKS_DIR, hookFile);
	const envOverride = opts.env ?? {};
	const env = { ...process.env };
	for (const [key, value] of Object.entries(envOverride)) {
		if (value === undefined) {
			delete env[key];
		} else {
			env[key] = value;
		}
	}

	const fullPayload = {
		session_id: "test-session",
		tool_name: payload.tool_name ?? "Bash",
		tool_input: payload.tool_input,
		// Forwarded only when a test sets it, so payloads without a cwd still
		// exercise the "Claude Code sent no cwd" path.
		...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
	};

	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, [scriptPath], {
			stdio: ["pipe", "pipe", "pipe"],
			env,
			// The hook process's OWN cwd, distinct from the payload `cwd` above.
			// Tests that assert "the guard read the payload's tree" must pin this
			// to a clean directory, or a dirty test repo makes the guard block for
			// the wrong reason and the assertion passes against unfixed code.
			...(opts.spawnCwd === undefined ? {} : { cwd: opts.spawnCwd }),
		});

		const stdoutChunks = [];
		const stderrChunks = [];
		child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
		child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
		child.on("error", rejectPromise);
		child.on("close", (exitCode) => {
			resolvePromise({
				exitCode,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
			});
		});

		child.stdin.write(JSON.stringify(fullPayload));
		child.stdin.end();
	});
}
