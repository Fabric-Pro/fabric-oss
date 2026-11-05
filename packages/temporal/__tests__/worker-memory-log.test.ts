import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";

const { readFileSync } = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock("node:fs", () => ({ readFileSync }));

import { startWorkerMemoryLog } from "../src/lib/worker-memory-log";

const MIB = 1024 * 1024;

const CGROUP_FILES: Record<string, string> = {
	"/sys/fs/cgroup/memory.current": `${3400 * MIB}\n`,
	"/sys/fs/cgroup/memory.max": `${3584 * MIB}\n`,
	"/sys/fs/cgroup/memory.events":
		"low 0\nhigh 0\nmax 12\noom 1\noom_kill 1\noom_group_kill 0\n",
};

function useCgroupFiles(files: Record<string, string>) {
	readFileSync.mockImplementation((path: string) => {
		const content = files[path];
		if (content === undefined) {
			throw new Error(`ENOENT: ${path}`);
		}
		return content;
	});
}

describe("startWorkerMemoryLog", () => {
	let rssMiB: number;
	let log: MockInstance<typeof console.log>;

	const loggedLines = () =>
		log.mock.calls.map(([line]) =>
			JSON.parse(String(line).replace("[Worker] memory ", "")),
		);

	beforeEach(() => {
		vi.useFakeTimers();
		rssMiB = 3000;
		useCgroupFiles(CGROUP_FILES);
		vi.spyOn(process, "memoryUsage").mockImplementation(() => ({
			rss: rssMiB * MIB,
			heapUsed: 1500 * MIB,
			heapTotal: 2000 * MIB,
			external: 100 * MIB,
			arrayBuffers: 50 * MIB,
		}));
		log = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("writes one parseable line at boot with process and cgroup memory", () => {
		startWorkerMemoryLog();

		expect(log).toHaveBeenCalledTimes(1);
		expect(String(log.mock.calls[0]?.[0])).not.toContain("\n");
		expect(loggedLines()[0]).toEqual({
			rssMiB: 3000,
			heapUsedMiB: 1500,
			heapTotalMiB: 2000,
			externalMiB: 100,
			arrayBuffersMiB: 50,
			cgroupCurrentMiB: 3400,
			cgroupMaxMiB: 3584,
			limitHits: 12,
			oomKills: 1,
		});
	});

	it("reports an unlimited container's limit as null", () => {
		useCgroupFiles({
			...CGROUP_FILES,
			"/sys/fs/cgroup/memory.max": "max\n",
		});

		startWorkerMemoryLog();

		expect(loggedLines()[0].cgroupMaxMiB).toBeNull();
		expect(loggedLines()[0].cgroupCurrentMiB).toBe(3400);
	});

	it("still logs process memory on a host without cgroup v2", () => {
		useCgroupFiles({});

		startWorkerMemoryLog();

		expect(loggedLines()[0]).toMatchObject({
			rssMiB: 3000,
			cgroupCurrentMiB: null,
			cgroupMaxMiB: null,
			limitHits: null,
			oomKills: null,
		});
	});

	it("logs again once a minute while memory is steady", () => {
		startWorkerMemoryLog();

		vi.advanceTimersByTime(50_000);
		expect(log).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(10_000);
		expect(log).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(60_000);
		expect(log).toHaveBeenCalledTimes(3);
	});

	it("logs inside the minute when RSS rises by 100 MiB", () => {
		startWorkerMemoryLog();

		rssMiB = 3099;
		vi.advanceTimersByTime(10_000);
		expect(log).toHaveBeenCalledTimes(1);

		rssMiB = 3100;
		vi.advanceTimersByTime(10_000);
		expect(log).toHaveBeenCalledTimes(2);
		expect(loggedLines()[1].rssMiB).toBe(3100);

		// The next rise is measured from the line just written.
		rssMiB = 3150;
		vi.advanceTimersByTime(10_000);
		expect(log).toHaveBeenCalledTimes(2);
	});

	it("does not log inside the minute when RSS falls", () => {
		startWorkerMemoryLog();

		rssMiB = 2000;
		vi.advanceTimersByTime(50_000);

		expect(log).toHaveBeenCalledTimes(1);
	});

	it("survives a failed sample and keeps logging", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		startWorkerMemoryLog();
		vi.mocked(process.memoryUsage).mockImplementationOnce(() => {
			throw new Error("EMFILE");
		});

		expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
		expect(warn).toHaveBeenCalledWith(
			"[Worker] Failed to sample memory:",
			"EMFILE",
		);

		vi.advanceTimersByTime(50_000);
		expect(log).toHaveBeenCalledTimes(2);
	});
});
