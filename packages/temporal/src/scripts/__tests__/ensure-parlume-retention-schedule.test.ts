/**
 * Parlume transcripts are deleted after 90 days only if the sweep is
 * scheduled. This invokes the real bootstrap against a fake ScheduleClient and
 * checks what it creates, and that the workflow it starts is one the worker
 * registers.
 */
import { ScheduleAlreadyRunning } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as workflows from "../../workflows/parlume-retention";
import {
	ensureParlumeRetentionSchedule,
	PARLUME_TRANSCRIPT_RETENTION_SCHEDULE,
} from "../ensure-parlume-retention-schedule";

const create = vi.fn();
const scheduleClient = { create } as unknown as Parameters<
	typeof ensureParlumeRetentionSchedule
>[0];

beforeEach(() => {
	vi.clearAllMocks();
	create.mockResolvedValue(undefined);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("ensureParlumeRetentionSchedule", () => {
	it("registers the hourly sweep, unpaused, without stacking runs", async () => {
		await ensureParlumeRetentionSchedule(scheduleClient);

		expect(create).toHaveBeenCalledOnce();
		expect(create.mock.calls[0][0]).toMatchObject({
			scheduleId: "parlume-transcript-retention",
			spec: { cronExpressions: ["35 * * * *"] },
			action: {
				type: "startWorkflow",
				workflowType: "parlumeTranscriptRetentionWorkflow",
				taskQueue: "fabric-worker",
			},
			policies: { overlap: "SKIP" },
			state: { paused: false },
		});
	});

	it("names a workflow the worker exports", () => {
		expect(Object.keys(workflows)).toContain(
			PARLUME_TRANSCRIPT_RETENTION_SCHEDULE.workflowType,
		);
	});

	it("treats an existing schedule as done", async () => {
		create.mockRejectedValue(
			new ScheduleAlreadyRunning(
				"exists",
				"parlume-transcript-retention",
			),
		);

		await expect(
			ensureParlumeRetentionSchedule(scheduleClient),
		).resolves.toBeUndefined();
	});
});
