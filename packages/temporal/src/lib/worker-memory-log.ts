import { readFileSync } from "node:fs";

const MIB = 1024 * 1024;
const SAMPLE_INTERVAL_MS = 10_000;
const LOG_INTERVAL_MS = 60_000;
const RSS_RISE_LOG_BYTES = 100 * MIB;

function readCgroupFile(name: string): string | null {
	try {
		return readFileSync(`/sys/fs/cgroup/${name}`, "utf8");
	} catch {
		return null;
	}
}

function cgroupMiB(name: string): number | null {
	// memory.max reads "max" when the container has no limit.
	const bytes = Number.parseInt(readCgroupFile(name) ?? "", 10);
	return Number.isNaN(bytes) ? null : Math.round(bytes / MIB);
}

function eventCount(events: string | null, name: string): number | null {
	const match = events?.match(new RegExp(`^${name} (\\d+)$`, "m"));
	return match ? Number(match[1]) : null;
}

function logMemory(usage: NodeJS.MemoryUsage): void {
	const events = readCgroupFile("memory.events");
	const line = {
		rssMiB: Math.round(usage.rss / MIB),
		heapUsedMiB: Math.round(usage.heapUsed / MIB),
		heapTotalMiB: Math.round(usage.heapTotal / MIB),
		externalMiB: Math.round(usage.external / MIB),
		arrayBuffersMiB: Math.round(usage.arrayBuffers / MIB),
		cgroupCurrentMiB: cgroupMiB("memory.current"),
		cgroupMaxMiB: cgroupMiB("memory.max"),
		limitHits: eventCount(events, "max"),
		oomKills: eventCount(events, "oom_kill"),
	};
	console.log(`[Worker] memory ${JSON.stringify(line)}`);
}

/**
 * Log this process's memory once a minute, and at once when RSS has risen by
 * 100 MiB since the last line.
 *
 * A worker killed at its container limit logs nothing, and Azure records no
 * exit code for a restart, so the last line here is the only record of how
 * close it came. The rise rule exists because a spike can end the process well
 * inside the minute. The heap figures cover the main thread only: RSS above
 * them is native memory and the workflow threads' heaps together. The cgroup
 * fields are null on a host without cgroup v2.
 */
export function startWorkerMemoryLog(): void {
	let lastLoggedAt = Date.now();
	let lastLoggedRss = 0;

	const sample = (force: boolean) => {
		// An uncaught throw from a timer exits this process, and a diagnostic
		// must not be what kills the worker it is watching.
		try {
			const usage = process.memoryUsage();
			const due = Date.now() - lastLoggedAt >= LOG_INTERVAL_MS;
			if (
				force ||
				due ||
				usage.rss - lastLoggedRss >= RSS_RISE_LOG_BYTES
			) {
				logMemory(usage);
				lastLoggedAt = Date.now();
				lastLoggedRss = usage.rss;
			}
		} catch (error) {
			console.warn(
				"[Worker] Failed to sample memory:",
				error instanceof Error ? error.message : error,
			);
		}
	};

	sample(true);
	setInterval(() => sample(false), SAMPLE_INTERVAL_MS).unref();
}
