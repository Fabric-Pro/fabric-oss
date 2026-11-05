import { beforeEach, describe, expect, it, vi } from "vitest";
import liveDescription from "./fixtures/managed-schedule-description.json";

const m = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findUnique: vi.fn(),
	upsert: vi.fn(),
	updateRow: vi.fn(),
	describe: vi.fn(),
	update: vi.fn(),
	create: vi.fn(),
	client: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentDeploymentTrigger: {
			findFirst: m.findFirst,
			findUnique: m.findUnique,
			upsert: m.upsert,
			update: m.updateRow,
		},
	},
}));
vi.mock("@repo/temporal", () => ({
	getScheduleClient: m.client,
	ScheduleNotFoundError: class extends Error {},
	ScheduleAlreadyRunning: class extends Error {},
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (v: unknown) => v,
}));

import {
	buildManagedRunCalendar,
	readManagedRunSchedule,
	saveManagedRunSchedule,
} from "../managed-run-schedule";

const actor = { userId: "example-user", organizationId: "example-org" };
const input = {
	...actor,
	deploymentId: "example-deployment",
	cronExpression: "15 9 * * *",
	timezone: "UTC",
	input: { message: "Create a delivery report" },
	enabled: true,
};
const trigger = {
	...actor,
	id: "fabric-run-schedule-example-deployment",
	deploymentId: input.deploymentId,
	cronExpression: input.cronExpression,
	timezone: "UTC",
	isActive: true,
	config: { fabricManagedRunSchedule: 1, inputTemplate: input.input },
};
function description(overrides: Record<string, unknown> = {}) {
	const calendar = buildManagedRunCalendar(
		input.cronExpression,
		input.timezone,
	);
	const ranges = (values: readonly unknown[]) =>
		values.map((start) => ({ start, end: start, step: 1 }));
	return {
		action: {
			type: "startWorkflow",
			workflowType: "managedAgentRunScheduleWorkflow",
			taskQueue: "agents",
			args: [
				{
					managedRunSchedule: 1,
					triggerType: "SCHEDULE",
					triggerId: trigger.id,
					deploymentId: trigger.deploymentId,
					...actor,
				},
			],
		},
		spec: {
			timezone: "UTC",
			calendars: [
				{
					...Object.fromEntries(
						Object.entries(calendar)
							.filter(([key]) => key !== "year")
							.map(([key, values]) => [
								key,
								ranges(values as unknown[]),
							]),
					),
					year: [],
				},
			],
		},
		state: { paused: false },
		...overrides,
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	m.findFirst.mockResolvedValue(trigger);
	m.findUnique.mockResolvedValue(trigger);
	m.upsert.mockResolvedValue(trigger);
	m.client.mockResolvedValue({
		getHandle: () => ({ describe: m.describe, update: m.update }),
		create: m.create,
	});
	m.describe.mockResolvedValue(description());
	m.update.mockImplementation(async (callback) => callback(description()));
});
describe("managed agent schedules", () => {
	it.each(["queue", "triggerType"])(
		"does not report ACTIVE for drifted native routing: %s",
		async (drift) => {
			const observed = description();
			if (drift === "queue") {
				observed.action.taskQueue = "unpolled-example-queue";
			} else {
				observed.action.args[0].triggerType = "MANUAL";
			}
			m.describe.mockResolvedValue(observed);
			expect(
				await readManagedRunSchedule(input.deploymentId, actor),
			).toMatchObject({ schedulingState: "UNKNOWN" });
		},
	);
	it("keeps the real Prisma readback filter limited to the owner/deployment tuple", async () => {
		m.findFirst.mockImplementation(async ({ where }) => {
			expect(where).toEqual({
				id: trigger.id,
				deploymentId: input.deploymentId,
				userId: actor.userId,
				organizationId: actor.organizationId,
			});
			return trigger;
		});
		const onSaved = vi.fn();
		expect(
			await saveManagedRunSchedule({ ...input, onSaved }),
		).toMatchObject({ schedulingState: "ACTIVE" });
		expect(onSaved).toHaveBeenCalledOnce();
		// TypeScript allows a structural subtype here; the helper must still pick only actor identity.
		const structuralActor = { ...input, onSaved };
		await readManagedRunSchedule(input.deploymentId, structuralActor);
	});
	it("accepts the actual SDK description of the explicit single-date UTC calendar", async () => {
		m.findFirst.mockResolvedValue({
			...trigger,
			cronExpression: "15 20 3 11 *",
		});
		m.describe.mockResolvedValue(liveDescription);
		expect(
			await readManagedRunSchedule(input.deploymentId, actor),
		).toMatchObject({ schedulingState: "ACTIVE" });
	});
	it("compiles explicit seconds, weekdays and named months without relying on Temporal cron defaults", () => {
		expect(buildManagedRunCalendar("0 */10 * * * *", "UTC").second).toEqual(
			[0],
		);
		expect(buildManagedRunCalendar("0 9 * JAN MON", "UTC")).toMatchObject({
			month: ["JANUARY"],
			dayOfWeek: ["MONDAY"],
		});
	});
	it.each([
		["* * * *", "UTC"],
		["0 9 1 * MON", "UTC"],
		["0 9 * * *", "invalid/timezone"],
	])(
		"rejects unsupported calendar before mutation: %s",
		async (cronExpression, timezone) => {
			await expect(
				saveManagedRunSchedule({ ...input, cronExpression, timezone }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.upsert).not.toHaveBeenCalled();
		},
	);
	it("does not create anything while reading empty configuration", async () => {
		m.findFirst.mockResolvedValue(null);
		expect(await readManagedRunSchedule(input.deploymentId, actor)).toEqual(
			{ schedule: null, schedulingState: "UNKNOWN" },
		);
		expect(m.client).not.toHaveBeenCalled();
		expect(m.upsert).not.toHaveBeenCalled();
	});
	it("returns observed paused engine state, rather than persisted enabled alone", async () => {
		m.describe.mockResolvedValue(description({ state: { paused: true } }));
		expect(
			await readManagedRunSchedule(input.deploymentId, actor),
		).toMatchObject({
			schedulingState: "PAUSED",
			schedule: { enabled: false },
		});
	});
	it("returns unknown if compiled calendar or native identity differs", async () => {
		m.describe.mockResolvedValue(
			description({
				action: {
					type: "startWorkflow",
					workflowType: "scheduleTriggerWorkflow",
					args: [],
				},
			}),
		);
		expect(
			await readManagedRunSchedule(input.deploymentId, actor),
		).toMatchObject({ schedulingState: "UNKNOWN" });
	});
	it.each([
		{ userId: "another-user" },
		{ organizationId: "another-org" },
		{ deploymentId: "another-deployment" },
		{ config: { name: "advanced-trigger" } },
	])("does not overwrite foreign or unmanaged rows: %j", async (patch) => {
		m.findUnique.mockResolvedValue({ ...trigger, ...patch });
		await expect(saveManagedRunSchedule(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(m.upsert).not.toHaveBeenCalled();
		expect(m.update).not.toHaveBeenCalled();
	});
	it("fences database write and the schedule update callback independently", async () => {
		await saveManagedRunSchedule(input);
		expect(m.upsert.mock.calls[0][0].where).toEqual({
			id: trigger.id,
			deploymentId: trigger.deploymentId,
			...actor,
			config: { equals: trigger.config },
		});
		expect(m.update).toHaveBeenCalledOnce();
		const update = m.update.mock.calls[0][0];
		expect(() =>
			update(
				description({
					action: {
						type: "startWorkflow",
						workflowType: "anotherWorkflow",
						args: [],
					},
				}),
			),
		).toThrow("Schedule ownership changed");
	});
	it("reconciles one stable native schedule and never silently reports success during outage", async () => {
		m.describe.mockRejectedValue(new Error("unavailable"));
		await expect(saveManagedRunSchedule(input)).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			data: { scheduleSaved: true, schedulingState: "UNKNOWN" },
		});
		expect(m.upsert).toHaveBeenCalledOnce();
		expect(m.create).not.toHaveBeenCalled();
	});
	it("writes only managed trigger ID, preserving advanced triggers", async () => {
		await saveManagedRunSchedule(input);
		expect(m.upsert.mock.calls[0][0].where.id).toBe(trigger.id);
		expect(m.update.mock.results).toHaveLength(1);
	});
});

describe("external pause never creates a trigger", () => {
	it("fails closed when there is no current managed trigger", async () => {
		m.findUnique.mockResolvedValue(null);
		await expect(
			saveManagedRunSchedule({
				...input,
				enabled: false,
				requireExisting: true,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.upsert).not.toHaveBeenCalled();
		expect(m.updateRow).not.toHaveBeenCalled();
		expect(m.client).not.toHaveBeenCalled();
	});
	it("uses update-only CAS, so a concurrent deletion cannot recreate a paused row", async () => {
		m.updateRow.mockRejectedValue(
			Object.assign(new Error("Row disappeared"), { code: "P2025" }),
		);
		await expect(
			saveManagedRunSchedule({
				...input,
				enabled: false,
				requireExisting: true,
			}),
		).rejects.toThrow("Row disappeared");
		expect(m.upsert).not.toHaveBeenCalled();
		expect(m.updateRow).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: trigger.id,
					organizationId: actor.organizationId,
					userId: actor.userId,
					config: { equals: trigger.config },
				}),
				data: expect.objectContaining({ isActive: false }),
			}),
		);
	});
});
