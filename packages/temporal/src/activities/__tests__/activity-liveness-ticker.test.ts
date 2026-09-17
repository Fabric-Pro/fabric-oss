/**
 * `withHeartbeatTicker`.
 *
 * The workflow-builder proxies declare a heartbeat timeout, and the nodes they
 * run are single long silent calls. The ticker is what makes the declaration
 * true; these pin the three things it has to do — tick while the work runs,
 * stop the moment it settles (however it settles), and stay out of the way
 * when there is no activity to report to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { heartbeatMock, currentMock } = vi.hoisted(() => ({
	heartbeatMock: vi.fn(),
	currentMock: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: heartbeatMock,
	Context: { current: currentMock },
}));

import {
	HEARTBEAT_TICK_MS,
	inActivityContext,
	withHeartbeatTicker,
} from "../lib/activity-liveness";

function insideActivity() {
	currentMock.mockReturnValue({
		cancellationSignal: new AbortController().signal,
	});
}

function outsideActivity() {
	currentMock.mockImplementation(() => {
		throw new Error("Activity context not initialized");
	});
}

/** A promise the test resolves by hand, so the work is "running" as long as it needs. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("inside an activity", () => {
	beforeEach(insideActivity);

	it("heartbeats once up front and then on every interval while the work runs", async () => {
		const work = deferred<string>();
		const run = withHeartbeatTicker(() => work.promise);

		// The immediate check-in: a node that fails fast still leaves one behind.
		expect(heartbeatMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS * 3);
		expect(heartbeatMock).toHaveBeenCalledTimes(4);

		work.resolve("done");
		await expect(run).resolves.toBe("done");
	});

	it("passes the details through on every tick", async () => {
		const work = deferred<void>();
		const details = { phase: "executing-node", nodeId: "n1" };
		const run = withHeartbeatTicker(() => work.promise, { details });

		await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS);
		for (const call of heartbeatMock.mock.calls) {
			expect(call[0]).toEqual(details);
		}

		work.resolve();
		await run;
	});

	it("stops ticking once the work resolves", async () => {
		const work = deferred<void>();
		const run = withHeartbeatTicker(() => work.promise, {
			intervalMs: 100,
		});

		await vi.advanceTimersByTimeAsync(250);
		work.resolve();
		await run;
		const atSettle = heartbeatMock.mock.calls.length;

		await vi.advanceTimersByTimeAsync(1_000);
		expect(heartbeatMock).toHaveBeenCalledTimes(atSettle);
	});

	it("stops ticking when the work throws, and rethrows untouched", async () => {
		const work = deferred<void>();
		const boom = new Error("step failed");
		const run = withHeartbeatTicker(() => work.promise, {
			intervalMs: 100,
		});
		// Attach the rejection handler before rejecting so the fake-timer
		// advance does not surface it as unhandled.
		const outcome = run.then(
			() => "resolved",
			(error: unknown) => error,
		);

		await vi.advanceTimersByTimeAsync(250);
		work.reject(boom);
		expect(await outcome).toBe(boom);
		const atSettle = heartbeatMock.mock.calls.length;

		await vi.advanceTimersByTimeAsync(1_000);
		expect(heartbeatMock).toHaveBeenCalledTimes(atSettle);
	});

	it("returns the work's value unchanged", async () => {
		const value = { output: { text: "hello" }, success: true };
		await expect(withHeartbeatTicker(async () => value)).resolves.toBe(
			value,
		);
	});
});

describe("outside an activity (unit tests calling activities directly)", () => {
	beforeEach(outsideActivity);

	it("reports no activity context", () => {
		expect(inActivityContext()).toBe(false);
	});

	it("is a plain call: no interval, no heartbeat", async () => {
		const work = deferred<number>();
		const run = withHeartbeatTicker(() => work.promise, {
			intervalMs: 100,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(heartbeatMock).not.toHaveBeenCalled();

		work.resolve(42);
		await expect(run).resolves.toBe(42);
		expect(heartbeatMock).not.toHaveBeenCalled();
	});

	it("still propagates a failure", async () => {
		await expect(
			withHeartbeatTicker(async () => {
				throw new Error("nope");
			}),
		).rejects.toThrow("nope");
	});
});
