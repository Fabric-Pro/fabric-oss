import {
	type ScheduleClient,
	ScheduleNotFoundError,
	ServiceError,
} from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import { retireAgentExecutionReceiptRecoverySchedule } from "../src/schedules/agent-execution-receipt-recovery";

describe("retiring periodic agent receipt observation", () => {
	it("pauses the old observer without creating or deleting workflow history", async () => {
		const pause = vi.fn();
		const getHandle = vi.fn(() => ({ pause }));
		await retireAgentExecutionReceiptRecoverySchedule({
			getHandle,
		} as unknown as ScheduleClient);
		expect(getHandle).toHaveBeenCalledWith(
			"agent-execution-receipt-recovery",
		);
		expect(pause).toHaveBeenCalledWith(
			expect.stringContaining("Native agent workflows"),
		);
	});
	it("does not create the old schedule on a new installation", async () => {
		const pause = vi
			.fn()
			.mockRejectedValue(
				new ScheduleNotFoundError(
					"absent",
					"agent-execution-receipt-recovery",
				),
			);
		await expect(
			retireAgentExecutionReceiptRecoverySchedule({
				getHandle: () => ({ pause }),
			} as unknown as ScheduleClient),
		).resolves.toBeUndefined();
	});
	it("does not hide a transport failure as a retired schedule", async () => {
		const pause = vi.fn().mockRejectedValue(new Error("unavailable"));
		await expect(
			retireAgentExecutionReceiptRecoverySchedule({
				getHandle: () => ({ pause }),
			} as unknown as ScheduleClient),
		).rejects.toThrow("unavailable");
	});
	it("recognizes a wrapped missing schedule without creating a replacement", async () => {
		const pause = vi.fn().mockRejectedValue(
			new ServiceError("not found", {
				cause: Object.assign(new Error("status"), {
					code: 5,
					details: "status",
					metadata: {},
				}),
			}),
		);
		await expect(
			retireAgentExecutionReceiptRecoverySchedule({
				getHandle: () => ({ pause }),
			} as unknown as ScheduleClient),
		).resolves.toBeUndefined();
	});
});
