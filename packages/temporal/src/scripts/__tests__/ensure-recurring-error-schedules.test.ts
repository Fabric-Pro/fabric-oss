/**
 * Recurring-error detection only runs if its sweep is scheduled. This invokes
 * the real bootstrap against a fake ScheduleClient and checks what it creates,
 * and that the workflow it names is one the worker actually registers.
 */
import { ScheduleAlreadyRunning } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as workflows from "../../workflows/recurring-error-scan";
import {
	ensureRecurringErrorSchedules,
	RECURRING_ERROR_SCAN_SCHEDULE,
} from "../ensure-recurring-error-schedules";

const create = vi.fn();
const scheduleClient = { create } as unknown as Parameters<
	typeof ensureRecurringErrorSchedules
>[0];

beforeEach(() => {
	vi.clearAllMocks();
	create.mockResolvedValue(undefined);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("ensureRecurringErrorSchedules", () => {
	it("registers the twice-daily sweep, unpaused, without stacking ticks", async () => {
		await ensureRecurringErrorSchedules(scheduleClient);

		expect(create).toHaveBeenCalledOnce();
		expect(create.mock.calls[0][0]).toMatchObject({
			scheduleId: "recurring-error-scan",
			spec: { cronExpressions: ["20 1,13 * * *"] },
			action: {
				type: "startWorkflow",
				workflowType: "recurringErrorSweepWorkflow",
				taskQueue: "fabric-worker",
			},
			policies: { overlap: "SKIP", catchupWindow: "1 hour" },
			state: { paused: false },
		});
	});

	it("names a workflow the worker exports", () => {
		expect(Object.keys(workflows)).toContain(
			RECURRING_ERROR_SCAN_SCHEDULE.workflowType,
		);
	});

	it("treats an existing schedule as done", async () => {
		create.mockRejectedValue(
			new ScheduleAlreadyRunning("exists", "recurring-error-scan"),
		);

		await expect(
			ensureRecurringErrorSchedules(scheduleClient),
		).resolves.toBeUndefined();
	});

	it("surfaces any other registration failure", async () => {
		create.mockRejectedValue(new Error("permission denied"));

		await expect(
			ensureRecurringErrorSchedules(scheduleClient),
		).rejects.toThrow("permission denied");
	});
});
