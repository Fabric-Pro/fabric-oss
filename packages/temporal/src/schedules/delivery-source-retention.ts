import { isDeliverySourceRetentionWorkerQualified } from "@repo/database";
import {
	ScheduleAlreadyRunning,
	type ScheduleClient,
	type ScheduleDescription,
} from "@temporalio/client";
import { isPrivateDeliverySourceStorageReady } from "../lib/delivery-source-readiness";

export const DELIVERY_SOURCE_RETENTION_SCHEDULE = {
	scheduleId: "delivery-source-observation-retention",
	workflowType: "deliverySourceObservationRetentionWorkflow",
	taskQueue: "fabric-worker",
	cron: "35 6 * * *",
} as const;

/** Startup-only registration. Disabling ingestion must never disable expiry cleanup. */
export async function registerDeliverySourceRetentionSchedule(
	client: Pick<ScheduleClient, "create"> & {
		getHandle(
			id: string,
		): Pick<ReturnType<ScheduleClient["getHandle"]>, "describe">;
	},
): Promise<void> {
	let qualified = false;
	try {
		qualified =
			(await isPrivateDeliverySourceStorageReady()) &&
			(await isDeliverySourceRetentionWorkerQualified());
	} catch {
		// Missing/rolling storage or an unavailable connection cannot grant maintenance rights.
	}
	if (!qualified) {
		console.log(
			"[Worker] Private-source retention schedule skipped: storage or actual worker identity is not qualified.",
		);
		return;
	}
	try {
		await client.create({
			scheduleId: DELIVERY_SOURCE_RETENTION_SCHEDULE.scheduleId,
			spec: {
				cronExpressions: [DELIVERY_SOURCE_RETENTION_SCHEDULE.cron],
				timezone: "UTC",
			},
			action: {
				type: "startWorkflow",
				workflowType: DELIVERY_SOURCE_RETENTION_SCHEDULE.workflowType,
				taskQueue: DELIVERY_SOURCE_RETENTION_SCHEDULE.taskQueue,
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: "12 hours" },
			state: {
				paused: false,
				note: "Purges expired private source observations in bounded batches. Cleanup continues when ingestion is disabled; each activity rechecks the actual qualified worker identity.",
			},
		});
		console.log(
			"[Worker] Private-source retention schedule registered (daily at 06:35 UTC).",
		);
	} catch (error) {
		if (!(error instanceof ScheduleAlreadyRunning)) {
			throw error;
		}
		const existing = await client
			.getHandle(DELIVERY_SOURCE_RETENTION_SCHEDULE.scheduleId)
			.describe();
		assertDeliverySourceRetentionSchedule(existing);
	}
}

/** Native describe normalizes cron into calendar ranges. Never silently unpause or overwrite operator state. */
export function assertDeliverySourceRetentionSchedule(
	schedule: ScheduleDescription,
): void {
	const calendar = schedule.spec.calendars?.[0];
	const range = <T extends string | number>(
		actual: { start: T; end: T; step?: number }[] | undefined,
		start: T,
		end: T,
	) =>
		actual?.length === 1 &&
		actual[0]?.start === start &&
		actual[0]?.end === end &&
		(start === end
			? [0, 1].includes(actual[0]?.step ?? 0)
			: actual[0]?.step === 1);
	if (
		schedule.state.paused ||
		schedule.state.remainingActions !== undefined ||
		schedule.action.type !== "startWorkflow" ||
		schedule.action.workflowType !==
			DELIVERY_SOURCE_RETENTION_SCHEDULE.workflowType ||
		schedule.action.taskQueue !==
			DELIVERY_SOURCE_RETENTION_SCHEDULE.taskQueue ||
		(schedule.action.args?.length ?? 0) !== 0 ||
		schedule.policies.overlap !== "SKIP" ||
		schedule.policies.catchupWindow !== 12 * 3600000 ||
		schedule.policies.pauseOnFailure ||
		schedule.spec.calendars?.length !== 1 ||
		!calendar ||
		!range(calendar.second, 0, 0) ||
		!range(calendar.minute, 35, 35) ||
		!range(calendar.hour, 6, 6) ||
		!range(calendar.dayOfMonth, 1, 31) ||
		!range(calendar.month, "JANUARY", "DECEMBER") ||
		!range(calendar.dayOfWeek, "SUNDAY", "SATURDAY") ||
		calendar.year.length !== 0 ||
		(schedule.spec.timezone ?? "UTC") !== "UTC" ||
		schedule.spec.intervals?.length ||
		schedule.spec.skip?.length ||
		schedule.spec.startAt ||
		schedule.spec.endAt ||
		(schedule.spec.jitter ?? 0) > 1000
	) {
		throw Error(
			"Private source retention schedule requires operator attention.",
		);
	}
}
