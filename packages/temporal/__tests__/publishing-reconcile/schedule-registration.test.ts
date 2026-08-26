import type { ScheduleClient } from "@temporalio/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `registerSystemSchedules()` opens a real connection, so this file mocks the
 * SDK. That is why the registration payload lives in its own file rather than
 * beside schedule-and-queue.test.ts: `vi.mock` is file-scoped, and the constants
 * that file asserts on should be read from the unmocked module.
 *
 * EVERYTHING THE FACTORY TOUCHES IS CREATED INSIDE `vi.hoisted`, and both halves
 * of that are load-bearing — each was a real failure, observed by running this
 * file rather than reasoned about:
 *
 *   1. Vitest hoists `vi.mock` factories above module-scope declarations. With
 *      the fake error class declared as a plain `class` below, the factory ran
 *      first and the file died during mock initialization:
 *        Error: [vitest] There was an error when mocking a module...
 *        Caused by: ReferenceError: Cannot access 'FakeScheduleAlreadyRunning'
 *                   before initialization
 *      `Test Files 1 failed (1) | Tests no tests` — zero cases executed, so the
 *      unwired-registration guard this file exists for never ran at all.
 *
 *   2. `ScheduleClient` must be a real CLASS. `registerSystemSchedules` calls
 *      `new ScheduleClient({...})` (schedules.ts:326), and a
 *      `vi.fn().mockImplementation(() => ({ create }))` is not a constructor
 *      under Vitest 4:
 *        TypeError: () => ({ create: scheduleCreate }) is not a constructor
 *      One case red, four green — which is exactly the shape that reads as "the
 *      test found something" when it is the mock that is broken.
 */
const { scheduleCreate, FakeScheduleAlreadyRunning, FakeScheduleClient } =
	vi.hoisted(() => {
		const create = vi.fn().mockResolvedValue(undefined);
		return {
			scheduleCreate: create,
			FakeScheduleAlreadyRunning: class FakeScheduleAlreadyRunning extends Error {},
			FakeScheduleClient: class FakeScheduleClient {
				create = create;
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
	PUBLISHING_RECONCILE_CATCHUP_WINDOW,
	PUBLISHING_RECONCILE_CRON_SCHEDULE,
	PUBLISHING_RECONCILE_EXECUTION_TIMEOUT_MS,
	PUBLISHING_RECONCILE_SCHEDULE_ID,
	PUBLISHING_RECONCILE_TASK_QUEUE,
	PUBLISHING_RECONCILE_WORKFLOW_NAME,
	registerPublishingNotificationReconcileSchedule,
	registerSystemSchedules,
} from "../../src/schedules";

function fakeClient(create = scheduleCreate): ScheduleClient {
	return { create } as unknown as ScheduleClient;
}

afterEach(() => {
	scheduleCreate.mockClear();
	scheduleCreate.mockResolvedValue(undefined);
});

describe("the reconciliation schedule's create-only payload", () => {
	it("creates the schedule with EXACTLY this payload and nothing else", async () => {
		await registerPublishingNotificationReconcileSchedule(fakeClient());

		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		// toEqual on the WHOLE argument, not a field-by-field walk. A field-wise
		// assertion cannot see a field that should not be there — a stray
		// `spec.intervals`, a second cron expression, a `state.paused: true` —
		// and on a create-only schedule an extra field is as unfixable as a
		// wrong one.
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: PUBLISHING_RECONCILE_SCHEDULE_ID,
			spec: { cronExpressions: [PUBLISHING_RECONCILE_CRON_SCHEDULE] },
			action: {
				type: "startWorkflow",
				workflowType: PUBLISHING_RECONCILE_WORKFLOW_NAME,
				taskQueue: PUBLISHING_RECONCILE_TASK_QUEUE,
				args: [],
				workflowExecutionTimeout:
					PUBLISHING_RECONCILE_EXECUTION_TIMEOUT_MS,
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: PUBLISHING_RECONCILE_CATCHUP_WINDOW,
			},
			state: {
				paused: false,
				// Every other field in this payload is pinned exactly; this one
				// was `stringContaining("Hourly")` alone, which is the weakest
				// assertion here and the one guarding the string an operator
				// reads in the Temporal UI. It passed while the note advertised
				// three ledger transitions whose code does not ship until
				// 1C-2d-2b — and, worse, told the reader that zero movement was
				// expected, so a genuinely stuck row read as normal.
				//
				// Pinning the whole string would be brittle for a sentence that
				// exists to be readable. What is pinned instead is the pair the
				// defect turned on: the note must name the card whose CODE is
				// missing, and must never name the card that only supplies ROWS.
				// A note that regresses to advertising the ledger half will fail
				// one of these two, because it cannot make that claim without
				// dropping the gap sentence that carries 1C-2d-2b.
				note: expect.stringContaining("1C-2d-2b"),
			},
		});

		// Asserted separately from the payload: `objectContaining` cannot
		// express "and NOT this", and a second `expect` on the same captured
		// argument is clearer than a custom matcher.
		const note = (
			scheduleCreate.mock.calls[0][0] as { state: { note: string } }
		).state.note;
		expect(note).not.toContain("1C-2d-3");
	});

	it("names the workflow the workflows barrel actually exports", async () => {
		// The payload above compares two constants this module owns, so it
		// cannot catch a workflowType that no worker can resolve. This can: a
		// schedule pointing at a workflow type that is not registered produces
		// executions that fail at the first tick, hours after the deploy.
		const workflows = await import("../../src/workflows");
		expect(Object.keys(workflows)).toContain(
			PUBLISHING_RECONCILE_WORKFLOW_NAME,
		);
	});

	it("treats an already-registered schedule as success, not as a startup failure", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new FakeScheduleAlreadyRunning("exists"));
		// The SECOND boot of every environment takes this path. A registration
		// that rethrew here would fail worker startup on every deploy after the
		// first.
		await expect(
			registerPublishingNotificationReconcileSchedule(fakeClient(create)),
		).resolves.toBeUndefined();
	});

	it("rethrows any other registration failure instead of swallowing it", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new Error("namespace not found"));
		// The silent-failure guard: a broad catch here would let the worker
		// start with no schedule and nothing to say about it.
		await expect(
			registerPublishingNotificationReconcileSchedule(fakeClient(create)),
		).rejects.toThrow("namespace not found");
	});

	it("is actually invoked by registerSystemSchedules", async () => {
		await registerSystemSchedules();

		const ids = scheduleCreate.mock.calls.map(
			(call) => (call[0] as { scheduleId: string }).scheduleId,
		);
		// The registration function can be perfect and still never run. Adding
		// the function without adding its call site is a one-line omission that
		// nothing else in this slice would notice.
		expect(ids).toContain(PUBLISHING_RECONCILE_SCHEDULE_ID);
	});
});
