/**
 * Registration guard for the Coding Instructions automatic-sync poll schedule
 * (spec §6.1, Fizzy #2540). Same shape and the same reasons as
 * project-instruction-reaper-schedule.test.ts: every failure covered here is
 * silent in production.
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
vi.mock("../src/scripts/ensure-ai-usage-schedules", () => ({
	ensureAiUsageSchedules: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/scripts/ensure-context-summarization-schedules", () => ({
	ensureContextSummarizationSchedules: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/scripts/ensure-monitoring-schedules", () => ({
	ensureMonitoringSchedules: vi.fn().mockResolvedValue(undefined),
}));

import { INSTRUCTION_SYNC_POLL_BUDGET_MS } from "../src/lib/instruction-sync-types";
import {
	PROJECT_INSTRUCTION_REPOSITORY_POLL_CRON_SCHEDULE,
	PROJECT_INSTRUCTION_REPOSITORY_POLL_EXECUTION_TIMEOUT_MS,
	PROJECT_INSTRUCTION_REPOSITORY_POLL_SCHEDULE_ID,
	PROJECT_INSTRUCTION_REPOSITORY_POLL_WORKFLOW_NAME,
	registerProjectInstructionRepositoryPollSchedule,
	registerSystemSchedules,
} from "../src/schedules";

function fakeClient(create = scheduleCreate): ScheduleClient {
	return { create } as unknown as ScheduleClient;
}

/**
 * The interval between triggers, derived from the cron itself, as the
 * publishing-reconcile schedule test does. Narrow on purpose: it THROWS on
 * any shape but a stepped minute with every other field a star, so a cadence
 * change cannot slip past the inequalities below.
 */
function cronIntervalMs(expression: string): number {
	const [minute, hour, dayOfMonth, month, dayOfWeek] = expression
		.trim()
		.split(/\s+/);
	if (
		hour !== "*" ||
		dayOfMonth !== "*" ||
		month !== "*" ||
		dayOfWeek !== "*"
	) {
		throw new Error(`Unsupported cron shape: ${expression}`);
	}
	const stepped = /^\*\/(\d+)$/.exec(minute ?? "");
	if (!stepped) {
		throw new Error(`Unsupported cron shape: ${expression}`);
	}
	return Number(stepped[1]) * 60_000;
}

afterEach(() => {
	scheduleCreate.mockClear();
	scheduleCreate.mockResolvedValue(undefined);
});

describe("the Coding Instructions repository poll schedule", () => {
	it("creates the schedule with EXACTLY this payload and nothing else", async () => {
		await registerProjectInstructionRepositoryPollSchedule(fakeClient());

		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: PROJECT_INSTRUCTION_REPOSITORY_POLL_SCHEDULE_ID,
			spec: {
				cronExpressions: [
					PROJECT_INSTRUCTION_REPOSITORY_POLL_CRON_SCHEDULE,
				],
			},
			action: {
				type: "startWorkflow",
				workflowType: PROJECT_INSTRUCTION_REPOSITORY_POLL_WORKFLOW_NAME,
				// The poll's activities inherit this queue; the
				// project-instructions queue stays reserved for uploads.
				taskQueue: "fabric-worker",
				args: [],
				workflowExecutionTimeout:
					PROJECT_INSTRUCTION_REPOSITORY_POLL_EXECUTION_TIMEOUT_MS,
			},
			policies: { overlap: "SKIP", catchupWindow: "5 minutes" },
			state: {
				paused: false,
				note: expect.stringContaining(
					"normally 15 to 20 minutes after a push",
				),
			},
		});
		const note = (
			scheduleCreate.mock.calls[0][0] as { state: { note: string } }
		).state.note;
		expect(note).toContain("branch");
	});

	it("uses the spec's id and cron", () => {
		expect(PROJECT_INSTRUCTION_REPOSITORY_POLL_SCHEDULE_ID).toBe(
			"project-instruction-repository-poll",
		);
		expect(PROJECT_INSTRUCTION_REPOSITORY_POLL_CRON_SCHEDULE).toBe(
			"*/5 * * * *",
		);
	});

	it("names a workflow the workflows barrel actually exports", async () => {
		const workflows = await import("../src/workflows");
		expect(Object.keys(workflows)).toContain(
			PROJECT_INSTRUCTION_REPOSITORY_POLL_WORKFLOW_NAME,
		);
	});

	// No barrel import here: the activities are destructured off
	// `proxyActivities` in the workflow (not read as a namespace member), so
	// `activity-registration-parity.test.ts` already proves statically that
	// every name below is a runtime export of `../src/activities`. Importing
	// the barrel here only bought a slow, flaky duplicate of that proof — the
	// poll module alone pulls in @repo/database, @repo/instructions and
	// @repo/integrations, so this still needs more than the default 20 s.
	it("registers exactly the three poll activities, and the poll module exports nothing else", async () => {
		const names = [
			"checkInstructionSyncRemoteHead",
			"claimDueInstructionSyncChecks",
			"sweepInstructionSyncTempDirs",
		];
		const poll = await import(
			"../src/activities/project-instruction-repository-poll"
		);
		expect(Object.keys(poll).sort()).toEqual(names);
	}, 60_000);

	it("runs on a queue a worker is actually listening to", async () => {
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
		await expect(
			registerProjectInstructionRepositoryPollSchedule(
				fakeClient(create),
			),
		).resolves.toBeUndefined();
	});

	it("rethrows any other registration failure instead of swallowing it", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new Error("namespace not found"));
		await expect(
			registerProjectInstructionRepositoryPollSchedule(
				fakeClient(create),
			),
		).rejects.toThrow("namespace not found");
	});

	it("appears in the registry: registerSystemSchedules actually invokes it", async () => {
		await registerSystemSchedules();
		const ids = scheduleCreate.mock.calls.map(
			(call) => (call[0] as { scheduleId: string }).scheduleId,
		);
		expect(ids).toContain(PROJECT_INSTRUCTION_REPOSITORY_POLL_SCHEDULE_ID);
	});
});

describe("the poll schedule's interlocked numbers (Decision 32)", () => {
	it("fires every five minutes", () => {
		expect(
			cronIntervalMs(PROJECT_INSTRUCTION_REPOSITORY_POLL_CRON_SCHEDULE),
		).toBe(5 * 60_000);
	});

	it("terminates a wedged run BEFORE the next trigger fires, so overlap SKIP never swallows ticks", () => {
		expect(
			PROJECT_INSTRUCTION_REPOSITORY_POLL_EXECUTION_TIMEOUT_MS,
		).toBeLessThan(
			cronIntervalMs(PROJECT_INSTRUCTION_REPOSITORY_POLL_CRON_SCHEDULE),
		);
	});

	it("leaves 30 s between a terminated run and the next trigger", () => {
		expect(
			cronIntervalMs(PROJECT_INSTRUCTION_REPOSITORY_POLL_CRON_SCHEDULE) -
				PROJECT_INSTRUCTION_REPOSITORY_POLL_EXECUTION_TIMEOUT_MS,
		).toBeGreaterThanOrEqual(30_000);
	});

	it("outlasts the workflow's own budget, so a run that keeps to it is never cut off", () => {
		expect(
			PROJECT_INSTRUCTION_REPOSITORY_POLL_EXECUTION_TIMEOUT_MS,
		).toBeGreaterThan(INSTRUCTION_SYNC_POLL_BUDGET_MS);
	});
});
