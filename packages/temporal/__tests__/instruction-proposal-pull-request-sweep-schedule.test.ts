/**
 * Registration guard for the Coding Instructions proposal pull-request
 * sweeper schedule (Fizzy #2563 spec §9, plan Decision 16). Same shape and
 * the same reasons as project-instruction-repository-poll-schedule.test.ts:
 * every failure covered here is silent in production. A file of its own
 * because it mocks `@temporalio/client`, which the sweeper's time-skipping
 * tests need for real.
 */

import { INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_ID } from "@repo/instructions/workflow-ids";
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

import { PROPOSAL_SWEEP_BUDGET_MS } from "../src/lib/instruction-proposal-pull-request-types";
import {
	INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_CRON_SCHEDULE,
	INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_EXECUTION_TIMEOUT_MS,
	INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_SCHEDULE_ID,
	INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_NAME,
	registerInstructionProposalPullRequestSweepSchedule,
	registerSystemSchedules,
} from "../src/schedules";

function fakeClient(create = scheduleCreate): ScheduleClient {
	return { create } as unknown as ScheduleClient;
}

/** A stepped-minute cron's interval; throws on any other shape. */
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

describe("the proposal pull-request sweeper schedule", () => {
	it("uses the plan's id, workflow name, cron and 270 s execution timeout", () => {
		expect(INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_SCHEDULE_ID).toBe(
			"instruction-proposal-pull-request-sweep",
		);
		expect(INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_NAME).toBe(
			"instructionProposalPullRequestSweepWorkflow",
		);
		expect(INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_CRON_SCHEDULE).toBe(
			"*/5 * * * *",
		);
		expect(
			INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_EXECUTION_TIMEOUT_MS,
		).toBe(270_000);
	});

	it("creates the schedule with EXACTLY this payload: fabric-worker, overlap SKIP, the sweeper's own workflow id", async () => {
		await registerInstructionProposalPullRequestSweepSchedule(fakeClient());

		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_SCHEDULE_ID,
			spec: {
				cronExpressions: [
					INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_CRON_SCHEDULE,
				],
			},
			action: {
				type: "startWorkflow",
				workflowType:
					INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_NAME,
				workflowId: INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_ID,
				// The sweeper's activities inherit this queue; the
				// project-instructions queue stays reserved for uploads.
				taskQueue: "fabric-worker",
				args: [],
				workflowExecutionTimeout:
					INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_EXECUTION_TIMEOUT_MS,
			},
			policies: { overlap: "SKIP", catchupWindow: "5 minutes" },
			state: {
				paused: false,
				note: expect.stringContaining("pull request"),
			},
		});
	});

	it("names a workflow the workflows barrel actually exports", async () => {
		const workflows = await import("../src/workflows");
		expect(Object.keys(workflows)).toContain(
			INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_NAME,
		);
		expect(Object.keys(workflows)).toContain(
			"projectInstructionProposalPullRequestWorkflow",
		);
	});

	it("treats an already-registered schedule as success, not a startup failure", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new FakeScheduleAlreadyRunning("exists"));
		await expect(
			registerInstructionProposalPullRequestSweepSchedule(
				fakeClient(create),
			),
		).resolves.toBeUndefined();
	});

	it("rethrows any other registration failure instead of swallowing it", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new Error("namespace not found"));
		await expect(
			registerInstructionProposalPullRequestSweepSchedule(
				fakeClient(create),
			),
		).rejects.toThrow("namespace not found");
	});

	it("appears in the registry: registerSystemSchedules actually invokes it", async () => {
		await registerSystemSchedules();
		const ids = scheduleCreate.mock.calls.map(
			(call) => (call[0] as { scheduleId: string }).scheduleId,
		);
		expect(ids).toContain(
			INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_SCHEDULE_ID,
		);
	});

	it("terminates a wedged run before the next trigger, and outlasts the sweeper's own budget", () => {
		const interval = cronIntervalMs(
			INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_CRON_SCHEDULE,
		);
		expect(interval).toBe(5 * 60_000);
		expect(
			interval -
				INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_EXECUTION_TIMEOUT_MS,
		).toBeGreaterThanOrEqual(30_000);
		expect(
			INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_EXECUTION_TIMEOUT_MS,
		).toBeGreaterThan(PROPOSAL_SWEEP_BUDGET_MS);
	});
});

describe("one credential-free reading of a stored URL (R7)", () => {
	it("the sync's credentialFreeUrl is the shared one admission's identity is parsed from, and strips userinfo", async () => {
		const shared = await import(
			"@repo/integrations/instruction-pull-requests"
		);
		const git = await import("../src/activities/lib/instruction-sync-git");
		expect(git.credentialFreeUrl).toBe(shared.credentialFreeUrl);
		const userinfo = ["x-access-token", "not-a-secret"].join(":");
		expect(
			git.credentialFreeUrl(
				`https://${userinfo}@git.example.com/acme/repo.git`,
			),
		).toBe("https://git.example.com/acme/repo.git");
	});
});
