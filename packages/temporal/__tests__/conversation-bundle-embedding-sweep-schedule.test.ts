/**
 * Registration guard for the conversation-bundle embedding recovery schedule
 * (Fizzy #2228, U11).
 *
 * The sweep is only real if it is actually scheduled. Every failure this file
 * covers is silent in production: a registration function nobody calls, a
 * `workflowType` no worker can resolve, an `already exists` rejection that
 * fails worker startup on the second boot of every environment.
 *
 * `registerSystemSchedules()` opens a real connection, so the SDK is mocked —
 * and everything the factory touches is created inside `vi.hoisted`, because
 * Vitest hoists `vi.mock` factories above module-scope declarations and
 * `ScheduleClient` must be a real class (`new ScheduleClient(...)`). Both of
 * those are load-bearing; see the sibling
 * `publishing-reconcile/schedule-registration.test.ts` for the failures that
 * taught us so.
 */

import type { ScheduleClient } from "@temporalio/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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
// `registerSystemSchedules` also calls three schedule-ensuring scripts, each of
// which reaches the database or the SDK. They are not what this file is about.
vi.mock("../src/scripts/ensure-ai-usage-schedules", () => ({
	ensureAiUsageSchedules: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/scripts/ensure-context-summarization-schedules", () => ({
	ensureContextSummarizationSchedules: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/scripts/ensure-monitoring-schedules", () => ({
	ensureMonitoringSchedules: vi.fn().mockResolvedValue(undefined),
}));

import {
	CONVERSATION_BUNDLE_EMBED_SWEEP_CATCHUP_WINDOW,
	CONVERSATION_BUNDLE_EMBED_SWEEP_CRON_SCHEDULE,
	CONVERSATION_BUNDLE_EMBED_SWEEP_SCHEDULE_ID,
	CONVERSATION_BUNDLE_EMBED_SWEEP_WORKFLOW_NAME,
	registerConversationBundleEmbeddingSweepSchedule,
	registerSystemSchedules,
} from "../src/schedules";

function fakeClient(create = scheduleCreate): ScheduleClient {
	return { create } as unknown as ScheduleClient;
}

afterEach(() => {
	scheduleCreate.mockClear();
	scheduleCreate.mockResolvedValue(undefined);
});

describe("the conversation-bundle embedding recovery schedule", () => {
	it("creates the schedule with EXACTLY this payload and nothing else", async () => {
		await registerConversationBundleEmbeddingSweepSchedule(fakeClient());

		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		// `toEqual` on the WHOLE argument, not a field-by-field walk. The
		// schedule is created ONCE per environment and never updated, so an
		// extra field — a stray second cron expression, `state.paused: true` —
		// is as unfixable as a wrong one.
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: CONVERSATION_BUNDLE_EMBED_SWEEP_SCHEDULE_ID,
			spec: {
				cronExpressions: [
					CONVERSATION_BUNDLE_EMBED_SWEEP_CRON_SCHEDULE,
				],
			},
			action: {
				type: "startWorkflow",
				workflowType: CONVERSATION_BUNDLE_EMBED_SWEEP_WORKFLOW_NAME,
				taskQueue: "fabric-worker",
				args: [],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: CONVERSATION_BUNDLE_EMBED_SWEEP_CATCHUP_WINDOW,
			},
			state: {
				paused: false,
				// The one string an operator reads in the Temporal UI, and the
				// only place the "full batch means the backlog is not draining"
				// reading is written down. Pinning the whole sentence would be
				// brittle; pinning the two terms it has to carry is not.
				note: expect.stringContaining("full batch"),
			},
		});
		const note = (
			scheduleCreate.mock.calls[0][0] as { state: { note: string } }
		).state.note;
		expect(note).toContain("embeddedAt");
	});

	it("names a workflow the workflows barrel actually exports", async () => {
		// The payload above compares two constants this module owns, so it
		// cannot catch a workflowType no worker can resolve. This can: a
		// schedule pointing at an unregistered workflow type produces
		// executions that fail at the first tick, long after the deploy.
		const workflows = await import("../src/workflows");
		expect(Object.keys(workflows)).toContain(
			CONVERSATION_BUNDLE_EMBED_SWEEP_WORKFLOW_NAME,
		);
	});

	it("runs on a queue a worker is actually listening to", async () => {
		// `fabric-worker` is the general-purpose queue every other retention
		// and watchdog sweep uses; a typo here parks the workflow forever with
		// no error anywhere.
		const workerSrc = await import("node:fs").then((fs) =>
			fs.readFileSync(
				new URL("../src/worker.ts", import.meta.url),
				"utf8",
			),
		);
		expect(workerSrc).toContain('taskQueue: "fabric-worker"');
	});

	it("treats an already-registered schedule as success, not a startup failure", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new FakeScheduleAlreadyRunning("exists"));
		// The SECOND boot of every environment takes this path.
		await expect(
			registerConversationBundleEmbeddingSweepSchedule(
				fakeClient(create),
			),
		).resolves.toBeUndefined();
	});

	it("rethrows any other registration failure instead of swallowing it", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new Error("namespace not found"));
		await expect(
			registerConversationBundleEmbeddingSweepSchedule(
				fakeClient(create),
			),
		).rejects.toThrow("namespace not found");
	});

	it("appears in the registry — registerSystemSchedules actually invokes it", async () => {
		await registerSystemSchedules();

		const ids = scheduleCreate.mock.calls.map(
			(call) => (call[0] as { scheduleId: string }).scheduleId,
		);
		// The registration function can be perfect and still never run. Adding
		// it without adding its call site is a one-line omission nothing else
		// in this unit would notice.
		expect(ids).toContain(CONVERSATION_BUNDLE_EMBED_SWEEP_SCHEDULE_ID);
	});

	it("cannot outlive its own trigger interval", async () => {
		// `overlap: "SKIP"` is only safe while a run is bounded strictly under
		// the gap between triggers — otherwise one wedged run silently swallows
		// every subsequent tick. Derived from the cron rather than restated, so
		// shortening the cron alone is red.
		const [minuteField] =
			CONVERSATION_BUNDLE_EMBED_SWEEP_CRON_SCHEDULE.split(" ");
		const intervalMinutes = Number(minuteField.replace("*/", ""));
		expect(Number.isFinite(intervalMinutes)).toBe(true);

		const workflowSrc = await import("node:fs").then((fs) =>
			fs.readFileSync(
				new URL(
					"../src/workflows/conversation-bundle-embedding-sweep.ts",
					import.meta.url,
				),
				"utf8",
			),
		);
		const timeout = workflowSrc.match(
			/startToCloseTimeout:\s*"(\d+) minutes"/,
		);
		expect(timeout).not.toBeNull();
		expect(Number(timeout?.[1])).toBeLessThan(intervalMinutes);
	});
});
