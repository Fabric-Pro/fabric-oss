/**
 * Liveness helpers for long-running activities.
 *
 * Both must work outside an activity context, because the modules that use them
 * are called directly from unit tests — a throw there would turn a missing
 * Temporal context into a fetch failure, which is a confusing way to learn you
 * are not inside a worker.
 */

import { describe, expect, it, vi } from "vitest";

const { heartbeatMock, currentMock } = vi.hoisted(() => ({
	heartbeatMock: vi.fn(),
	currentMock: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: (details?: unknown) => heartbeatMock(details),
	Context: {
		get current() {
			return currentMock;
		},
	},
}));

import {
	currentActivityAttemptDeadline,
	requestAbortSignal,
	safeHeartbeat,
} from "../activity-liveness";

describe("safeHeartbeat", () => {
	it("passes details through when inside an activity", () => {
		heartbeatMock.mockImplementation(() => undefined);
		safeHeartbeat({ phase: "github-run", runId: 7 });
		expect(heartbeatMock).toHaveBeenCalledWith({
			phase: "github-run",
			runId: 7,
		});
	});

	it("is a no-op when there is no activity context", () => {
		heartbeatMock.mockImplementation(() => {
			throw new Error("not in activity context");
		});
		expect(() => safeHeartbeat()).not.toThrow();
	});
});

describe("requestAbortSignal", () => {
	it("aborts on timeout even with no activity context", async () => {
		currentMock.mockImplementation(() => {
			throw new Error("not in activity context");
		});
		const signal = requestAbortSignal(5);
		expect(signal.aborted).toBe(false);
		await new Promise((r) => setTimeout(r, 30));
		expect(signal.aborted).toBe(true);
	});

	it("also aborts when the activity is cancelled", () => {
		const controller = new AbortController();
		currentMock.mockReturnValue({ cancellationSignal: controller.signal });

		const signal = requestAbortSignal(60_000);
		expect(signal.aborted).toBe(false);

		// Cancelling the workflow must tear down in-flight HTTP rather than
		// leaving it to run out the request timeout.
		controller.abort();
		expect(signal.aborted).toBe(true);
	});
});

describe("currentActivityAttemptDeadline", () => {
	it("uses the original schedule-to-close deadline when it is earlier", () => {
		currentMock.mockReturnValue({
			info: {
				currentAttemptScheduledTimestampMs: 1_000,
				startToCloseTimeoutMs: 10_000,
				scheduledTimestampMs: 500,
				scheduleToCloseTimeoutMs: 8_000,
			},
		});

		expect(currentActivityAttemptDeadline()).toEqual(new Date(8_500));
	});

	it("starts the cooperative start-to-close budget when the worker enters after queueing", () => {
		const context = {
			info: {
				currentAttemptScheduledTimestampMs: 1_000,
				startToCloseTimeoutMs: 1_000,
				scheduledTimestampMs: 1_000,
				scheduleToCloseTimeoutMs: 0,
			},
		};
		currentMock.mockReturnValue(context);

		expect(currentActivityAttemptDeadline(3_500)).toEqual(new Date(4_500));
		// Terminal fences use the same entry boundary rather than extending the
		// attempt from the time of their later write.
		expect(currentActivityAttemptDeadline(3_900)).toEqual(new Date(4_500));
	});

	it("uses the supplied clock when Temporal lacks an attempt schedule", () => {
		currentMock.mockReturnValue({
			info: {
				currentAttemptScheduledTimestampMs: Number.NaN,
				startToCloseTimeoutMs: 10_000,
				scheduledTimestampMs: Number.NaN,
				scheduleToCloseTimeoutMs: 0,
			},
		});

		expect(currentActivityAttemptDeadline(2_000)).toEqual(new Date(12_000));
	});

	it("does not invent a deadline outside a Temporal activity", () => {
		currentMock.mockImplementation(() => {
			throw new Error("not in activity context");
		});

		expect(currentActivityAttemptDeadline()).toBeUndefined();
	});
});
