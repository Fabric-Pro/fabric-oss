/**
 * A session a lost alarm strands in LEAVING is finalized without anyone
 * opening its page only if the sweep is scheduled. This invokes the real
 * bootstrap against a fake ScheduleClient and checks what it creates, and
 * that the workflow it names exists.
 */
import { ScheduleAlreadyRunning } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as workflows from "../../workflows/parlume-sweep";
import {
	ensureParlumeSweepSchedule,
	PARLUME_SESSION_SWEEP_SCHEDULE,
} from "../ensure-parlume-sweep-schedule";

const create = vi.fn();
const scheduleClient = { create } as unknown as Parameters<
	typeof ensureParlumeSweepSchedule
>[0];

beforeEach(() => {
	vi.clearAllMocks();
	create.mockResolvedValue(undefined);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("ensureParlumeSweepSchedule", () => {
	it("registers the ten-minute sweep, unpaused, without stacking ticks", async () => {
		await ensureParlumeSweepSchedule(scheduleClient);

		expect(create).toHaveBeenCalledOnce();
		expect(create.mock.calls[0][0]).toMatchObject({
			scheduleId: "parlume-session-sweep",
			spec: { cronExpressions: ["*/10 * * * *"] },
			action: {
				type: "startWorkflow",
				workflowType: "parlumeSessionSweepWorkflow",
				taskQueue: "fabric-worker",
			},
			policies: { overlap: "SKIP" },
			state: { paused: false },
		});
	});

	it("names the sweep workflow", () => {
		expect(Object.keys(workflows)).toContain(
			PARLUME_SESSION_SWEEP_SCHEDULE.workflowType,
		);
	});

	it("treats an existing schedule as done", async () => {
		create.mockRejectedValue(
			new ScheduleAlreadyRunning("exists", "parlume-session-sweep"),
		);

		await expect(
			ensureParlumeSweepSchedule(scheduleClient),
		).resolves.toBeUndefined();
	});
});
