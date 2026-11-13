/**
 * Time suggestions: the reads and writes behind the "to confirm" list and the
 * generation that fills it.
 *
 * Every function is scoped by the owner's `userId`, and the list and the
 * runs by `organizationId` as well: a suggestion is personal, so nobody reads
 * or changes another member's, whatever their role. Which projects a member
 * may still see suggestions for is decided by the procedures, as for entries.
 *
 * Confirming a suggestion lives with the entry writes
 * (`confirmTimeSuggestionAsEntry` in `./time-entries`), because it creates
 * one.
 */

import {
	suggestsTimeAutomatically,
	type TimeEvidenceKind,
} from "@repo/utils/time-suggestions";
import { PROJECT_BILLING_MODEL_VALUES } from "@repo/utils/time-tracking";
import { db } from "../../client";
import type {
	TimeActivity,
	TimeSuggestionRunStatus,
	TimeSuggestionStatus,
} from "../../generated/client";
import { isUniqueViolation } from "../projects/publishing-tenant-lock";
import { workDateFromDb, workDateToDb } from "./work-date";

/**
 * How long a GENERATING run holds the member's slot before a new one may
 * reclaim it. The workflow's own execution timeout is the same, so a run past
 * this can no longer report a result.
 */
export const TIME_SUGGESTION_RUN_TIMEOUT_MS = 10 * 60 * 1000;

const RUN_TIMED_OUT_ERROR = "Generation timed out before it reported a result.";

export type StartTimeSuggestionRunResult =
	| { status: "started"; runId: string }
	| { status: "in_flight" };

/**
 * Open a generation run for the member, unless one is already running.
 *
 * A run still GENERATING past {@link TIME_SUGGESTION_RUN_TIMEOUT_MS} is
 * marked FAILED first: a worker that died mid-run would otherwise hold the
 * partial unique index and refuse every later run. Two concurrent starts
 * race on that index, and the loser answers `in_flight`.
 */
export async function startTimeSuggestionRun(params: {
	organizationId: string;
	userId: string;
	fromDate: string;
	toDate: string;
	timezone: string;
	/** True when Fabric started the run itself, false when the member asked. */
	automatic: boolean;
	now?: Date;
}): Promise<StartTimeSuggestionRunResult> {
	const now = params.now ?? new Date();
	return db.$transaction(async (tx) => {
		const blocker = await tx.timeSuggestionRun.findFirst({
			where: {
				organizationId: params.organizationId,
				userId: params.userId,
				status: "GENERATING",
			},
			select: { id: true, startedAt: true },
		});
		if (blocker) {
			const expired =
				blocker.startedAt.getTime() + TIME_SUGGESTION_RUN_TIMEOUT_MS <
				now.getTime();
			if (!expired) {
				return { status: "in_flight" as const };
			}
			await tx.timeSuggestionRun.updateMany({
				where: { id: blocker.id, status: "GENERATING" },
				data: {
					status: "FAILED",
					error: RUN_TIMED_OUT_ERROR,
					finishedAt: now,
				},
			});
		}

		try {
			const created = await tx.timeSuggestionRun.create({
				data: {
					organizationId: params.organizationId,
					userId: params.userId,
					fromDate: workDateToDb(params.fromDate),
					toDate: workDateToDb(params.toDate),
					timezone: params.timezone,
					automatic: params.automatic,
					status: "GENERATING",
				},
				select: { id: true },
			});
			return { status: "started" as const, runId: created.id };
		} catch (error) {
			if (isUniqueViolation(error)) {
				return { status: "in_flight" as const };
			}
			throw error;
		}
	});
}

/**
 * Mark a run FAILED. A compare-and-set on GENERATING: a run already finished
 * or reclaimed is left alone. Returns whether the row changed.
 */
export async function failTimeSuggestionRun(params: {
	runId: string;
	organizationId: string;
	userId: string;
	error: string;
}): Promise<boolean> {
	const { count } = await db.timeSuggestionRun.updateMany({
		where: {
			id: params.runId,
			organizationId: params.organizationId,
			userId: params.userId,
			status: "GENERATING",
		},
		data: {
			status: "FAILED",
			error: params.error,
			finishedAt: new Date(),
		},
	});
	return count > 0;
}

export interface TimeSuggestionRunState {
	id: string;
	status: TimeSuggestionRunStatus;
	createdCount: number;
	startedAt: Date;
	finishedAt: Date | null;
}

/** The member's newest run in the organization, or null. */
export async function getLatestTimeSuggestionRun(params: {
	organizationId: string;
	userId: string;
}): Promise<TimeSuggestionRunState | null> {
	return db.timeSuggestionRun.findFirst({
		where: {
			organizationId: params.organizationId,
			userId: params.userId,
		},
		select: {
			id: true,
			status: true,
			createdCount: true,
			startedAt: true,
			finishedAt: true,
		},
		orderBy: { startedAt: "desc" },
	});
}

/**
 * When the member's newest run in the organization over at least
 * `minSpanDays` work dates (`fromDate`..`toDate`, inclusive) started, or null
 * when there is none. A shorter run, such as one over a single meeting's day,
 * is not counted.
 */
