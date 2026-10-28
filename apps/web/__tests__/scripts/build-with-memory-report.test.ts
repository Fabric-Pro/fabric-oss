/**
 * The build wrapper must be invisible except for its report line.
 *
 * It sits in front of `next build` on every deploy, so the property that matters
 * is exit-code fidelity: swallowing a non-zero status would turn a failed build
 * into a green deployment, which is a worse failure than the OOM it exists to
 * measure. Asserted by running the real script against stand-in children rather
 * than by mocking `spawn`, since a mock of the thing under test would prove
 * nothing about how it actually behaves.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../scripts/build-with-memory-report.mjs");
const GIB = 1024 ** 3;

function run(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [SCRIPT, ...args], {
			// Sample fast so the report still fires for very short-lived children.
			env: { ...process.env, BUILD_MEMORY_SAMPLE_MS: "25", ...env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += String(c);
		});
		child.stderr.on("data", (c) => {
			stderr += String(c);
		});
		child.on("exit", (code) => done({ code, stdout, stderr }));
	});
}

const sleepThen = (body: string) => [
	"--",
	process.execPath,
	"-e",
	`setTimeout(() => { ${body} }, 90)`,
];

/** A cgroup-v2 directory with fixed readings, standing in for /sys/fs/cgroup. */
function fixtureCgroup(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "build-memory-cgroup-"));
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(root, name), content);
	}
	return root;
}

describe("build-with-memory-report", () => {
	it("passes a successful build through as 0", async () => {
		const { code } = await run(sleepThen(""));

		expect(code).toBe(0);
	});

	it("preserves the child's non-zero exit code", async () => {
		// The load-bearing case: a failed build must stay failed.
		const { code } = await run(sleepThen("process.exit(3)"));

		expect(code).toBe(3);
	});

	it("reports peak memory and names the gauge it used", async () => {
		const { stdout } = await run(sleepThen(""));

		expect(stdout).toMatch(
			/\[build-memory] peak [\d.]+ GB of [\d.]+ GB \(\d+%\) via (cgroup-v2|cgroup-v1|host)/,
		);
	});

	it("separates the working set from reclaimable page cache", async () => {
		// 12 GiB used, 4 GiB of it inactive file cache: the build is at 75% by
		// usage but only 50% by what the kernel cannot reclaim.
		const root = fixtureCgroup({
			"memory.current": String(12 * GIB),
			"memory.max": String(16 * GIB),
			"memory.stat": `anon ${7 * GIB}\nfile ${5 * GIB}\ninactive_file ${4 * GIB}\n`,
			"memory.events": "low 0\nhigh 0\nmax 3\noom 0\noom_kill 0\n",
		});

		const { stdout } = await run(sleepThen(""), {
			BUILD_MEMORY_CGROUP_ROOT: root,
		});

		expect(stdout).toContain(
			"[build-memory] peak 12.00 GB of 16.00 GB (75%) via cgroup-v2",
		);
		expect(stdout).toContain(
			"[build-memory] working-set peak 8.00 GB of 16.00 GB (50%)",
		);
		expect(stdout).toContain(
			"[build-memory] cgroup events: limit reached 3 times, oom_kill 0",
		);
	});

	it("omits the working set when the cgroup has no stat file", async () => {
		const root = fixtureCgroup({
			"memory.current": String(12 * GIB),
			"memory.max": String(16 * GIB),
		});

		const { stdout } = await run(sleepThen(""), {
			BUILD_MEMORY_CGROUP_ROOT: root,
		});

		expect(stdout).toContain("via cgroup-v2");
		expect(stdout).not.toContain("working-set peak");
		expect(stdout).not.toContain("cgroup events");
	});

	it("refuses to run with no command instead of exiting 0", async () => {
		// Exiting 0 here would silently skip the build entirely.
		const { code, stderr } = await run([]);

		expect(code).toBe(2);
		expect(stderr).toContain("expected a command");
	});

	it("fails when the build binary cannot be started", async () => {
		const { code, stderr } = await run([
			"--",
			"definitely-not-a-real-binary-xyz",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("failed to start build");
	});

	it("does not touch the child's stdout", async () => {
		const { stdout } = await run([
			"--",
			process.execPath,
			"-e",
			"console.log('BUILD OUTPUT MARKER')",
		]);

		expect(stdout).toContain("BUILD OUTPUT MARKER");
	});
});
