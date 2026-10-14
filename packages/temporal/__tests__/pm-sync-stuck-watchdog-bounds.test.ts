/**
 * The stuck PM-sync watchdog's time bounds, in the worst case.
 *
 * A tick must not be held by a stalled Temporal: before, rows were processed
 * one at a time, each probe could take three 2-minute attempts, and whether a
 * row was overdue was decided once at scan time, so a full batch of stalled
 * probes could hold a tick (and, with overlap SKIP, every later tick) for
 * hours while overdue rows waited.
 *
 * The workflow body runs with stubbed activities on fake timers: every probe
 * stalls until its 20-second activity timeout and fails, as a hung describe
 * would. `Date.now()` is the fake clock, standing in for Temporal's workflow
 * clock (a real time-skipping test server was not used).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	findStuckPmSyncRowsActivity: vi.fn(),
	probeStuckPmSyncActivity: vi.fn(),
	retryStuckPmSyncActivity: vi.fn(),
	giveUpStuckPmSyncActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	proxyActivities: vi.fn(() => stubs),
}));

import { proxyActivities } from "@temporalio/workflow";
import { pmSyncStuckWatchdogWorkflow } from "../src/workflows/pm-sync-stuck-watchdog";

/** The options each `proxyActivities` call received when the module loaded. */
const proxyOptions = vi
	.mocked(proxyActivities)
	.mock.calls.map(([options]) => options as Record<string, unknown>);

const T0 = new Date("2026-05-28T12:00:00.000Z").getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** The probe activity's start-to-close timeout. */
const PROBE_TIMEOUT_MS = 20 * SECOND;
/** The schedule's interval: a run must end inside it. */
const INTERVAL_MS = 5 * MINUTE;

function row(id: string, giveUpAtMs: number, itemType = "story") {
	return {
		itemId: id,
		itemType,
		attemptId: `attempt-${id}`,
		pendingSinceMs: giveUpAtMs - 60 * MINUTE,
		giveUpAtMs,
	};
}

