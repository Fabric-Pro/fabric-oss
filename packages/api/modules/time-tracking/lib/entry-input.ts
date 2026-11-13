/**
 * The input a time entry is saved from, and the hard rules it must meet.
 *
 * Hard rules are never overridable: a positive whole duration of at most one
 * day, start and stop together or not at all, start and stop when the policy
 * the entry is saved under requires them, a valid IANA time zone and a work
 * item that belongs to the entry's project. Warnings (likely duplicate, over
 * the daily total) are separate and can be confirmed past; they are detected
 * by `detectTimeEntryWarnings` in `@repo/utils/time-tracking`, through
 * `evaluateEntryWarnings` in `./save-entry.ts`.
 */

import { ORPCError } from "@orpc/server";
import {
	elapsedMinutes,
	isIsoDate,
	isValidDurationMinutes,
	isValidTimeZone,
	MAX_TIME_ENTRY_MINUTES,
	TIME_ACTIVITY_VALUES,
	TIME_WARNING_CODES,
} from "@repo/utils/time-tracking";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";

export const workDateSchema = z
	.string()
	.refine(isIsoDate, { message: "Use a YYYY-MM-DD date" });

/**
 * Every field the author sets on an entry, for create and for update. Left
 * unrefined so each procedure can extend it, then refine the result with
 * {@link startStopGivenTogether}.
 */
export const timeEntryFieldsObject = z.object({
	projectId: z.string().min(1).max(INPUT_BOUNDS.name),
	workDate: workDateSchema,
	timezone: z
		.string()
		.max(100)
		.refine(isValidTimeZone, { message: "Use an IANA time zone" }),
	activity: z.enum(TIME_ACTIVITY_VALUES),
	/** Omitted: the policy default (create) or the entry's current value (update). */
	billable: z.boolean().optional(),
	description: z
		.string()
		.trim()
		.max(INPUT_BOUNDS.description)
		.nullable()
		.optional(),
	storyId: z.string().min(1).max(INPUT_BOUNDS.name).nullable().optional(),
	/** Ignored when start and stop are given; the duration is computed. */
	durationMinutes: z
		.number()
		.int()
		.positive()
		.max(MAX_TIME_ENTRY_MINUTES)
		.optional(),
	startAt: z.iso.datetime({ offset: true }).optional(),
	stopAt: z.iso.datetime({ offset: true }).optional(),
	/** Warning codes the author has seen and chosen to save past. */
	acknowledgedWarnings: z
		.array(z.enum(TIME_WARNING_CODES))
		.max(TIME_WARNING_CODES.length)
		.default([]),
});

type TimeEntryFieldsInput = z.infer<typeof timeEntryFieldsObject>;

/** Start and stop are given together or not at all. */
export function startStopGivenTogether(input: {
	startAt?: string;
	stopAt?: string;
}): boolean {
	return (input.startAt === undefined) === (input.stopAt === undefined);
}

export const START_STOP_TOGETHER_ERROR = {
	message: "Give both a start and a stop time, or neither",
	path: ["stopAt"],
};

interface EntryTiming {
	durationMinutes: number;
	startAt: Date | null;
	stopAt: Date | null;
}

/**
 * The duration and times an entry is stored with, under the start/stop rule
 * it is saved under. Throws BAD_REQUEST when the input breaks a hard rule.
 */
export function resolveEntryTiming(
	input: Pick<TimeEntryFieldsInput, "durationMinutes" | "startAt" | "stopAt">,
	startStopRequired: boolean,
): EntryTiming {
	if (input.startAt !== undefined && input.stopAt !== undefined) {
		const startAt = new Date(input.startAt);
		const stopAt = new Date(input.stopAt);
		const minutes = elapsedMinutes(startAt, stopAt);
		if (minutes === null) {
			throw new ORPCError("BAD_REQUEST", {
				message: "The stop time must be after the start time",
			});
		}
		if (!isValidDurationMinutes(minutes)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `An entry must be between 1 minute and ${MAX_TIME_ENTRY_MINUTES / 60} hours`,
			});
		}
		return { durationMinutes: minutes, startAt, stopAt };
	}

	if (startStopRequired) {
		throw new ORPCError("BAD_REQUEST", {
			message: "This project requires start and stop times",
		});
	}

	if (
		input.durationMinutes === undefined ||
		!isValidDurationMinutes(input.durationMinutes)
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Enter a duration between 1 minute and ${MAX_TIME_ENTRY_MINUTES / 60} hours`,
		});
	}
	return {
		durationMinutes: input.durationMinutes,
		startAt: null,
		stopAt: null,
	};
}

/** Blank and missing descriptions are both stored as null. */
export function normalizeEntryDescription(
	description: string | null | undefined,
): string | null {
	return description ? description : null;
}
