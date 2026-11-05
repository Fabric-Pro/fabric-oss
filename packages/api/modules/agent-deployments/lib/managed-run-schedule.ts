import { ORPCError } from "@orpc/server";
import { db, type Prisma } from "@repo/database";
import {
	managedAgentRunScheduleSchema,
	managedAgentRunTemporalScheduleId,
	managedAgentRunTriggerId,
} from "@repo/database/prisma/queries/lib/managed-agent-run-schedule";
import {
	getScheduleClient,
	ScheduleAlreadyRunning,
	ScheduleNotFoundError,
} from "@repo/temporal";
import { CronExpressionParser } from "cron-parser";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import type { RunControlActor } from "./run-control-access";

const MONTHS = [
	"JANUARY",
	"FEBRUARY",
	"MARCH",
	"APRIL",
	"MAY",
	"JUNE",
	"JULY",
	"AUGUST",
	"SEPTEMBER",
	"OCTOBER",
	"NOVEMBER",
	"DECEMBER",
] as const;
const DAYS = [
	"SUNDAY",
	"MONDAY",
	"TUESDAY",
	"WEDNESDAY",
	"THURSDAY",
	"FRIDAY",
	"SATURDAY",
] as const;
type Calendar = ReturnType<typeof buildManagedRunCalendar>;
async function withReadDeadline<T>(operation: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Schedule read deadline exceeded")),
					3000,
				);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
export function buildManagedRunCalendar(
	cronExpression: string,
	timezone: string,
) {
	try {
		new Intl.DateTimeFormat("en", { timeZone: timezone });
		const fields = cronExpression.trim().split(/\s+/);
		if (fields.length !== 5 && fields.length !== 6) {
			throw Error("Expected five or six cron fields");
		}
		const expression = CronExpressionParser.parse(
			fields.length === 5 ? `0 ${fields.join(" ")}` : fields.join(" "),
			{ tz: timezone, strict: true },
		);
		const values = (items: readonly (number | string)[]) => {
			if (items.some((value) => typeof value !== "number")) {
				throw Error("Unsupported calendar modifier");
			}
			return [...new Set(items as number[])].sort((a, b) => a - b);
		};
		const f = expression.fields;
		return {
			second: values(f.second.values),
			minute: values(f.minute.values),
			hour: values(f.hour.values),
			dayOfMonth: values(f.dayOfMonth.values),
			month: values(f.month.values).map((value) => MONTHS[value - 1]),
			dayOfWeek: values(
				f.dayOfWeek.values.map((value) =>
					typeof value === "number" ? value % 7 : value,
				),
			).map((value) => DAYS[value]),
			year: "*" as const,
		};
	} catch {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Use a valid five- or six-field cron and IANA timezone. Do not constrain both day-of-month and weekday or use last-day/# modifiers.",
		});
	}
}
type ScheduleClient = Awaited<ReturnType<typeof getScheduleClient>>;
type Description = Awaited<
	ReturnType<ReturnType<ScheduleClient["getHandle"]>["describe"]>
