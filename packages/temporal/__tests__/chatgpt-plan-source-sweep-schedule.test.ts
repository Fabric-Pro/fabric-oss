/**
 * Registration guard for the ChatGPT plan source-row sweep schedule
 * (Fizzy #3038).
 *
 * The sweep is only real if it is actually scheduled, and each failure here
 * is silent in production: a registration nobody calls, a `workflowType` or
 * activity no worker registers, an execution timeout that lets a wedged run
 * swallow later triggers under `overlap: "SKIP"`. Mocks the SDK the way the
 * sibling `project-instruction-reaper-schedule.test.ts` does, for the same
 * reasons.
 */

import { readFileSync } from "node:fs";
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

import { chatGptPlanSourceSweepSourceWorstCaseMs } from "@repo/database";
import {
	CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS,
	CHATGPT_PLAN_SOURCE_SWEEP_MAX_ITERATIONS,
	CHATGPT_PLAN_SOURCE_SWEEP_SOURCE_WORST_CASE_MS,
	chatGptPlanSourceSweepActivityCallWorstCaseMs,
	chatGptPlanSourceSweepRunWorstCaseMs,
} from "../src/lib/chatgpt-plan-source-sweep-budget";
import {
	CHATGPT_PLAN_SOURCE_SWEEP_CRON_SCHEDULE,
	CHATGPT_PLAN_SOURCE_SWEEP_EXECUTION_TIMEOUT_MS,
	CHATGPT_PLAN_SOURCE_SWEEP_SCHEDULE_ID,
	CHATGPT_PLAN_SOURCE_SWEEP_WORKFLOW_NAME,
	registerChatGptPlanSourceSweepSchedule,
	registerSystemSchedules,
} from "../src/schedules";

function fakeClient(create = scheduleCreate): ScheduleClient {
	return { create } as unknown as ScheduleClient;
}

/** A once-a-day cron's interval (`M H * * *`); throws on any other shape. */
function dailyCronIntervalMs(expression: string): number {
	const fields = expression.trim().split(/\s+/);
	if (
		fields.length !== 5 ||
		!/^\d+$/.test(fields[0]) ||
		!/^\d+$/.test(fields[1]) ||
		fields.slice(2).some((field) => field !== "*")
	) {
		throw new Error(`Unsupported cron shape: ${expression}`);
	}
	return 24 * 60 * 60_000;
}

const workflowSource = () =>
	readFileSync(
		new URL(
			"../src/workflows/chatgpt-plan-source-sweep.ts",
			import.meta.url,
		),
		"utf8",
	);

afterEach(() => {
	scheduleCreate.mockClear();
	scheduleCreate.mockResolvedValue(undefined);
});

describe("the ChatGPT plan source-row sweep schedule", () => {
	it("creates the schedule with EXACTLY this payload and nothing else", async () => {
		await registerChatGptPlanSourceSweepSchedule(fakeClient());

		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: CHATGPT_PLAN_SOURCE_SWEEP_SCHEDULE_ID,
			spec: {
				cronExpressions: [CHATGPT_PLAN_SOURCE_SWEEP_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: CHATGPT_PLAN_SOURCE_SWEEP_WORKFLOW_NAME,
				taskQueue: "fabric-worker",
				args: [],
				workflowExecutionTimeout:
					CHATGPT_PLAN_SOURCE_SWEEP_EXECUTION_TIMEOUT_MS,
			},
			policies: { overlap: "SKIP", catchupWindow: "1 hour" },
			state: {
				paused: false,
				note: expect.stringContaining("re-checked under its own lock"),
			},
		});
	});

	it("runs daily at 05:45 UTC, a slot no other daily job holds", () => {
		expect(CHATGPT_PLAN_SOURCE_SWEEP_CRON_SCHEDULE).toBe("45 5 * * *");
		const schedules = readFileSync(
			new URL("../src/schedules.ts", import.meta.url),
			"utf8",
		);
		expect(schedules.match(/"45 5 \* \* \*"/g)).toHaveLength(1);
	});

	it("cannot outlive its own trigger interval, nor be cut short by it", () => {
		const interval = dailyCronIntervalMs(
			CHATGPT_PLAN_SOURCE_SWEEP_CRON_SCHEDULE,
		);
		expect(CHATGPT_PLAN_SOURCE_SWEEP_EXECUTION_TIMEOUT_MS).toBeLessThan(
			interval,
		);
		// A run at its page cap, every call at its worst with all retries,
		// still fits, so a slow but healthy walk is never terminated.
		const callWorst = chatGptPlanSourceSweepActivityCallWorstCaseMs();
		const { startToCloseTimeout, retry } =
			CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS;
		expect(callWorst).toBeGreaterThanOrEqual(
			startToCloseTimeout * retry.maximumAttempts,
		);
		expect(chatGptPlanSourceSweepRunWorstCaseMs()).toBe(
			CHATGPT_PLAN_SOURCE_SWEEP_MAX_ITERATIONS * callWorst,
		);
		expect(chatGptPlanSourceSweepRunWorstCaseMs()).toBeLessThan(
			CHATGPT_PLAN_SOURCE_SWEEP_EXECUTION_TIMEOUT_MS,
		);
	});

	it("sizes the workflow's activity from the budget module, not from literals", () => {
		const source = workflowSource();
		expect(source).toMatch(
			/startToCloseTimeout:\s*CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS\.startToCloseTimeout/,
		);
		expect(source).toMatch(
			/retry:\s*\{\s*\.\.\.CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS\.retry\s*\}/,
		);
		expect(source).toMatch(
			/while \(result\.pages < CHATGPT_PLAN_SOURCE_SWEEP_MAX_ITERATIONS\)/,
		);
		expect(source).not.toMatch(/startToCloseTimeout:\s*"/);
	});

	it("budgets one source no less than the lock helper can take", () => {
		expect(
			CHATGPT_PLAN_SOURCE_SWEEP_SOURCE_WORST_CASE_MS,
		).toBeGreaterThanOrEqual(chatGptPlanSourceSweepSourceWorstCaseMs());
	});

	it("names a workflow the workflows barrel actually exports", async () => {
		const workflows = await import("../src/workflows");
		expect(Object.keys(workflows)).toContain(
			CHATGPT_PLAN_SOURCE_SWEEP_WORKFLOW_NAME,
		);
	});

	it("names an activity the top-level activities barrel registers, and only it", async () => {
		const activities = await import("../src/activities");
		expect(Object.keys(activities)).toContain(
			"sweepChatGptPlanSourceRowsActivity",
		);
		// The budget constants are not something a worker may schedule.
		expect(
			Object.keys(activities).filter((name) =>
				name.startsWith("CHATGPT_PLAN_SOURCE_SWEEP"),
			),
		).toEqual([]);
	});

	it("treats an already-registered schedule as success, not a startup failure", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new FakeScheduleAlreadyRunning("exists"));
		await expect(
			registerChatGptPlanSourceSweepSchedule(fakeClient(create)),
		).resolves.toBeUndefined();
	});

	it("rethrows any other registration failure instead of swallowing it", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new Error("namespace not found"));
		await expect(
			registerChatGptPlanSourceSweepSchedule(fakeClient(create)),
		).rejects.toThrow("namespace not found");
	});

	it("appears in the registry — registerSystemSchedules actually invokes it", async () => {
		await registerSystemSchedules();

		const ids = scheduleCreate.mock.calls.map(
			(call) => (call[0] as { scheduleId: string }).scheduleId,
		);
		expect(ids).toContain(CHATGPT_PLAN_SOURCE_SWEEP_SCHEDULE_ID);
	});
});
