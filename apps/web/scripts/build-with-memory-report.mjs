/**
 * Runs the real build and reports the container's peak memory use.
 *
 * Why this exists: `@repo/web#build` is OOM-killed (exit 137) on Vercel roughly
 * half the time, and nobody knows how close a HEALTHY build sits to the limit —
 * the platform only reports memory when a build already died. Without a baseline,
 * "make the build smaller" is guesswork, and so is judging whether a heap-ceiling
 * change helped.
 *
 * Vercel's own `VERCEL_BUILD_SYSTEM_REPORT=1` would do this, but it has to be set
 * as a project environment variable, which lives outside the repository. This
 * measures the same thing from inside, so every build on every environment
 * reports it and the number is reviewable in version control.
 *
 * Deliberately boring: it spawns the real build with inherited stdio, samples the
 * OS memory gauge on a timer, and exits with the child's exact status. It cannot
 * change what the build produces. The one thing it must get right is exit-code
 * propagation, since swallowing a non-zero status would turn a failed build into
 * a green deploy — that is covered by a test.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

const SAMPLE_MS = Number(process.env.BUILD_MEMORY_SAMPLE_MS ?? 2000);
const GB = 1024 ** 3;
const asGb = (bytes) => (bytes / GB).toFixed(2);

/** Child argv comes after `--`, so the caller owns the real command. */
const separator = process.argv.indexOf("--");
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (command.length === 0) {
	console.error(
		"build-with-memory-report: expected a command after `--`, e.g. `node build-with-memory-report.mjs -- next build`",
	);
	process.exit(2);
}

/**
 * Read the CONTAINER's memory, not the host's.
 *
 * `os.freemem()` reads /proc/meminfo, which inside most container runtimes reports
 * the host machine — so on a build container it would measure whatever else the
 * host is doing and miss the limit that actually kills the build. The cgroup files
 * are the number the OOM killer works from. Tried in cgroup v2 then v1 order, with
 * the host gauge only as a last resort, and the report says which source it used
 * so nobody has to guess whether the figure means anything.
 */
function readGauge() {
	const cgroups = [
		{
			used: "/sys/fs/cgroup/memory.current",
			limit: "/sys/fs/cgroup/memory.max",
			source: "cgroup-v2",
		},
		{
			used: "/sys/fs/cgroup/memory/memory.usage_in_bytes",
			limit: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
			source: "cgroup-v1",
		},
	];
	for (const { used, limit, source } of cgroups) {
		try {
			const usedBytes = Number.parseInt(
				readFileSync(used, "utf8").trim(),
				10,
			);
			if (!Number.isFinite(usedBytes)) {
				continue;
			}
			const raw = readFileSync(limit, "utf8").trim();
			// cgroup v2 writes "max" for unlimited; v1 writes a sentinel near 2^63.
			const limitBytes = raw === "max" ? null : Number.parseInt(raw, 10);
			const bounded =
				limitBytes !== null &&
				Number.isFinite(limitBytes) &&
				limitBytes < 2 ** 53
					? limitBytes
					: null;
			return { used: usedBytes, total: bounded ?? os.totalmem(), source };
		} catch {
			// Not this cgroup version, or not readable — try the next.
		}
	}
	return {
		used: os.totalmem() - os.freemem(),
		total: os.totalmem(),
		source: "host",
	};
}

let peakUsed = 0;
let total = os.totalmem();
let source = "host";
let samples = 0;
/** Every sample, so the SHAPE is visible and not just the peak. */
const series = [];

const sampler = setInterval(() => {
	// Sampled rather than heap-introspected: Turbopack's native allocations sit
	// outside the V8 heap, and those are exactly what `--max-old-space-size` does
	// not bound. Heap-only numbers would miss the memory that gets builds killed.
	const gauge = readGauge();
	total = gauge.total;
	source = gauge.source;
	if (gauge.used > peakUsed) {
		peakUsed = gauge.used;
	}
	series.push(gauge.used);
	samples += 1;
}, SAMPLE_MS);
sampler.unref();

const child = spawn(command[0], command.slice(1), {
	stdio: "inherit",
	shell: false,
});

function report() {
	clearInterval(sampler);
	if (samples === 0) {
		return;
	}
	// Leak test: a build that RECLAIMS memory plateaus or sawtooths and peaks in the
	// middle. A build that leaks climbs monotonically and peaks at the very end,
	// because nothing is ever released. The peak alone cannot tell those apart, so
	// report where the peak sat and whether the tail was still rising.
	if (series.length >= 8) {
		const peakAt = series.indexOf(Math.max(...series));
		const peakPosition = ((peakAt / (series.length - 1)) * 100).toFixed(0);
		const quarter = Math.max(2, Math.floor(series.length / 4));
		const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
		const thirdQuarter = mean(series.slice(-2 * quarter, -quarter));
		const lastQuarter = mean(series.slice(-quarter));
		const tailDelta = ((lastQuarter - thirdQuarter) / GB).toFixed(2);
		const shape = series
			.filter(
				(_, i) => i % Math.max(1, Math.floor(series.length / 12)) === 0,
			)
			.map((b) => (b / GB).toFixed(1))
			.join(" ");
		console.log(`[build-memory] shape (GB, ~12 points): ${shape}`);
		console.log(
			`[build-memory] peak at ${peakPosition}% through the run; last-quarter mean ${tailDelta >= 0 ? "+" : ""}${tailDelta} GB vs third quarter`,
		);
	}

	const pct = ((peakUsed / total) * 100).toFixed(0);
	const caveat =
		source === "host"
			? " — HOST gauge, includes everything else on the machine; treat as indicative only"
			: "";
	console.log(
		`[build-memory] peak ${asGb(peakUsed)} GB of ${asGb(total)} GB (${pct}%) via ${source} across ${samples} samples${caveat}`,
	);
}

child.on("error", (err) => {
	report();
	console.error(
		`build-with-memory-report: failed to start build — ${err.message}`,
	);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	report();
	if (signal) {
		// A signal death is the OOM case: report it plainly rather than as a
		// generic failure, and reproduce the shell's 128+n convention so callers
		// see the same status they would without this wrapper.
		console.error(
			`build-with-memory-report: build terminated by ${signal}`,
		);
		process.exit(128 + (os.constants.signals[signal] ?? 0));
	}
	process.exit(code ?? 1);
});
