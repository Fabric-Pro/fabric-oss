/**
 * Schedule sync must never break the operation that triggered it.
 *
 * Publish, unpublish, update and delete all call this. If Temporal is down, or
 * the cron is malformed, the user's publish must still succeed — the workflow
 * row is the source of truth and the reconciler repairs drift. A publish that
 * fails because a schedule could not be written would be a worse outcome than
 * a schedule that lands late.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsertMock, deleteMock, availableMock, getScheduleClientMock } =
	vi.hoisted(() => ({
		upsertMock: vi.fn(),
		deleteMock: vi.fn(),
		availableMock: vi.fn(),
		getScheduleClientMock: vi.fn(async () => ({}) as never),
	}));

vi.mock("@repo/temporal", async () => {
	// Keep the real pure helpers (findScheduleCron, isPlausibleCron) — they are
	// part of what is under test — and stub only the Temporal-touching ones.
	const actual =
		await vi.importActual<typeof import("@repo/temporal")>(
			"@repo/temporal",
		);
	return {
		findScheduleCron: actual.findScheduleCron,
		isPlausibleCron: actual.isPlausibleCron,
		isTemporalAvailable: availableMock,
		getScheduleClient: getScheduleClientMock,
		upsertWorkflowSchedule: upsertMock,
		deleteWorkflowSchedule: deleteMock,
	};
});

import { syncWorkflowSchedule } from "../sync-workflow-schedule";

const scheduleNodes = [
	{
		id: "n1",
		type: "trigger",
		data: {
			config: { triggerType: "schedule", scheduleCron: "0 9 * * *" },
		},
	},
];

const manualNodes = [
	{ id: "n1", type: "trigger", data: { config: { triggerType: "manual" } } },
];

function sync(overrides: Record<string, unknown> = {}) {
	return syncWorkflowSchedule({
		workflowId: "wf_1",
		nodes: scheduleNodes,
		userId: "user_1",
		active: true,
		...overrides,
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	availableMock.mockResolvedValue(true);
	upsertMock.mockResolvedValue({ scheduleId: "s", created: true });
	deleteMock.mockResolvedValue({ deleted: true });
});

describe("syncWorkflowSchedule", () => {
	it("creates a schedule for an active workflow with a cron", async () => {
		const result = await sync();

		expect(result).toEqual({ outcome: "created", cron: "0 9 * * *" });
		expect(upsertMock).toHaveBeenCalledOnce();
	});

	it("removes the schedule when the workflow is no longer active", async () => {
		const result = await sync({ active: false });

		expect(result).toEqual({ outcome: "deleted" });
		expect(deleteMock).toHaveBeenCalledOnce();
		expect(upsertMock).not.toHaveBeenCalled();
	});

	it("removes the schedule when the trigger is switched away from Schedule", async () => {
		const result = await sync({ nodes: manualNodes });

		expect(result).toEqual({ outcome: "deleted" });
		expect(upsertMock).not.toHaveBeenCalled();
	});

	it("reports a malformed cron instead of writing it", async () => {
		const result = await sync({
			nodes: [
				{
					id: "n1",
					type: "trigger",
					data: {
						config: {
							triggerType: "schedule",
							scheduleCron: "every morning",
						},
					},
				},
			],
		});

		expect(result.outcome).toBe("failed");
		expect(upsertMock).not.toHaveBeenCalled();
	});

	it("does not throw when Temporal is unavailable", async () => {
		availableMock.mockResolvedValue(false);

		const result = await sync();

		expect(result.outcome).toBe("none");
		expect(upsertMock).not.toHaveBeenCalled();
	});

	it("does not throw when the schedule write fails", async () => {
		upsertMock.mockRejectedValue(new Error("temporal exploded"));

		const result = await sync();

		expect(result).toEqual({
			outcome: "failed",
			reason: "temporal exploded",
		});
	});
});