>;
type Trigger = {
	id: string;
	deploymentId: string;
	organizationId: string | null;
	userId: string | null;
	cronExpression: string | null;
	timezone: string | null;
	isActive: boolean;
	config: Prisma.JsonValue;
};
function sameCalendar(
	observed: Description["spec"],
	wanted: Calendar,
	timezone: string,
) {
	const calendars = observed.calendars ?? [];
	if (
		(observed.timezone ?? "UTC") !== timezone ||
		calendars.length !== 1 ||
		observed.intervals?.length ||
		observed.skip?.length ||
		observed.startAt ||
		observed.endAt ||
		observed.jitter
	) {
		return false;
	}
	const calendar = calendars[0];
	if (calendar.year.length) {
		return false;
	}
	const expand = (
		ranges: readonly {
			start: string | number;
			end: string | number;
			step: number;
		}[],
		labels?: readonly string[],
	) => {
		const number = (value: string | number) =>
			typeof value === "number" ? value : (labels?.indexOf(value) ?? -1);
		const result: number[] = [];
		for (const range of ranges) {
			const start = number(range.start);
			const end = number(range.end);
			if (
				start < 0 ||
				end < start ||
				end - start > 100 ||
				range.step < 0
			) {
				return null;
			}
			for (
				let value = start;
				value <= end;
				value += Math.max(range.step, 1)
			) {
				result.push(value);
			}
		}
		return [...new Set(result)].sort((a, b) => a - b);
	};
	for (const field of ["second", "minute", "hour", "dayOfMonth"] as const) {
		if (
			JSON.stringify(expand(calendar[field])) !==
			JSON.stringify(wanted[field])
		) {
			return false;
		}
	}
	return (
		JSON.stringify(expand(calendar.month, MONTHS)) ===
			JSON.stringify(
				wanted.month.map((value) => MONTHS.indexOf(value)),
			) &&
		JSON.stringify(expand(calendar.dayOfWeek, DAYS)) ===
			JSON.stringify(wanted.dayOfWeek.map((value) => DAYS.indexOf(value)))
	);
}
function hasIdentity(description: { action: unknown }, trigger: Trigger) {
	const action = description.action as Description["action"];
	const args = action?.args?.[0];
	if (!action) {
		return false;
	}
	return (
		action.type === "startWorkflow" &&
		action.workflowType === "managedAgentRunScheduleWorkflow" &&
		action.taskQueue === "agents" &&
		args !== null &&
		typeof args === "object" &&
		"managedRunSchedule" in args &&
		args.managedRunSchedule === 1 &&
		"triggerType" in args &&
		args.triggerType === "SCHEDULE" &&
		"triggerId" in args &&
		args.triggerId === trigger.id &&
		"deploymentId" in args &&
		args.deploymentId === trigger.deploymentId &&
		"organizationId" in args &&
		args.organizationId === trigger.organizationId &&
		"userId" in args &&
		args.userId === trigger.userId
	);
}
export async function readManagedRunSchedule(
	deploymentId: string,
	actor: RunControlActor,
) {
	const trigger = await db.agentDeploymentTrigger.findFirst({
		where: {
			id: managedAgentRunTriggerId(deploymentId),
			deploymentId,
			userId: actor.userId,
			organizationId: actor.organizationId,
		},
	});
	if (!trigger) {
		return { schedule: null, schedulingState: "UNKNOWN" as const };
	}
	const parsed = managedAgentRunScheduleSchema.safeParse(trigger.config);
	if (!parsed.success) {
		return { schedule: null, schedulingState: "UNKNOWN" as const };
	}
	const schedule = {
		id: trigger.id,
		enabled: trigger.isActive,
		cronExpression: trigger.cronExpression ?? "",
		timezone: trigger.timezone ?? "UTC",
		input: parsed.data.inputTemplate,
	};
	try {
		const description = await withReadDeadline(async () => {
			const client = await getScheduleClient();
			return client
				.getHandle(managedAgentRunTemporalScheduleId(trigger.id))
				.describe();
		});
		if (
			!hasIdentity(description, trigger) ||
			!sameCalendar(
				description.spec,
				buildManagedRunCalendar(
					schedule.cronExpression,
					schedule.timezone,
				),
				schedule.timezone,
			)
		) {
			return { schedule, schedulingState: "UNKNOWN" as const };
		}
		return {
			schedule: { ...schedule, enabled: !description.state.paused },
			schedulingState: description.state.paused
				? ("PAUSED" as const)
				: ("ACTIVE" as const),
		};
	} catch {
		return { schedule, schedulingState: "UNKNOWN" as const };
	}
}
export async function saveManagedRunSchedule(
	input: RunControlActor & {
		deploymentId: string;
		cronExpression: string;
		timezone: string;
		input: { message: string };
		enabled: boolean;
		/** External pause may only update an existing managed trigger. */
		requireExisting?: boolean;
		onSaved?: () => Promise<void>;
	},
) {
	const calendar = buildManagedRunCalendar(
		input.cronExpression,
		input.timezone,
	);
	const id = managedAgentRunTriggerId(input.deploymentId);
	const config = managedAgentRunScheduleSchema.parse({
		fabricManagedRunSchedule: 1,
		inputTemplate: input.input,
	});
	const existing = await db.agentDeploymentTrigger.findUnique({
		where: { id },
	});
	if (
		existing &&
		(existing.userId !== input.userId ||
			existing.organizationId !== input.organizationId ||
			existing.deploymentId !== input.deploymentId ||
			!managedAgentRunScheduleSchema.safeParse(existing.config).success)
	) {
		throw new ORPCError("CONFLICT", {
			message:
				"The existing trigger is not this managed agent schedule. Inspect it before changing it.",
		});
	}
	if (input.requireExisting && !existing) {
		throw new ORPCError("NOT_FOUND", {
			message: "There is no existing schedule to pause.",
		});
	}
	const write = {
		where: {
			id,
			deploymentId: input.deploymentId,
			userId: input.userId,
			organizationId: input.organizationId,
			...(existing
				? {
						config: {
							equals: existing.config as Prisma.InputJsonValue,
						},
					}
				: {}),
		},
		update: {
			config,
			cronExpression: input.cronExpression,
			timezone: input.timezone,
			isActive: input.enabled,
		},
		create: {
			id,
			deploymentId: input.deploymentId,
			userId: input.userId,
			organizationId: input.organizationId,
			type: "SCHEDULE" as const,
			config,
			cronExpression: input.cronExpression,
			timezone: input.timezone,
			isActive: input.enabled,
		},
	};
	const trigger = input.requireExisting
		? await db.agentDeploymentTrigger.update({
				where: write.where,
				data: write.update,
			})
		: await db.agentDeploymentTrigger.upsert(write);
	if (
		trigger.userId !== input.userId ||
		trigger.organizationId !== input.organizationId ||
		trigger.deploymentId !== input.deploymentId
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Schedule not found or access denied",
		});
	}
	await input.onSaved?.();
	try {
		const client = await getScheduleClient();
		const scheduleId = managedAgentRunTemporalScheduleId(id);
		const handle = client.getHandle(scheduleId);
		const action = {
			type: "startWorkflow" as const,
			...withCorrelationMemo({
				workflowType: "managedAgentRunScheduleWorkflow",
				taskQueue: "agents",
				workflowId: `fabric-agent-scheduled-${id}`,
				args: [
					{
						managedRunSchedule: 1,
						supervisorWorkflowId: "",
						deploymentId: input.deploymentId,
						triggerId: id,
						triggerType: "SCHEDULE",
						userId: input.userId,
						organizationId: input.organizationId,
					},
				],
				retry: { maximumAttempts: 1 },
			}),
		};
		const update = {
			spec: { calendars: [calendar], timezone: input.timezone },
			action,
			state: {
				paused: !input.enabled,
				note: "Fabric background agent schedule",
			},
			policies: {
				overlap: "SKIP" as const,
				catchupWindow: "1 minute" as const,
			},
		};
		let exists = true;
		try {
			const description = await handle.describe();
			if (!hasIdentity(description, trigger)) {
				throw new ORPCError("CONFLICT", {
					message:
						"The existing schedule identity does not match this agent. Inspect it before replacing it.",
				});
			}
		} catch (error) {
			if (error instanceof ScheduleNotFoundError) {
				exists = false;
			} else {
				throw error;
			}
		}
		if (!exists) {
			try {
				await client.create({ scheduleId, ...update });
			} catch (error) {
				if (!(error instanceof ScheduleAlreadyRunning)) {
					throw error;
				}
			}
		}
		// Updating the one stable schedule also repairs edits whose previous acknowledgement was lost.
		await handle.update((previous) => {
			if (!hasIdentity(previous, trigger)) {
				throw new ORPCError("CONFLICT", {
					message:
						"Schedule ownership changed before update. Inspect it before retrying.",
				});
			}
			return { ...previous, ...update };
		});
		const observed = await readManagedRunSchedule(input.deploymentId, {
			userId: input.userId,
			organizationId: input.organizationId,
		});
		if (
			observed.schedulingState === "UNKNOWN" ||
			observed.schedule?.enabled !== input.enabled
		) {
			throw Error("Schedule acknowledgement is unresolved");
		}
		return observed;
	} catch (error) {
		if (error instanceof ORPCError) {
			throw error;
		}
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message:
				"Schedule configuration was saved, but its engine state is unconfirmed. Retry this schedule to reconcile the same definition; no second schedule is created.",
			data: {
				scheduleSaved: true,
				scheduleId: id,
				schedulingState: "UNKNOWN",
			},
		});
	}
}
