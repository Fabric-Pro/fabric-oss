/**
 * The builder has offered a "Schedule" trigger since it shipped, and nothing
 * ever created a schedule — choosing it silently did nothing. These cover the
 * pieces that make it real: reading the cron off the trigger node, deriving a
 * stable schedule id, and create/update/delete against Temporal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildWorkflowScheduleId,
	deleteWorkflowSchedule,
	findScheduleCron,
	isPlausibleCron,
	parseWorkflowIdFromScheduleId,
	upsertWorkflowSchedule,
	WORKFLOW_BUILDER_SCHEDULE_PREFIX,
} from "../workflow-builder-schedule";

function triggerNode(config: Record<string, unknown>) {
	return { id: "n1", type: "trigger", data: { config } };
}

describe("schedule id", () => {
	it("derives from the workflow id, so the two cannot drift", () => {
		expect(buildWorkflowScheduleId("wf_123")).toBe(
			`${WORKFLOW_BUILDER_SCHEDULE_PREFIX}wf_123`,
		);
	});

	it("round-trips", () => {
		const id = buildWorkflowScheduleId("wf_123");
		expect(parseWorkflowIdFromScheduleId(id)).toBe("wf_123");
	});

	it("ignores schedules this module does not own", () => {
		expect(parseWorkflowIdFromScheduleId("url-source-abc")).toBeNull();
		expect(
			parseWorkflowIdFromScheduleId(WORKFLOW_BUILDER_SCHEDULE_PREFIX),
		).toBeNull();
	});
});

describe("findScheduleCron", () => {
	it("reads the cron off a schedule trigger", () => {
		expect(
			findScheduleCron([
				triggerNode({
					triggerType: "schedule",
					scheduleCron: "0 9 * * *",
				}),
			]),
		).toBe("0 9 * * *");
	});

	it("accepts the scheduleExpression spelling the AI generator emits", () => {
		expect(
			findScheduleCron([
				triggerNode({
					triggerType: "schedule",
					scheduleExpression: "*/5 * * * *",
				}),
			]),
		).toBe("*/5 * * * *");
	});

	it("returns null for a trigger that is not a schedule", () => {
		expect(
			findScheduleCron([
				triggerNode({
					triggerType: "manual",
					scheduleCron: "0 9 * * *",
				}),
			]),
		).toBeNull();
	});

	it("returns null for a schedule trigger with no expression", () => {
		expect(
			findScheduleCron([triggerNode({ triggerType: "schedule" })]),
		).toBeNull();
		expect(
			findScheduleCron([
				triggerNode({ triggerType: "schedule", scheduleCron: "   " }),
			]),
		).toBeNull();
	});

	it("tolerates malformed node arrays", () => {
		expect(findScheduleCron(null)).toBeNull();
		expect(findScheduleCron("nope")).toBeNull();
		expect(findScheduleCron([null, 42, {}])).toBeNull();
	});
});

describe("isPlausibleCron", () => {
	it("accepts five- and six-field expressions", () => {
		expect(isPlausibleCron("0 9 * * *")).toBe(true);
		expect(isPlausibleCron("0 0 9 * * 1-5")).toBe(true);
		expect(isPlausibleCron("*/15 * * * *")).toBe(true);
	});

	it("rejects prose and wrong field counts", () => {
		expect(isPlausibleCron("every morning")).toBe(false);
		expect(isPlausibleCron("0 9 * *")).toBe(false);
		expect(isPlausibleCron("0 0 0 9 * * 1 2")).toBe(false);
		expect(isPlausibleCron("")).toBe(false);
	});
});

describe("upsertWorkflowSchedule", () => {
	const createMock = vi.fn();
	const updateMock = vi.fn();
	const client = {
		create: createMock,
		getHandle: () => ({ update: updateMock, delete: vi.fn() }),
	} as never;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates a schedule on the workflow-builder task queue", async () => {
		createMock.mockResolvedValue(undefined);

		const result = await upsertWorkflowSchedule(
			{ workflowId: "wf_1", cron: "0 9 * * *", userId: "user_1" },
			client,
		);

		expect(result).toEqual({
			scheduleId: "workflow-builder-wf_1",
			created: true,
		});
		const arg = createMock.mock.calls[0][0];
		expect(arg.spec.cronExpressions).toEqual(["0 9 * * *"]);
		expect(arg.action.taskQueue).toBe("workflow-builder");
		// The kickoff workflow, never the executor directly. The executor needs
		// a WorkflowExecution row id and a Schedule's arguments are fixed at
		// creation, so it cannot carry a per-fire one — pointing the schedule
		// at the executor meant every tick ran with an undefined id, updated
		// nothing, and left no trace in the run history.
		expect(arg.action.workflowType).toBe("scheduledWorkflowKickoff");
		// SKIP, so a slow run does not stack up fires with external effects.
		expect(arg.policies.overlap).toBe("SKIP");
	});

	it("updates in place when the schedule already exists", async () => {
		const already = new Error("schedule already running");
		already.name = "ScheduleAlreadyRunning";
		createMock.mockRejectedValue(already);
		updateMock.mockImplementation(async (fn: (p: unknown) => unknown) =>
			fn({ spec: { cronExpressions: ["0 1 * * *"] } }),
		);

		const result = await upsertWorkflowSchedule(
			{ workflowId: "wf_1", cron: "0 9 * * *", userId: "user_1" },
			client,
		);

		expect(result.created).toBe(false);
		expect(updateMock).toHaveBeenCalledOnce();
	});

	it("refuses an implausible cron before touching Temporal", async () => {
		await expect(
			upsertWorkflowSchedule(
				{ workflowId: "wf_1", cron: "every morning", userId: "user_1" },
				client,
			),
		).rejects.toThrow(/Invalid cron/);
		expect(createMock).not.toHaveBeenCalled();
	});
});

describe("deleteWorkflowSchedule", () => {
	it("reports deletion", async () => {
		const del = vi.fn().mockResolvedValue(undefined);
		const client = { getHandle: () => ({ delete: del }) } as never;

		expect(await deleteWorkflowSchedule("wf_1", client)).toEqual({
			deleted: true,
		});
	});

	it("is safe when there is no schedule", async () => {
		const notFound = new Error("schedule not found");
		notFound.name = "ScheduleNotFoundError";
		const client = {
			getHandle: () => ({
				delete: vi.fn().mockRejectedValue(notFound),
			}),
		} as never;

		expect(await deleteWorkflowSchedule("wf_1", client)).toEqual({
			deleted: false,
		});
	});

	it("surfaces an unexpected failure rather than swallowing it", async () => {
		const client = {
			getHandle: () => ({
				delete: vi
					.fn()
					.mockRejectedValue(new Error("permission denied")),
			}),
		} as never;

		await expect(deleteWorkflowSchedule("wf_1", client)).rejects.toThrow(
			/permission denied/,
		);
	});
});