export async function findLatestTimeSuggestionRunStart(params: {
	organizationId: string;
	userId: string;
	minSpanDays: number;
}): Promise<Date | null> {
	const rows = await db.$queryRaw<{ startedAt: Date }[]>`
		SELECT "startedAt"
		FROM "time_suggestion_run"
		WHERE "organizationId" = ${params.organizationId}
			AND "userId" = ${params.userId}
			AND ("toDate" - "fromDate" + 1) >= ${params.minSpanDays}
		ORDER BY "startedAt" DESC
		LIMIT 1
	`;
	return rows[0]?.startedAt ?? null;
}

/**
 * The time zones the member is known to work in, most authoritative first:
 * the one on their profile, then those their newest time entry and newest
 * suggestion run in the organization were recorded in, newer of the two
 * first. Empty when none is stored. Validity is for the caller to decide.
 */
export async function listMemberTimeZoneCandidates(params: {
	organizationId: string;
	userId: string;
}): Promise<string[]> {
	const [user, entry, run] = await Promise.all([
		db.user.findUnique({
			where: { id: params.userId },
			select: { timezone: true },
		}),
		db.timeEntry.findFirst({
			where: {
				organizationId: params.organizationId,
				userId: params.userId,
			},
			select: { timezone: true, createdAt: true },
			orderBy: { createdAt: "desc" },
		}),
		db.timeSuggestionRun.findFirst({
			where: {
				organizationId: params.organizationId,
				userId: params.userId,
			},
			select: { timezone: true, startedAt: true },
			orderBy: { startedAt: "desc" },
		}),
	]);
	const recorded = [
		...(entry ? [{ timezone: entry.timezone, at: entry.createdAt }] : []),
		...(run ? [{ timezone: run.timezone, at: run.startedAt }] : []),
	].sort((a, b) => b.at.getTime() - a.at.getTime());
	return [
		...(user?.timezone ? [user.timezone] : []),
		...recorded.map((item) => item.timezone),
	];
}

/** One piece of evidence, as a suggestion stores it: ids and times. */
export interface TimeSuggestionEvidenceValues {
	kind: TimeEvidenceKind;
	sourceId: string;
	projectId: string;
	occurredAt: Date;
	startAt: Date | null;
	endAt: Date | null;
}

/** A suggestion as generation decided it. */
export interface NewTimeSuggestion {
	projectId: string;
	workDate: string;
	timezone: string;
	activity: TimeActivity;
	durationMinutes: number | null;
	startAt: Date | null;
	stopAt: Date | null;
	description: string;
	explanation: string;
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
	expiresAt: Date;
	evidence: TimeSuggestionEvidenceValues[];
}

/**
 * Store a run's suggestions and finish the run, in one transaction. Each
 * suggestion copies the run's `automatic`.
 *
 * The run moves GENERATING to DONE first, by a compare-and-set: a run that was
 * reclaimed as timed out stores nothing (`persisted: false`). Each
 * suggestion's evidence is inserted skipping rows that already exist; when
 * any was skipped, a concurrent run claimed that evidence first, so the
 * suggestion is removed again and the evidence stays with the other one.
 */
export async function persistTimeSuggestions(params: {
	runId: string;
	organizationId: string;
	userId: string;
	suggestions: readonly NewTimeSuggestion[];
}): Promise<{ persisted: boolean; createdCount: number }> {
	return db.$transaction(
		async (tx) => {
			const finished = await tx.timeSuggestionRun.updateMany({
				where: {
					id: params.runId,
					organizationId: params.organizationId,
					userId: params.userId,
					status: "GENERATING",
				},
				data: { status: "DONE", finishedAt: new Date() },
			});
			if (finished.count === 0) {
				return { persisted: false, createdCount: 0 };
			}
			// Each suggestion keeps who started its run, so the list can hide
			// automatic ones when their project turns fixed bid.
			const { automatic } = await tx.timeSuggestionRun.findUniqueOrThrow({
				where: { id: params.runId },
				select: { automatic: true },
			});

			let createdCount = 0;
			for (const {
				evidence,
				workDate,
				...values
			} of params.suggestions) {
				const suggestion = await tx.timeSuggestion.create({
					data: {
						...values,
						workDate: workDateToDb(workDate),
						automatic,
						organizationId: params.organizationId,
						userId: params.userId,
					},
					select: { id: true },
				});
				const inserted = await tx.timeSuggestionEvidence.createMany({
					data: evidence.map((item) => ({
						...item,
						suggestionId: suggestion.id,
						organizationId: params.organizationId,
						userId: params.userId,
					})),
					skipDuplicates: true,
				});
				if (inserted.count !== evidence.length) {
					await tx.timeSuggestion.delete({
						where: { id: suggestion.id },
					});
					continue;
				}
				createdCount += 1;
			}

			await tx.timeSuggestionRun.update({
				where: { id: params.runId },
				data: { createdCount },
			});
			return { persisted: true, createdCount };
		},
		// One insert pair per suggestion; a fortnight of activity can make a
		// few hundred of them.
		{ maxWait: 5_000, timeout: 30_000 },
	);
}

