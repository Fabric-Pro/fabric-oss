/**
 * Registration guard for the scheduled code index refresh poll (spec
 * 2026-10-29 code-index-sync): a wrong payload is silent in production.
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

import {
	CODE_INDEX_REFRESH_POLL_CRON_SCHEDULE,
	CODE_INDEX_REFRESH_POLL_EXECUTION_TIMEOUT_MS,
	CODE_INDEX_REFRESH_POLL_SCHEDULE_ID,
	CODE_INDEX_REFRESH_POLL_WORKFLOW_NAME,
	registerCodeIndexRefreshPollSchedule,
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

describe("the code index refresh poll schedule", () => {
	it("creates the schedule with exactly this payload: fabric-worker, overlap SKIP", async () => {
		await registerCodeIndexRefreshPollSchedule(fakeClient());
		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: CODE_INDEX_REFRESH_POLL_SCHEDULE_ID,
			spec: { cronExpressions: [CODE_INDEX_REFRESH_POLL_CRON_SCHEDULE] },
			action: {
				type: "startWorkflow",
				workflowType: CODE_INDEX_REFRESH_POLL_WORKFLOW_NAME,
				taskQueue: "fabric-worker",
				args: [],
				workflowExecutionTimeout:
					CODE_INDEX_REFRESH_POLL_EXECUTION_TIMEOUT_MS,
			},
			policies: { overlap: "SKIP", catchupWindow: "15 minutes" },
			state: {
				paused: false,
				note: expect.stringContaining("changed"),
			},
		});
	});

	it("ends a run before the next tick, so overlap SKIP never swallows one", () => {
		expect(CODE_INDEX_REFRESH_POLL_EXECUTION_TIMEOUT_MS).toBeLessThan(
			cronIntervalMs(CODE_INDEX_REFRESH_POLL_CRON_SCHEDULE),
		);
	});

	it("names a workflow the workflows barrel exports", async () => {
		const workflows = await import("../src/workflows");
		expect(Object.keys(workflows)).toContain(
			CODE_INDEX_REFRESH_POLL_WORKFLOW_NAME,
		);
	});

	it("treats an existing schedule as registered", async () => {
		scheduleCreate.mockRejectedValueOnce(new FakeScheduleAlreadyRunning());
		await expect(
			registerCodeIndexRefreshPollSchedule(fakeClient()),
		).resolves.toBeUndefined();
	});
});
