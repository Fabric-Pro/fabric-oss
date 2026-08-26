/**
 * The function-size report runs at the tail of `pnpm build`, so the property
 * that matters is that it cannot break a deploy. It is advisory — it exists to
 * make the 250 MB Vercel function limit visible before a deploy hits it (issue
 * #2131) — and an advisory script that throws on a malformed trace file, or
 * exits non-zero when a function is fat, would be a worse outage than the one
 * it warns about.
 *
 * Run against real trace fixtures on disk rather than mocked `fs`, since the
 * thing under test is precisely how it reads Next's output.
 */

import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../scripts/report-function-sizes.mjs");

const workspaces: string[] = [];

afterEach(() => {
	for (const dir of workspaces.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Build a throwaway copy of the script's expected layout: the script resolves
 * `.next/server` relative to its own directory, so the fixture mirrors
 * `<root>/scripts/` + `<root>/.next/server/`.
 */
function makeWorkspace(): { scriptsDir: string; serverDir: string } {
	const root = mkdtempSync(join(tmpdir(), "fn-size-"));
	workspaces.push(root);
	const scriptsDir = join(root, "scripts");
	const serverDir = join(root, ".next", "server");
	mkdirSync(scriptsDir, { recursive: true });
	mkdirSync(serverDir, { recursive: true });
	return { scriptsDir, serverDir };
}

/** Write a trace naming `payloadBytes` worth of real files next to it. */
function writeTrace(serverDir: string, name: string, payloadBytes: number) {
	const routeDir = join(serverDir, name);
	mkdirSync(routeDir, { recursive: true });
	const blob = join(routeDir, "blob.bin");
	writeFileSync(blob, Buffer.alloc(payloadBytes, 0));
	writeFileSync(
		join(routeDir, "route.js.nft.json"),
		JSON.stringify({ version: 1, files: ["blob.bin"] }),
	);
}

/** Preload that removes fs.globSync, standing in for a Node that lacks it. */
const WITHOUT_GLOB_SYNC =
	'data:text/javascript,import fs from "node:fs"; delete fs.globSync;';

function run(
	scriptsDir: string,
	env: Record<string, string> = {},
	nodeArgs: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	// Copy the real script into the fixture so its `import.meta.dirname`-based
	// resolution points at the fixture's .next, exactly as it does in the app.
	const copied = join(scriptsDir, "report-function-sizes.mjs");
	writeFileSync(copied, readFileSync(SCRIPT));
	return new Promise((done) => {
		const child = spawn(process.execPath, [...nodeArgs, copied], {
			env: { ...process.env, ...env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += String(c);
		});
		child.stderr.on("data", (c) => {
			stderr += String(c);
		});
		// `close`, not `exit`: exit can fire before the pipes are drained, which
		// would make the stdout assertions below flaky rather than wrong.
		child.on("close", (code) => done({ code, stdout, stderr }));
	});
}

const MB = 1024 * 1024;

describe("report-function-sizes", () => {
	it("reports the largest route and its headroom", async () => {
		const { scriptsDir, serverDir } = makeWorkspace();
		writeTrace(serverDir, "small", 1 * MB);
		writeTrace(serverDir, "large", 4 * MB);

		const { code, stdout } = await run(scriptsDir, {
			FUNCTION_TRACE_BUDGET_MB: "10",
		});

		expect(code).toBe(0);
		expect(stdout).toContain("2 traced routes");
		expect(stdout).toMatch(
			/Largest: 4\.0 MB \(40% of budget, 6\.0 MB headroom\)/,
		);
		expect(stdout).toContain("large/route.js");
	});

	it("warns over budget but still exits 0", async () => {
		// The load-bearing case: a fat function must not fail the build here —
		// the platform is the thing that enforces the real limit.
		const { scriptsDir, serverDir } = makeWorkspace();
		writeTrace(serverDir, "fat", 8 * MB);

		const { code, stderr } = await run(scriptsDir, {
			FUNCTION_TRACE_BUDGET_MB: "4",
		});

		expect(code).toBe(0);
		expect(stderr).toContain("WARNING");
		expect(stderr).toContain("over the 4 MB budget");
	});

	it("exits 0 when there are no traces to measure", async () => {
		const { scriptsDir } = makeWorkspace();

		const { code, stdout } = await run(scriptsDir);

		expect(code).toBe(0);
		expect(stdout).toContain("nothing to measure");
	});

	it("skips a malformed trace file instead of crashing", async () => {
		const { scriptsDir, serverDir } = makeWorkspace();
		writeTrace(serverDir, "ok", 2 * MB);
		const brokenDir = join(serverDir, "broken");
		mkdirSync(brokenDir, { recursive: true });
		writeFileSync(join(brokenDir, "route.js.nft.json"), "{not json");

		const { code, stdout } = await run(scriptsDir, {
			FUNCTION_TRACE_BUDGET_MB: "10",
		});

		expect(code).toBe(0);
		expect(stdout).toContain("ok/route.js");
	});

	it("exits 0 when EVERY trace is malformed", async () => {
		// The earlier case always left one good trace behind, which hid the
		// no-usable-routes path entirely.
		const { scriptsDir, serverDir } = makeWorkspace();
		for (const name of ["a", "b"]) {
			const dir = join(serverDir, name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "route.js.nft.json"), "{not json");
		}

		const { code, stdout } = await run(scriptsDir);

		expect(code).toBe(0);
		expect(stdout).toContain("nothing to measure");
	});

	it("exits 0 on a trace whose `files` is missing or not an array", async () => {
		// `{"version":1}` is valid JSON and parses fine — it just isn't a trace.
		const { scriptsDir, serverDir } = makeWorkspace();
		for (const [name, body] of [
			["missing", JSON.stringify({ version: 1 })],
			["wrong-type", JSON.stringify({ version: 1, files: "blob.bin" })],
		]) {
			const dir = join(serverDir, name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "route.js.nft.json"), body);
		}

		const { code, stdout } = await run(scriptsDir);

		expect(code).toBe(0);
		expect(stdout).toContain("nothing to measure");
	});

	it("notices before the budget is blown, not just after", async () => {
		const { scriptsDir, serverDir } = makeWorkspace();
		writeTrace(serverDir, "close", 9 * MB);

		const { code, stdout, stderr } = await run(scriptsDir, {
			FUNCTION_TRACE_BUDGET_MB: "10",
		});

		expect(code).toBe(0);
		expect(stdout).toContain("NOTICE");
		expect(stdout).toContain("90% of the 10 MB budget");
		expect(stderr).not.toContain("WARNING");
	});

	it("exits 0 on a Node without fs.globSync", async () => {
		// A NAMED import of a builtin export the runtime lacks is a link-time
		// SyntaxError — it fires before the module body, so the script's own
		// try/catch cannot contain it and `pnpm build` dies on an advisory
		// report. The namespace import plus this guard is what prevents that.
		const { scriptsDir, serverDir } = makeWorkspace();
		writeTrace(serverDir, "ok", 2 * MB);

		const { code, stdout, stderr } = await run(scriptsDir, {}, [
			"--import",
			WITHOUT_GLOB_SYNC,
		]);

		expect(code).toBe(0);
		expect(stderr).not.toContain("SyntaxError");
		expect(stdout).toContain("fs.globSync unavailable");
	});

	it("counts a file named twice in one trace only once", async () => {
		const { scriptsDir, serverDir } = makeWorkspace();
		const routeDir = join(serverDir, "dupe");
		mkdirSync(routeDir, { recursive: true });
		writeFileSync(join(routeDir, "blob.bin"), Buffer.alloc(2 * MB, 0));
		writeFileSync(
			join(routeDir, "route.js.nft.json"),
			JSON.stringify({ version: 1, files: ["blob.bin", "./blob.bin"] }),
		);

		const { stdout } = await run(scriptsDir, {
			FUNCTION_TRACE_BUDGET_MB: "10",
		});

		expect(stdout).toMatch(/Largest: 2\.0 MB/);
	});
});
