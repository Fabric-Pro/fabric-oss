import type { ScheduleClient } from "@temporalio/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `registerSystemSchedules()` opens a real connection, so this file mocks the
 * SDK. That is why the registration payload lives in its own file rather than
 * beside schedule-and-queue.test.ts: `vi.mock` is file-scoped, and the constants
 * that file asserts on should be read from the unmocked module.
 *
 * EVERYTHING THE FACTORY TOUCHES IS CREATED INSIDE `vi.hoisted`, and both halves
 * of that are load-bearing — see the sibling
 * `publishing-reconcile/schedule-registration.test.ts`, which documents the two
 * concrete failures (hoisting order, `ScheduleClient` needing to be a real
 * constructor) that taught us so.
 *
 * Codex fix round 2 (§FIX 4): registerPublishingSuggestionDispatcherSchedule is
 * this file's one exception to the CREATE-ONLY convention every other
 * registration in schedules.ts follows — on `ScheduleAlreadyRunning` it now
 * patches the existing schedule's `note` in place (nothing else) so an
 * environment that registered this schedule before the org-scoped-flags fix
 * does not keep displaying the old, money-losing note forever. The `create`
 * mock below therefore needs a `getHandle` sibling, unlike the reconcile
 * schedule's create-only test.
 */
const {
	scheduleCreate,
	scheduleGetHandle,
	handleDescribe,
	handleUpdate,
	FakeScheduleAlreadyRunning,
	FakeScheduleClient,
} = vi.hoisted(() => {
	const create = vi.fn().mockResolvedValue(undefined);
	const describe = vi.fn();
	const update = vi.fn().mockResolvedValue(undefined);
	const getHandle = vi.fn(() => ({ describe, update }));
	return {
		scheduleCreate: create,
		scheduleGetHandle: getHandle,
		handleDescribe: describe,
		handleUpdate: update,
		FakeScheduleAlreadyRunning: class FakeScheduleAlreadyRunning extends Error {},
		FakeScheduleClient: class FakeScheduleClient {
			create = create;
			getHandle = getHandle;
		},
	};
});

vi.mock("@temporalio/client", () => ({
	Connection: { connect: vi.fn().mockResolvedValue({ close: vi.fn() }) },
	ScheduleClient: FakeScheduleClient,
	ScheduleAlreadyRunning: FakeScheduleAlreadyRunning,
}));
// registerSystemSchedules also calls three schedule-ensuring scripts, each of
// which reaches the database or the SDK. They are not what this file is about.
vi.mock("../../src/scripts/ensure-ai-usage-schedules", () => ({
	ensureAiUsageSchedules: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/scripts/ensure-context-summarization-schedules", () => ({
	ensureContextSummarizationSchedules: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/scripts/ensure-monitoring-schedules", () => ({
	ensureMonitoringSchedules: vi.fn().mockResolvedValue(undefined),
}));

import {
	PUBLISHING_SUGGESTION_DISPATCH_CRON_SCHEDULE,
	PUBLISHING_SUGGESTION_DISPATCH_NOTE,
	PUBLISHING_SUGGESTION_DISPATCH_SCHEDULE_ID,
	PUBLISHING_SUGGESTION_DISPATCH_WORKFLOW_NAME,
	registerPublishingSuggestionDispatcherSchedule,
	registerSystemSchedules,
} from "../../src/schedules";

function fakeClient(create = scheduleCreate): ScheduleClient {
	return {
		create,
		getHandle: scheduleGetHandle,
	} as unknown as ScheduleClient;
}

afterEach(() => {
	scheduleCreate.mockClear();
	scheduleCreate.mockResolvedValue(undefined);
	scheduleGetHandle.mockClear();
	handleDescribe.mockReset();
	handleUpdate.mockClear();
	handleUpdate.mockResolvedValue(undefined);
});

describe("the publishing-suggestion-dispatcher schedule's create payload", () => {
	it("creates the schedule with EXACTLY this payload and nothing else", async () => {
		await registerPublishingSuggestionDispatcherSchedule(fakeClient());

		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		// toEqual on the WHOLE argument, not a field-by-field walk — an extra
		// field (a stray second cron expression, `state.paused: true`) is as
		// unfixable on a create-only-on-first-boot schedule as a wrong one.
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: PUBLISHING_SUGGESTION_DISPATCH_SCHEDULE_ID,
			spec: {
				cronExpressions: [PUBLISHING_SUGGESTION_DISPATCH_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: PUBLISHING_SUGGESTION_DISPATCH_WORKFLOW_NAME,
				taskQueue: "fabric-worker",
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: "1 hour" },
			state: {
				paused: false,
				note: PUBLISHING_SUGGESTION_DISPATCH_NOTE,
			},
		});
		// The note itself must no longer make the claim Codex fix round 2 found
		// false: that the env var alone gates the sweep with no organization
		// dimension.
		expect(PUBLISHING_SUGGESTION_DISPATCH_NOTE).toMatch(/organization/i);
		expect(scheduleGetHandle).not.toHaveBeenCalled();
	});

	it("names a workflow the workflows barrel actually exports", async () => {
		const workflows = await import("../../src/workflows");
		expect(Object.keys(workflows)).toContain(
			PUBLISHING_SUGGESTION_DISPATCH_WORKFLOW_NAME,
		);
	});

	it("is actually invoked by registerSystemSchedules", async () => {
		await registerSystemSchedules();

		const ids = scheduleCreate.mock.calls.map(
			(call) => (call[0] as { scheduleId: string }).scheduleId,
		);
		expect(ids).toContain(PUBLISHING_SUGGESTION_DISPATCH_SCHEDULE_ID);
	});
});