export interface TimeSuggestionEvidenceRow {
	kind: TimeEvidenceKind;
	occurredAt: Date;
	startAt: Date | null;
	endAt: Date | null;
}

export interface TimeSuggestionRow {
	id: string;
	organizationId: string;
	projectId: string;
	projectName: string;
	workDate: string;
	timezone: string;
	activity: TimeActivity;
	billable: boolean | null;
	durationMinutes: number | null;
	startAt: Date | null;
	stopAt: Date | null;
	description: string;
	explanation: string;
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
	status: TimeSuggestionStatus;
	expiresAt: Date;
	createdAt: Date;
	evidence: TimeSuggestionEvidenceRow[];
}

const timeSuggestionSelect = {
	id: true,
	organizationId: true,
	projectId: true,
	workDate: true,
	timezone: true,
	activity: true,
	billable: true,
	durationMinutes: true,
	startAt: true,
	stopAt: true,
	description: true,
	explanation: true,
	storyId: true,
	storyIdentifier: true,
	storyTitle: true,
	status: true,
	expiresAt: true,
	createdAt: true,
	project: { select: { name: true } },
	evidence: {
		select: { kind: true, occurredAt: true, startAt: true, endAt: true },
		orderBy: { occurredAt: "asc" },
	},
} as const;

function toTimeSuggestionRow({
	project,
	workDate,
	...suggestion
}: {
	project: { name: string };
	workDate: Date;
} & Omit<TimeSuggestionRow, "projectName" | "workDate">): TimeSuggestionRow {
	return {
		...suggestion,
		projectName: project.name,
		workDate: workDateFromDb(workDate),
	};
}

/** The most suggestions one list returns. */
export const TIME_SUGGESTION_LIST_LIMIT = 200;

/**
 * Billing models whose projects get suggestions only when the member asks:
 * the ones `suggestsTimeAutomatically` refuses.
 */
const ON_DEMAND_ONLY_BILLING_MODELS = PROJECT_BILLING_MODEL_VALUES.filter(
	(billingModel) => !suggestsTimeAutomatically(billingModel),
);

/**
 * The member's PENDING suggestions in the organization that have not expired
 * at `now`, newest work date first.
 *
 * An automatic suggestion is left out while its project's current billing
 * model takes suggestions only on demand (fixed bid). It is not changed, so
 * it shows again if the project goes back to time and materials.
 */
export async function listPendingTimeSuggestions(params: {
	organizationId: string;
	userId: string;
	now: Date;
}): Promise<TimeSuggestionRow[]> {
	const rows = await db.timeSuggestion.findMany({
		where: {
			organizationId: params.organizationId,
			userId: params.userId,
			status: "PENDING",
			expiresAt: { gt: params.now },
			NOT: {
				automatic: true,
				project: {
					billingModel: { in: ON_DEMAND_ONLY_BILLING_MODELS },
				},
			},
		},
		select: timeSuggestionSelect,
		orderBy: [{ workDate: "desc" }, { createdAt: "asc" }],
		take: TIME_SUGGESTION_LIST_LIMIT,
	});
	return rows.map(toTimeSuggestionRow);
}

/** One of the member's suggestions, or null when it is not theirs or not there. */
export async function findTimeSuggestionForOwner(params: {
	id: string;
	userId: string;
}): Promise<TimeSuggestionRow | null> {
	const row = await db.timeSuggestion.findFirst({
		where: { id: params.id, userId: params.userId },
		select: timeSuggestionSelect,
	});
	return row ? toTimeSuggestionRow(row) : null;
}

/** The fields a member may change on a PENDING suggestion. */
export interface TimeSuggestionEditValues {
	activity: TimeActivity;
	/** Null takes the project's default when the suggestion is confirmed. */
	billable: boolean | null;
	description: string;
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
	durationMinutes: number | null;
	startAt: Date | null;
	stopAt: Date | null;
}

/**
 * Change one of the member's PENDING suggestions. Returns the updated row, or
 * null when it is not theirs, not there or no longer PENDING.
 */
export async function updatePendingTimeSuggestion(params: {
	id: string;
	userId: string;
	values: TimeSuggestionEditValues;
}): Promise<TimeSuggestionRow | null> {
	const { count } = await db.timeSuggestion.updateMany({
		where: { id: params.id, userId: params.userId, status: "PENDING" },
		data: params.values,
	});
	if (count === 0) {
		return null;
	}
	return findTimeSuggestionForOwner({ id: params.id, userId: params.userId });
}

/**
 * Dismiss one of the member's PENDING suggestions. Returns whether it moved;
 * dismissing it again changes nothing. Its evidence stays claimed, so it is
 * only suggested again when new evidence arrives.
 */
export async function dismissTimeSuggestion(params: {
	id: string;
	userId: string;
}): Promise<boolean> {
	const { count } = await db.timeSuggestion.updateMany({
		where: { id: params.id, userId: params.userId, status: "PENDING" },
		data: { status: "DISMISSED" },
	});
	return count > 0;
}