/** Runs one tick on the fake clock; resolves with its output and duration. */
async function runTick() {
	let settled = false;
	const run = pmSyncStuckWatchdogWorkflow().finally(() => {
		settled = true;
	});
	while (!settled) {
		await vi.advanceTimersByTimeAsync(SECOND);
	}
	return { out: await run, elapsedMs: Date.now() - T0 };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	for (const stub of Object.values(stubs)) {
		stub.mockReset();
	}
	stubs.probeStuckPmSyncActivity.mockImplementation(
		() =>
			new Promise((_resolve, reject) =>
				setTimeout(
					() => reject(new Error("activity StartToClose timeout")),
					PROBE_TIMEOUT_MS,
				),
			),
	);
	stubs.giveUpStuckPmSyncActivity.mockResolvedValue(true);
	stubs.retryStuckPmSyncActivity.mockResolvedValue({ enqueued: true });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("pmSyncStuckWatchdogWorkflow under stalled probes", () => {
	it("gives up every overdue row before any probe, and ends inside the interval with a full batch stalling", async () => {
		const overdue = Array.from({ length: 10 }, (_, i) =>
			row(`overdue-${i}`, T0 - MINUTE),
		);
		const waiting = Array.from({ length: 190 }, (_, i) =>
			row(`waiting-${i}`, T0 + 30 * MINUTE),
		);
		// Overdue rows last in the scan, behind every stalling probe.
		stubs.findStuckPmSyncRowsActivity.mockResolvedValue({
			rows: [...waiting, ...overdue],
		});

		const { out, elapsedMs } = await runTick();

		expect(out.failed).toBe(10);
		const firstProbe = Math.min(
			...stubs.probeStuckPmSyncActivity.mock.invocationCallOrder,
		);
		const lastGiveUp = Math.max(
			...stubs.giveUpStuckPmSyncActivity.mock.invocationCallOrder,
		);
		expect(lastGiveUp).toBeLessThan(firstProbe);
		// Bounded: the budget plus one in-flight probe, inside the interval,
		// so overlap SKIP never swallows the next tick.
		expect(elapsedMs).toBeLessThanOrEqual(3 * MINUTE + PROBE_TIMEOUT_MS);
		expect(elapsedMs).toBeLessThan(INTERVAL_MS);
		// What did not fit waits for the next tick.
		expect(out.deferred).toBeGreaterThan(0);
		expect(
			out.deferred + stubs.probeStuckPmSyncActivity.mock.calls.length,
		).toBe(190);
		// Probes run concurrently, not one after another.
		expect(
			stubs.probeStuckPmSyncActivity.mock.calls.length,
		).toBeGreaterThan((3 * MINUTE) / PROBE_TIMEOUT_MS);
		expect(stubs.retryStuckPmSyncActivity).not.toHaveBeenCalled();
	});

	it("gives up a row that becomes overdue during the tick instead of probing or retrying it", async () => {
		const stalling = Array.from({ length: 20 }, (_, i) =>
			row(`waiting-${i}`, T0 + 30 * MINUTE),
		);
		// Overdue 30 seconds into the tick; reached after the first round of
		// stalled probes.
		const soonOverdue = row("soon-overdue", T0 + 30 * SECOND);
		stubs.findStuckPmSyncRowsActivity.mockResolvedValue({
			rows: [...stalling, soonOverdue],
		});

		const { out } = await runTick();

		expect(stubs.giveUpStuckPmSyncActivity).toHaveBeenCalledWith({
			itemId: "soon-overdue",
			itemType: "story",
			attemptId: "attempt-soon-overdue",
		});
		expect(out.failed).toBe(1);
		expect(
			stubs.probeStuckPmSyncActivity.mock.calls.map(
				(call) => (call[0] as { itemId: string }).itemId,
			),
		).not.toContain("soon-overdue");
	});

	it("gives up instead of retrying when the bound passes while the row's probe runs", async () => {
		stubs.findStuckPmSyncRowsActivity.mockResolvedValue({
			rows: [row("edge", T0 + 10 * SECOND)],
		});
		// The describe answers "not found" only after the bound has passed.
		stubs.probeStuckPmSyncActivity.mockImplementation(
			() =>
				new Promise((resolve) =>
					setTimeout(() => resolve("not-found"), 15 * SECOND),
				),
		);

		const { out } = await runTick();

		expect(out.failed).toBe(1);
		expect(stubs.retryStuckPmSyncActivity).not.toHaveBeenCalled();
	});
});

/** Parses the "N seconds" durations the workflow uses, in milliseconds. */
function seconds(value: unknown): number {
	const match = /^(\d+) seconds$/.exec(String(value));
	if (!match) {
		throw new Error(`unexpected duration ${String(value)}`);
	}
	return Number(match[1]) * SECOND;
}

describe("pmSyncStuckWatchdogWorkflow activity timeouts", () => {
	it("bounds every activity from scheduling, including time queued for a worker", () => {
		expect(proxyOptions.length).toBeGreaterThan(0);
		for (const options of proxyOptions) {
			expect(options.scheduleToCloseTimeout).toBeDefined();
			expect(
				seconds(options.scheduleToCloseTimeout),
			).toBeGreaterThanOrEqual(seconds(options.startToCloseTimeout));
		}
	});

	it("keeps budget plus the longest single row inside the schedule interval", () => {
		const bounds = proxyOptions.map((options) =>
			seconds(options.scheduleToCloseTimeout),
		);
		// A row is at most two activities in sequence (a probe, then a retry
		// or a give-up); the two longest bounds cover every such pair.
		const [longest, second] = [...bounds].sort((a, b) => b - a);
		expect(3 * MINUTE + longest + (second ?? 0)).toBeLessThan(INTERVAL_MS);
	});
});