describe("the already-exists branch — note refresh (Codex fix round 2, §FIX 4)", () => {
	function alreadyRunningCreate() {
		return vi
			.fn()
			.mockRejectedValue(new FakeScheduleAlreadyRunning("exists"));
	}

	it("treats an already-registered schedule as success, not a startup failure", async () => {
		handleDescribe.mockResolvedValue({
			state: { paused: false, note: "some old note" },
		});
		await expect(
			registerPublishingSuggestionDispatcherSchedule(
				fakeClient(alreadyRunningCreate()),
			),
		).resolves.toBeUndefined();
	});

	it("patches ONLY the note on a stale schedule, leaving spec/action/policies alone", async () => {
		const previous = {
			scheduleId: PUBLISHING_SUGGESTION_DISPATCH_SCHEDULE_ID,
			spec: { cronExpressions: ["0 6 * * *"] },
			action: {
				type: "startWorkflow" as const,
				workflowType: PUBLISHING_SUGGESTION_DISPATCH_WORKFLOW_NAME,
				taskQueue: "fabric-worker",
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: 3_600_000 },
			state: {
				paused: false,
				// The exact old, money-losing claim this fix corrects.
				note: "FABRIC_FEATURE_PUBLISHING_SUITE gates the sweep with no organization dimension.",
			},
		};
		handleDescribe.mockResolvedValue(previous);

		await registerPublishingSuggestionDispatcherSchedule(
			fakeClient(alreadyRunningCreate()),
		);

		expect(handleUpdate).toHaveBeenCalledTimes(1);
		const updateFn = handleUpdate.mock.calls[0][0] as (
			p: typeof previous,
		) => { state: { note: string }; spec: unknown; action: unknown };
		const updated = updateFn(previous);
		expect(updated.state.note).toBe(PUBLISHING_SUGGESTION_DISPATCH_NOTE);
		// Nothing else moved.
		expect(updated.spec).toBe(previous.spec);
		expect(updated.action).toBe(previous.action);
	});

	// Round 2 (§D): the note itself tells operators "to stop the sweep, …
	// pause this schedule" — so a note refresh that silently un-pauses an
	// operator's paused schedule would undo the exact remedy the note
	// recommends. `previous.state.paused` must survive the update UNCHANGED.
	// Written against a PAUSED (`true`) schedule specifically: a mutation
	// that drops `...previous.state` from the update callback would replace
	// `paused` with `undefined`, which a looser assertion (or a default-false
	// schedule) could miss — `true` cannot be confused with a dropped field
	// by accident.
	it("keeps a PAUSED schedule paused after refreshing its note", async () => {
		const previous = {
			scheduleId: PUBLISHING_SUGGESTION_DISPATCH_SCHEDULE_ID,
			spec: { cronExpressions: ["0 6 * * *"] },
			action: {
				type: "startWorkflow" as const,
				workflowType: PUBLISHING_SUGGESTION_DISPATCH_WORKFLOW_NAME,
				taskQueue: "fabric-worker",
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: 3_600_000 },
			state: {
				// An operator paused this schedule — per the note's own advice —
				// and it must still be paused after this fires.
				paused: true,
				note: "FABRIC_FEATURE_PUBLISHING_SUITE gates the sweep with no organization dimension.",
			},
		};
		handleDescribe.mockResolvedValue(previous);

		await registerPublishingSuggestionDispatcherSchedule(
			fakeClient(alreadyRunningCreate()),
		);

		expect(handleUpdate).toHaveBeenCalledTimes(1);
		const updateFn = handleUpdate.mock.calls[0][0] as (
			p: typeof previous,
		) => { state: { note: string; paused: boolean } };
		const updated = updateFn(previous);
		expect(updated.state.paused).toBe(true);
		expect(updated.state.note).toBe(PUBLISHING_SUGGESTION_DISPATCH_NOTE);
	});

	it("skips the update entirely when the note already matches — the steady state after the first fixed boot", async () => {
		handleDescribe.mockResolvedValue({
			state: { paused: false, note: PUBLISHING_SUGGESTION_DISPATCH_NOTE },
		});

		await registerPublishingSuggestionDispatcherSchedule(
			fakeClient(alreadyRunningCreate()),
		);

		expect(handleDescribe).toHaveBeenCalledTimes(1);
		expect(handleUpdate).not.toHaveBeenCalled();
	});

	it("is failure-tolerant: a describe() failure is logged and swallowed, never taking down registration", async () => {
		handleDescribe.mockRejectedValue(new Error("temporal unavailable"));
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await expect(
			registerPublishingSuggestionDispatcherSchedule(
				fakeClient(alreadyRunningCreate()),
			),
		).resolves.toBeUndefined();

		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("is failure-tolerant: an update() failure is logged and swallowed, never taking down registration", async () => {
		handleDescribe.mockResolvedValue({
			state: { paused: false, note: "stale note" },
		});
		handleUpdate.mockRejectedValue(new Error("temporal unavailable"));
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await expect(
			registerPublishingSuggestionDispatcherSchedule(
				fakeClient(alreadyRunningCreate()),
			),
		).resolves.toBeUndefined();

		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("rethrows any OTHER create failure instead of swallowing it", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new Error("namespace not found"));
		await expect(
			registerPublishingSuggestionDispatcherSchedule(fakeClient(create)),
		).rejects.toThrow("namespace not found");
		expect(scheduleGetHandle).not.toHaveBeenCalled();
	});
});
