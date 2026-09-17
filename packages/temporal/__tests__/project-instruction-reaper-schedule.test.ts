/**
 * Registration guard for the Coding Instructions lifecycle reaper schedule
 * (Fizzy #2550).
 *
 * The sweep is only real if it is actually scheduled, and every failure this
 * file covers is silent in production: a registration function nobody calls, a
 * `workflowType` no worker can resolve, a task queue nothing polls, an
 * `already exists` rejection that fails worker startup on the second boot of
 * every environment.
 *
 * `registerSystemSchedules()` opens a real connection, so the SDK is mocked —
 * and everything the factory touches is created inside `vi.hoisted`, because
 * Vitest hoists `vi.mock` factories above module-scope declarations and
 * `ScheduleClient` must be a real class (`new ScheduleClient(...)`). See the
 * sibling `conversation-bundle-embedding-sweep-schedule.test.ts` for the
 * failures that taught us so.
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
	PROJECT_INSTRUCTION_REAPER_CRON_SCHEDULE,
	PROJECT_INSTRUCTION_REAPER_SCHEDULE_ID,
	PROJECT_INSTRUCTION_REAPER_WORKFLOW_NAME,
	registerProjectInstructionReaperSchedule,
	registerSystemSchedules,
} from "../src/schedules";

function fakeClient(create = scheduleCreate): ScheduleClient {
	return { create } as unknown as ScheduleClient;
}

afterEach(() => {
	scheduleCreate.mockClear();
	scheduleCreate.mockResolvedValue(undefined);
});

describe("the Coding Instructions reaper schedule", () => {
	it("creates the schedule with EXACTLY this payload and nothing else", async () => {
		await registerProjectInstructionReaperSchedule(fakeClient());

		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		// `toEqual` on the WHOLE argument, not a field-by-field walk. The
		// schedule is created ONCE per environment and never updated, so an
		// extra field — a stray second cron expression, `state.paused: true` —
		// is as unfixable as a wrong one.
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: PROJECT_INSTRUCTION_REAPER_SCHEDULE_ID,
			spec: {
				cronExpressions: [PROJECT_INSTRUCTION_REAPER_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: PROJECT_INSTRUCTION_REAPER_WORKFLOW_NAME,
				// NOT `project-instructions`: that queue's two activity slots
				// are reserved for user uploads, and a sweep competing for
				// them would make an upload wait on housekeeping.
				taskQueue: "fabric-worker",
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: "1 hour" },
			state: {
				paused: false,
				// The one string an operator reads in the Temporal UI, and the
				// only place what this reclaims is written down. Pinning the
				// whole sentence would be brittle; pinning the two things it
				// has to say is not.
				note: expect.stringContaining("RECEIVING"),
			},
		});
		const note = (
			scheduleCreate.mock.calls[0][0] as { state: { note: string } }
		).state.note;
		expect(note).toContain("retention");
	});

	it("runs hourly, off the daily retention cluster", async () => {
		// Hourly because an abandoned upload keeps the tab polling for every
		// viewer until something closes it out; minute 40 keeps it clear of
		// the 03:00/03:15/03:45/04:15/04:45 jobs that share this queue.
		expect(PROJECT_INSTRUCTION_REAPER_CRON_SCHEDULE).toBe("40 * * * *");
	});

	it("names a workflow the workflows barrel actually exports", async () => {
		// The payload above compares two constants this module owns, so it
		// cannot catch a workflowType no worker can resolve. This can: a
		// schedule pointing at an unregistered workflow type produces
		// executions that fail at the first tick, long after the deploy.
		const workflows = await import("../src/workflows");
		expect(Object.keys(workflows)).toContain(
			PROJECT_INSTRUCTION_REAPER_WORKFLOW_NAME,
		);
	});

	it("names an activity the top-level activities barrel registers", async () => {
		// `worker.ts` registers `import * as activities from "./activities"`.
		// An activity exported only from its own module is never registered,
		// and the workflow's `proxyActivities` call then fails at RUNTIME
		// while type-checking still passes.
		const activities = await import("../src/activities");
		expect(Object.keys(activities)).toContain("reapInstructionSnapshots");
	});

	it("runs on a queue a worker is actually listening to", async () => {
		const workerSrc = await import("node:fs").then((fs) =>
			fs.readFileSync(
				new URL("../src/worker.ts", import.meta.url),
				"utf8",
			),
		);
		expect(workerSrc).toContain('taskQueue: "fabric-worker"');
	});

	it("cannot outlive its own trigger interval", async () => {
		// `overlap: "SKIP"` is only safe while a run is bounded strictly under
		// the gap between triggers — otherwise one wedged run silently
		// swallows every subsequent tick.
		const workflowSrc = await import("node:fs").then((fs) =>
			fs.readFileSync(
				new URL(
					"../src/workflows/project-instruction-reaper.ts",
					import.meta.url,
				),
				"utf8",
			),
		);
		const timeout = workflowSrc.match(
			/startToCloseTimeout:\s*"(\d+) minutes"/,
		);
		expect(timeout).not.toBeNull();
		expect(Number(timeout?.[1])).toBeLessThan(60);
	});

	it("declares a heartbeat timeout, so a dead worker is not waited on for the whole run", async () => {
		// The activity heartbeats per candidate row, per project and per
		// storage page. Without a heartbeat timeout a worker that dies
		// mid-run holds the entire `startToCloseTimeout` before anything
		// retries — which, with `overlap: "SKIP"`, swallows the ticks in
		// between as well.
		const workflowSrc = await import("node:fs").then((fs) =>
			fs.readFileSync(
				new URL(
					"../src/workflows/project-instruction-reaper.ts",
					import.meta.url,
				),
				"utf8",
			),
		);
		const heartbeat = workflowSrc.match(
			/heartbeatTimeout:\s*"(\d+) minutes"/,
		);
		expect(heartbeat).not.toBeNull();
		const startToClose = Number(
			workflowSrc.match(/startToCloseTimeout:\s*"(\d+) minutes"/)?.[1],
		);
		// Strictly inside the start-to-close window, or it can never fire.
		expect(Number(heartbeat?.[1])).toBeLessThan(startToClose);
	});

	it("treats an already-registered schedule as success, not a startup failure", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new FakeScheduleAlreadyRunning("exists"));
		// The SECOND boot of every environment takes this path.
		await expect(
			registerProjectInstructionReaperSchedule(fakeClient(create)),
		).resolves.toBeUndefined();
	});

	it("rethrows any other registration failure instead of swallowing it", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new Error("namespace not found"));
		await expect(
			registerProjectInstructionReaperSchedule(fakeClient(create)),
		).rejects.toThrow("namespace not found");
	});

	it("appears in the registry — registerSystemSchedules actually invokes it", async () => {
		await registerSystemSchedules();

		const ids = scheduleCreate.mock.calls.map(
			(call) => (call[0] as { scheduleId: string }).scheduleId,
		);
		// The registration function can be perfect and still never run.
		expect(ids).toContain(PROJECT_INSTRUCTION_REAPER_SCHEDULE_ID);
	});
});
