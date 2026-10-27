/**
 * Parlume auto-join only happens if its planner is scheduled. This invokes the
 * real bootstrap against a fake ScheduleClient and checks what it creates, and
 * that the workflows it relies on are ones the worker actually registers.
 */
import { ScheduleAlreadyRunning } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as workflows from "../../workflows/parlume-auto-join";
import {
	ensureParlumeAutoJoinSchedule,
	PARLUME_AUTO_JOIN_PLANNER_SCHEDULE,
} from "../ensure-parlume-auto-join-schedule";

const create = vi.fn();
const scheduleClient = { create } as unknown as Parameters<
	typeof ensureParlumeAutoJoinSchedule
>[0];

beforeEach(() => {
	vi.clearAllMocks();
	create.mockResolvedValue(undefined);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("ensureParlumeAutoJoinSchedule", () => {
	it("registers the five-minute planner, unpaused, without stacking ticks", async () => {
		await ensureParlumeAutoJoinSchedule(scheduleClient);

		expect(create).toHaveBeenCalledOnce();
		expect(create.mock.calls[0][0]).toMatchObject({
			scheduleId: "parlume-auto-join-planner",
			spec: { cronExpressions: ["*/5 * * * *"] },
			action: {
				type: "startWorkflow",
				workflowType: "parlumeAutoJoinPlannerWorkflow",
				taskQueue: "fabric-worker",
			},
			policies: { overlap: "SKIP" },
			state: { paused: false },
		});
	});

	it("names workflows the worker exports, the planner and the join it starts", () => {
		expect(Object.keys(workflows)).toEqual(
			expect.arrayContaining([
				PARLUME_AUTO_JOIN_PLANNER_SCHEDULE.workflowType,
				"parlumeAutoJoinOccurrenceWorkflow",
			]),
		);
	});

	it("treats an existing schedule as done", async () => {
		create.mockRejectedValue(
			new ScheduleAlreadyRunning("exists", "parlume-auto-join-planner"),
		);

		await expect(
			ensureParlumeAutoJoinSchedule(scheduleClient),
		).resolves.toBeUndefined();
	});
});
