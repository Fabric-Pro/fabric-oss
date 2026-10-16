/**
 * The builder has offered a "Schedule" trigger since it shipped, and nothing
 * ever created a schedule — choosing it silently did nothing. These cover the
 * pieces that make it real: reading the cron off the trigger node, deriving a
 * stable schedule id, and create/update/delete against Temporal.
 */

import { msToNumber } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildWorkflowScheduleId,
	deleteWorkflowSchedule,
	findScheduleCron,
	findScheduleTimezone,
	isPlausibleCron,
	isValidScheduleTimeZone,
	parseWorkflowIdFromScheduleId,
	SCHEDULE_JITTER,
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

	describe("time zone", () => {
		it("reads the cron in the zone the trigger names", async () => {
			createMock.mockResolvedValue(undefined);

			await upsertWorkflowSchedule(
				{
					workflowId: "wf_1",
					cron: "0 9 * * 1",
					timezone: "Europe/Berlin",
					userId: "user_1",
				},
				client,
			);

			expect(createMock.mock.calls[0][0].spec).toMatchObject({
				cronExpressions: ["0 9 * * 1"],
				timezone: "Europe/Berlin",
			});
		});

		it("leaves the zone off when none was set, so the cron stays in UTC as before", async () => {
			createMock.mockResolvedValue(undefined);

			await upsertWorkflowSchedule(
				{ workflowId: "wf_1", cron: "0 9 * * *", userId: "user_1" },
				client,
			);
			await upsertWorkflowSchedule(
				{
					workflowId: "wf_2",
					cron: "0 9 * * *",
					timezone: null,
					userId: "user_1",
				},
				client,
			);

			for (const [call] of createMock.mock.calls) {
				expect(call.spec).not.toHaveProperty("timezone");
			}
		});

		it("moves an existing schedule to the new zone in place", async () => {
			const already = new Error("schedule already running");
			already.name = "ScheduleAlreadyRunning";
			createMock.mockRejectedValue(already);
			let updated: { spec: Record<string, unknown> } | undefined;
			updateMock.mockImplementation(async (fn: (p: unknown) => never) => {
				updated = fn({
					spec: {
						cronExpressions: ["0 1 * * *"],
						timezone: "Asia/Tokyo",
					},
				});
			});

			await upsertWorkflowSchedule(
				{
					workflowId: "wf_1",
					cron: "0 9 * * *",
					timezone: "America/New_York",
					userId: "user_1",
				},
				client,
			);

			expect(updated?.spec).toMatchObject({
				cronExpressions: ["0 9 * * *"],
				timezone: "America/New_York",
			});
		});

		it("drops a zone the trigger no longer names when the schedule is updated", async () => {
			const already = new Error("schedule already running");
			already.name = "ScheduleAlreadyRunning";
			createMock.mockRejectedValue(already);
			let updated: { spec: Record<string, unknown> } | undefined;
			updateMock.mockImplementation(async (fn: (p: unknown) => never) => {
				updated = fn({
					spec: {
						cronExpressions: ["0 1 * * *"],
						timezone: "Asia/Tokyo",
					},
				});
			});

			await upsertWorkflowSchedule(
				{ workflowId: "wf_1", cron: "0 9 * * *", userId: "user_1" },
				client,
			);

			expect(updated?.spec).not.toHaveProperty("timezone");
		});

		it("refuses an unknown zone before touching Temporal", async () => {
			await expect(
				upsertWorkflowSchedule(
					{
						workflowId: "wf_1",
						cron: "0 9 * * *",
						timezone: "Mars/Phobos",
						userId: "user_1",
					},
					client,
				),
			).rejects.toThrow(/Invalid time zone/);
			expect(createMock).not.toHaveBeenCalled();
		});
	});

	describe("firing policy", () => {
		it("spreads fires with a small jitter, on create and on update", async () => {
			createMock.mockResolvedValue(undefined);
			await upsertWorkflowSchedule(
				{ workflowId: "wf_1", cron: "0 9 * * *", userId: "user_1" },
				client,
			);
			expect(createMock.mock.calls[0][0].spec.jitter).toBe(
				SCHEDULE_JITTER,
			);

			const already = new Error("schedule already running");
			already.name = "ScheduleAlreadyRunning";
			createMock.mockRejectedValue(already);
			let updated: { spec: Record<string, unknown> } | undefined;
			updateMock.mockImplementation(async (fn: (p: unknown) => never) => {
				updated = fn({ spec: { cronExpressions: ["0 1 * * *"] } });
			});
			await upsertWorkflowSchedule(
				{ workflowId: "wf_1", cron: "0 9 * * *", userId: "user_1" },
				client,
			);
			expect(updated?.spec.jitter).toBe(SCHEDULE_JITTER);
		});

		it("keeps a jitter far below the shortest interval a schedule may have", () => {
			expect(msToNumber(SCHEDULE_JITTER)).toBeLessThanOrEqual(60_000);
		});

		it("keeps the skip-overlap and catch-up policies", async () => {
			createMock.mockResolvedValue(undefined);

			await upsertWorkflowSchedule(
				{
					workflowId: "wf_1",
					cron: "0 9 * * *",
					timezone: "Europe/Berlin",
					userId: "user_1",
				},
				client,
			);

			expect(createMock.mock.calls[0][0].policies).toEqual({
				overlap: "SKIP",
				catchupWindow: "1 hour",
			});
		});
	});
});

