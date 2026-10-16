import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ db: {} }));

import {
	decideScheduledRunOutcome,
	PAUSE_AFTER_CONSECUTIVE_FAILURES,
	pausedState,
	type ScheduledRunStatus,
} from "../scheduled-run-outcome";
import {
	readScheduledRunState,
	type ScheduledRunState,
	writeScheduledRunState,
} from "../workflow-settings";

const NOW = "2026-10-14T09:00:00.000Z";

function decide(
	state: Partial<ScheduledRunState>,
	status: ScheduledRunStatus,
	workflow: { live?: boolean; paused?: boolean } = {},
) {
	return decideScheduledRunOutcome({
		state: { consecutiveFailures: 0, ...state },
		executionId: "exec-9",
		status,
		workflowIsLive: workflow.live ?? true,
		workflowIsPaused: workflow.paused ?? false,
		now: NOW,
	});
}

describe("decideScheduledRunOutcome", () => {
	it("counts a failure and records the run as counted", () => {
		const decision = decide({ consecutiveFailures: 1 }, "FAILED");

		expect(decision.state).toEqual({
			consecutiveFailures: 2,
			lastOutcomeExecutionId: "exec-9",
		});
		expect(decision.pause).toBe(false);
	});

	it("pauses on the failure that reaches the limit, with the reason and time", () => {
		const decision = decide(
			{ consecutiveFailures: PAUSE_AFTER_CONSECUTIVE_FAILURES - 1 },
			"FAILED",
		);

		expect(decision.pause).toBe(true);
		expect(decision.state).toMatchObject({
			consecutiveFailures: PAUSE_AFTER_CONSECUTIVE_FAILURES,
			pausedAt: NOW,
			pausedReason: "Paused automatically after 3 failed runs in a row.",
		});
	});

	it("does not pause a workflow that is not live", () => {
		const decision = decide({ consecutiveFailures: 5 }, "FAILED", {
			live: false,
			paused: true,
		});

		expect(decision.pause).toBe(false);
	});

	it("resets the streak on a success and marks the first one", () => {
		const decision = decide({ consecutiveFailures: 2 }, "COMPLETED");

		expect(decision.state).toMatchObject({
			consecutiveFailures: 0,
			firstSuccessNotifiedAt: NOW,
		});
		expect(decision.firstSuccess).toBe(true);
	});

	it("does not announce a later success again", () => {
		const decision = decide(
			{ firstSuccessNotifiedAt: "2026-10-01T00:00:00.000Z" },
			"COMPLETED",
		);

		expect(decision.firstSuccess).toBe(false);
		expect(decision.state.firstSuccessNotifiedAt).toBe(
			"2026-10-01T00:00:00.000Z",
		);
	});

	it("leaves the streak alone for a cancelled run", () => {
		const decision = decide({ consecutiveFailures: 2 }, "CANCELLED");

		expect(decision.state).toEqual({
			consecutiveFailures: 2,
			lastOutcomeExecutionId: "exec-9",
		});
		expect(decision.pause).toBe(false);
		expect(decision.firstSuccess).toBe(false);
	});

	it("starts a fresh streak for a workflow that was resumed after pausing", () => {
		const decision = decide(
			{
				consecutiveFailures: 3,
				pausedAt: "2026-10-01T00:00:00.000Z",
				pausedReason:
					"Paused automatically after 3 failed runs in a row.",
			},
			"FAILED",
		);

		expect(decision.state.consecutiveFailures).toBe(1);
		expect(decision.state.pausedAt).toBeUndefined();
		expect(decision.state.pausedReason).toBeUndefined();
	});

	it("keeps the pause record while the workflow is still paused", () => {
		const decision = decide(
			{ consecutiveFailures: 3, pausedAt: "2026-10-01T00:00:00.000Z" },
			"CANCELLED",
			{ live: false, paused: true },
		);

		expect(decision.state.pausedAt).toBe("2026-10-01T00:00:00.000Z");
	});
});

describe("pausedState", () => {
	it("adds the time and the reason without touching the rest", () => {
		const state = pausedState(
			{ consecutiveFailures: 1 },
			"owner-access-lost",
			NOW,
		);

		expect(state).toEqual({
			consecutiveFailures: 1,
			pausedAt: NOW,
			pausedReason: "owner-access-lost",
		});
	});
});

describe("scheduled run state in settings", () => {
	it("reads what is there and defaults what is not", () => {
		expect(readScheduledRunState({})).toEqual({
			consecutiveFailures: 0,
			lastOutcomeExecutionId: undefined,
			firstSuccessNotifiedAt: undefined,
			pausedAt: undefined,
			pausedReason: undefined,
		});
		expect(
			readScheduledRunState({
				consecutiveFailures: 2.9,
				lastOutcomeExecutionId: "exec-1",
				pausedAt: NOW,
			}),
		).toMatchObject({
			consecutiveFailures: 2,
			lastOutcomeExecutionId: "exec-1",
			pausedAt: NOW,
		});
	});

	it("ignores values of the wrong type", () => {
		const state = readScheduledRunState({
			consecutiveFailures: "3",
			lastOutcomeExecutionId: 7,
			pausedReason: "",
		});

		expect(state.consecutiveFailures).toBe(0);
		expect(state.lastOutcomeExecutionId).toBeUndefined();
		expect(state.pausedReason).toBeUndefined();
	});

	it("writes the state over the old keys and keeps unrelated settings", () => {
		const written = writeScheduledRunState(
			{
				publishFrameIds: { a: "frame-1" },
				consecutiveFailures: 3,
				pausedAt: NOW,
				pausedReason: "x",
			},
			{ consecutiveFailures: 0, lastOutcomeExecutionId: "exec-2" },
		);

		expect(written).toEqual({
			publishFrameIds: { a: "frame-1" },
			consecutiveFailures: 0,
			lastOutcomeExecutionId: "exec-2",
		});
	});
});
