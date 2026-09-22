/**
 * Load-time smoke test for the production bundle.
 *
 * `pnpm build` succeeding proves nothing about whether dist/index.js can be
 * imported: esbuild inlines CommonJS dependencies into the ESM bundle, and any
 * of them that calls require() at module-evaluation time throws
 * `Dynamic require of "..." is not supported` the moment the container starts
 * (Fizzy #2535: yaml via @repo/utils). Build into a throwaway directory and run
 * the same command the Dockerfile does so that failure lands here, not in a
 * crash-looping image.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
// Under dist/ so it is gitignored and `pnpm build` (clean: true) sweeps it.
const distDir = path.join(packageDir, "dist");
let outDir: string;

beforeAll(async () => {
	await mkdir(distDir, { recursive: true });
	outDir = mkdtempSync(path.join(distDir, "smoke-"));
	await build({
		// The real config supplies format, externals and the require() banner.
		config: path.join(packageDir, "tsup.config.ts"),
		// Absolute so the build does not depend on the runner's cwd.
		entry: ["src/index.ts", "src/telemetry.ts"].map((entry) =>
			path.join(packageDir, entry),
		),
		outDir,
		sourcemap: false,
		clean: false,
		silent: true,
	});
}, 120_000);

afterAll(() => {
	rmSync(outDir, { recursive: true, force: true });
});

type Outcome = { code: number | null; output: string };

/**
 * Resolves with the process's exit code, or with `null` once it printed `ready`.
 * Bounded by `timeoutMs` so a child that neither starts nor exits cannot leave
 * the test hanging (vitest's own timeout cannot cancel a pending await).
 */
function runUntilReady(child: ChildProcess, ready: string, timeoutMs: number) {
	return new Promise<Outcome>((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() =>
				reject(
					new Error(
						`No "${ready}" within ${timeoutMs}ms:\n${output}`,
					),
				),
			timeoutMs,
		);
		const settle = (fn: () => void) => {
			clearTimeout(timer);
			fn();
		};
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes(ready)) {
				settle(() => resolve({ code: null, output }));
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (error) => settle(() => reject(error)));
		child.on("exit", (code) => settle(() => resolve({ code, output })));
	});
}

/** SIGTERM, then SIGKILL if the child has not exited within `graceMs`; resolves on exit. */
function terminate(child: ChildProcess, graceMs: number) {
	return new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		const killer = setTimeout(() => child.kill("SIGKILL"), graceMs);
		child.once("exit", () => {
			clearTimeout(killer);
			resolve();
		});
		child.kill("SIGTERM");
	});
}

describe("dist bundle", () => {
	it("loads with the production start command", async () => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(path.join(outDir, "telemetry.js")).href,
				path.join(outDir, "index.js"),
			],
			{
				cwd: packageDir,
				// Ephemeral port: the server is torn down as soon as it is up.
				env: { ...process.env, PORT: "0" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		try {
			const result = await runUntilReady(
				child,
				"weave-readers starting on port",
				30_000,
			);
			expect(result.output).not.toContain("Dynamic require of");
			expect(result.code, result.output).toBeNull();
		} finally {
			// Reap the server before afterAll removes its directory.
			await terminate(child, 5_000);
		}
	}, 60_000);
});