describe("findScheduleTimezone", () => {
	it("reads the zone off the same schedule trigger as the cron", () => {
		expect(
			findScheduleTimezone([
				triggerNode({
					triggerType: "schedule",
					scheduleCron: "0 9 * * *",
					scheduleTimezone: "Europe/Berlin",
				}),
			]),
		).toBe("Europe/Berlin");
	});

	it("is null for a workflow saved before the field existed", () => {
		expect(
			findScheduleTimezone([
				triggerNode({
					triggerType: "schedule",
					scheduleCron: "0 9 * * *",
				}),
			]),
		).toBeNull();
	});

	it("ignores a blank value and a zone on a trigger that is not a schedule", () => {
		expect(
			findScheduleTimezone([
				triggerNode({
					triggerType: "schedule",
					scheduleCron: "0 9 * * *",
					scheduleTimezone: "   ",
				}),
			]),
		).toBeNull();
		expect(
			findScheduleTimezone([
				triggerNode({
					triggerType: "manual",
					scheduleCron: "0 9 * * *",
					scheduleTimezone: "Europe/Berlin",
				}),
			]),
		).toBeNull();
	});

	it("takes the zone from the trigger that supplies the cron", () => {
		expect(
			findScheduleTimezone([
				triggerNode({
					triggerType: "schedule",
					scheduleTimezone: "Asia/Tokyo",
				}),
				triggerNode({
					triggerType: "schedule",
					scheduleCron: "0 9 * * *",
					scheduleTimezone: "Europe/Berlin",
				}),
			]),
		).toBe("Europe/Berlin");
	});

	it("tolerates malformed node arrays", () => {
		expect(findScheduleTimezone(null)).toBeNull();
		expect(findScheduleTimezone([null, 42, {}])).toBeNull();
	});
});

describe("isValidScheduleTimeZone", () => {
	it.each([
		"UTC",
		"Europe/Berlin",
		"America/New_York",
		"America/Argentina/Buenos_Aires",
		"Asia/Kolkata",
	])("accepts %s", (zone) => {
		expect(isValidScheduleTimeZone(zone)).toBe(true);
	});

	it.each([
		["a UTC offset", "+01:00"],
		["a made-up zone", "Mars/Phobos"],
		["a wrongly cased name, which Temporal would refuse", "europe/berlin"],
		["lowercase utc", "utc"],
		["an empty string", ""],
		["a trailing slash", "Europe/"],
		["prose", "central european time"],
	])("rejects %s", (_label, zone) => {
		expect(isValidScheduleTimeZone(zone)).toBe(false);
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
