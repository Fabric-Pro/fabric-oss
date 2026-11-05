/**
 * Problem Log (Fizzy #2277): an organization-owned record of user-impacting
 * failures, aggregated by fingerprint.
 *
 * `recordProblem` is the single writer for system events. It never throws: a
 * failure to log a failure must not become a second failure in the caller.
 *
 * Status changes go through `setProblemLogEntryStatus`, which writes the
 * entry and its immutable `audit_log` row in one transaction. The audit rows
 * are the transition history; nothing else stores it.
 */
import { createHash } from "node:crypto";
import { logger } from "@repo/logs";
import { db, type Prisma } from "../client";
import type {
	BackgroundJobKind,
	ProblemLogCategory,
	ProblemLogReviewState,
	ProblemLogSeverity,
	ProblemLogSourceType,
	ProblemLogStatus,
} from "../generated/client";
import { recordAuditTx, redactSensitiveKeys } from "./audit-log";
import { isUniqueViolation } from "./projects/publishing-tenant-lock";

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 4000;

const SEVERITY_RANK: Record<ProblemLogSeverity, number> = {
	INFO: 0,
	WARNING: 1,
	ERROR: 2,
	CRITICAL: 3,
};

export interface RecordProblemInput {
	/** Missing organization = nothing to scope the entry to; it is dropped. */
	organizationId: string | null | undefined;
	projectId?: string | null;
	affectedUserId?: string | null;
	category: ProblemLogCategory;
	severity: ProblemLogSeverity;
	/** Originating subsystem, e.g. "api:projects.get" or "job:CODE_INDEXING". */
	source: string;
	title: string;
	description?: string | null;
	/** Stable error signature; occurrences with the same one aggregate. */
	fingerprint: string;
	sourceId?: string | null;
	metadata?: Record<string, unknown> | null;
}

/**
 * Dedup key. Project and affected user are part of it: the same error hitting
 * a different user or project is a separate entry. The tenant is the unique
 * index's other column.
 */
export function problemDedupKey(
	input: Pick<
		RecordProblemInput,
		"category" | "source" | "fingerprint" | "projectId" | "affectedUserId"
	>,
): string {
	return createHash("sha256")
		.update(
			[
				input.category,
				input.source,
				input.fingerprint,
				input.projectId ?? "",
				input.affectedUserId ?? "",
			].join("\u0000"),
		)
		.digest("hex");
}

/** Records one occurrence of a system problem. Never throws. */
export async function recordProblem(input: RecordProblemInput): Promise<void> {
	if (!input.organizationId || input.severity === "INFO") {
		return;
	}
	try {
		// Callers may pass a projectId read from request input. Keep it only
		// when the project is the organization's own, so no entry can point
		// at another tenant's project.
		const projectId = input.projectId
			? ((
					await db.project.findFirst({
						where: {
							id: input.projectId,
							organizationId: input.organizationId,
						},
						select: { id: true },
					})
				)?.id ?? null)
			: null;
		await upsertProblem({
			...input,
			organizationId: input.organizationId,
			projectId,
		});
	} catch (error) {
		logger.warn("problem-log: failed to record problem", {
			error,
			category: input.category,
			source: input.source,
		});
	}
}

async function upsertProblem(
	input: RecordProblemInput & { organizationId: string },
): Promise<void> {
	const organizationId = input.organizationId;
	const dedupKey = problemDedupKey(input);
	const now = new Date();

	// Two passes: a concurrent first occurrence can win the create, in which
	// case the second pass takes the update branch.
	for (let attempt = 0; attempt < 2; attempt++) {
		const existing = await db.problemLogEntry.findUnique({
			where: { organizationId_dedupKey: { organizationId, dedupKey } },
			select: { id: true, severity: true, title: true, projectId: true },
		});

		if (!existing) {
			try {
				await db.problemLogEntry.create({
					data: {
						organizationId,
						projectId: input.projectId ?? null,
						affectedUserId: input.affectedUserId ?? null,
						category: input.category,
						severity: input.severity,
						title: input.title.slice(0, TITLE_MAX),
						description:
							input.description?.slice(0, DESCRIPTION_MAX) ??
							null,
						source: input.source,
						sourceId: input.sourceId ?? null,
						dedupKey,
						firstSeenAt: now,
						lastSeenAt: now,
						metadata: toJson(input.metadata),
					},
				});
				return;
			} catch (error) {
				if (isUniqueViolation(error)) {
					continue;
				}
				throw error;
			}
		}

		await db.$transaction(async (tx) => {
			// A recurrence reopens a resolved entry. The status guard makes the
			// reopen (and its audit row) happen once under concurrency.
			const reopened = await tx.problemLogEntry.updateMany({
				where: { id: existing.id, status: "RESOLVED" },
				data: { status: "OPEN", resolvedAt: null, resolvedById: null },
			});
			await tx.problemLogEntry.update({
				where: { id: existing.id },
				data: {
					occurrenceCount: { increment: 1 },
					lastSeenAt: now,
					...(SEVERITY_RANK[input.severity] >
					SEVERITY_RANK[existing.severity]
						? { severity: input.severity }
						: {}),
				},
			});
			if (reopened.count > 0) {
				await recordAuditTx(tx, {
					action: "project.problem_log.status_changed",
					actor: { type: "system" },
					organizationId,
					projectId: existing.projectId,
					resource: {
						type: "problem_log_entry",
						id: existing.id,
						name: existing.title,
					},
					metadata: {
						previousStatus: "RESOLVED",
						newStatus: "OPEN",
						reason: "recurred",
					},
				});
			}
		});
		return;
	}
}

// ============================================================================
// Background jobs → Problem Log
// ============================================================================

const JOB_KIND_CATEGORY: Record<BackgroundJobKind, ProblemLogCategory> = {
	TEAMS_CHANNEL_MONITOR: "DATA_PIPELINE_FAILURE",
	TEAMS_CHAT_MONITOR: "DATA_PIPELINE_FAILURE",
	SLACK_CHANNEL_MONITOR: "DATA_PIPELINE_FAILURE",
	SLACK_BACKFILL: "DATA_PIPELINE_FAILURE",
	CONTEXT_PROCESSING: "DATA_PIPELINE_FAILURE",
	PM_STATE_POLL: "INTEGRATION_FAILURE",
	PM_STORY_SYNC: "INTEGRATION_FAILURE",
	CODE_INDEXING: "BACKGROUND_JOB_FAILURE",
	STORY_KIND_REGENERATION: "BACKGROUND_JOB_FAILURE",
	PUBLISHING_TOPIC_GENERATION: "BACKGROUND_JOB_FAILURE",
	DOCUMENT_GENERATION: "BACKGROUND_JOB_FAILURE",
};

/**
 * Logs every background job a close path just moved to FAILED. A FAILED job
 * is terminal (retries happen inside the run), so each one is a problem.
 * `where` must select exactly the rows that close stamped with `completedAt`.
 * Never throws.
 */
export async function recordFailedBackgroundJobProblems(
	where: Prisma.BackgroundJobWhereInput & { completedAt: Date },
): Promise<void> {
	try {
		const jobs = await db.backgroundJob.findMany({
			where: { ...where, status: "FAILED" },
			select: {
				id: true,
				kind: true,
				title: true,
				error: true,
				errorClass: true,
				sourceId: true,
				projectId: true,
				userId: true,
				organizationId: true,
			},
		});
		for (const job of jobs) {
			await recordProblem({
				organizationId: job.organizationId,
				projectId: job.projectId,
				affectedUserId: job.userId,
				category: JOB_KIND_CATEGORY[job.kind],
				severity: "ERROR",
				source: `job:${job.kind}`,
				title: `${job.title} failed`,
				description: job.error,
				// The error text varies per run; its class and source do not.
				fingerprint: [job.errorClass ?? "", job.sourceId ?? ""].join(
					"|",
				),
				sourceId: job.id,
				metadata: { errorClass: job.errorClass },
			});
		}
	} catch (error) {
		logger.warn("problem-log: failed to record background job problems", {
			error,
		});
	}
}

// ============================================================================
// Reads
// ============================================================================

export interface ListProblemLogEntriesInput {
	organizationId: string;
	/**
	 * Projects the caller may read. `"all"` means every entry in the
	 * organization, including organization-level ones (admins only).
	 */
	projectIds: string[] | "all";
	status?: ProblemLogStatus;
	/** Defaults to CONFIRMED: drafts and dismissed drafts are never log items. */
	reviewState?: ProblemLogReviewState;
	category?: ProblemLogCategory;
	cursor?: string;
	limit?: number;
}

export async function listProblemLogEntries(input: ListProblemLogEntriesInput) {
	const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
	if (input.projectIds !== "all" && input.projectIds.length === 0) {
		return { items: [], nextCursor: null };
	}
	const rows = await db.problemLogEntry.findMany({
		where: {
			organizationId: input.organizationId,
			reviewState: input.reviewState ?? "CONFIRMED",
			...(input.projectIds === "all"
				? {}
				: { projectId: { in: input.projectIds } }),
			...(input.status ? { status: input.status } : {}),
			...(input.category ? { category: input.category } : {}),
		},
		orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
		take: limit + 1,
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
	});
	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

export function getProblemLogEntry(organizationId: string, id: string) {
	return db.problemLogEntry.findFirst({ where: { id, organizationId } });
}

/**
 * Display names (name, else email) of the given users who are members of the
 * organization. Only the organization's own members are named: a denied
 * request can record an outsider, whose email is not this organization's to
 * see. Missing ids mean "not named".
 */
export async function problemLogUserLabels(
	organizationId: string,
	ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
	const userIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
	if (userIds.length === 0) {
		return new Map();
	}
	const users = await db.user.findMany({
		where: {
			id: { in: userIds },
			members: { some: { organizationId } },
		},
		select: { id: true, name: true, email: true },
	});
	return new Map(users.map((u) => [u.id, u.name || u.email]));
}

export const PROBLEM_LOG_REPORT_ROW_CAP = 1000;

export interface ProblemLogReportInput {
	organizationId: string;
	projectId: string;
	/** One entry; the filters below are ignored when set. */
	entryId?: string;
	status?: ProblemLogStatus;
	category?: ProblemLogCategory;
	/** Entries seen at any point in [from, to]. */
	from?: Date;
	to?: Date;
}

/**
 * Confirmed entries of one project for an incident report, with the affected
 * user's display name and the project name resolved. At most
 * `PROBLEM_LOG_REPORT_ROW_CAP` rows; `truncated` says when more matched.
 */
export async function listProblemLogReportRows(input: ProblemLogReportInput) {
	const rows = await db.problemLogEntry.findMany({
		where: {
			organizationId: input.organizationId,
			projectId: input.projectId,
			reviewState: "CONFIRMED",
			...(input.entryId
				? { id: input.entryId }
				: {
						...(input.status ? { status: input.status } : {}),
						...(input.category ? { category: input.category } : {}),
						...(input.to ? { firstSeenAt: { lte: input.to } } : {}),
						...(input.from
							? { lastSeenAt: { gte: input.from } }
							: {}),
					}),
		},
		orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
		take: PROBLEM_LOG_REPORT_ROW_CAP + 1,
		include: { project: { select: { name: true } } },
	});
	const truncated = rows.length > PROBLEM_LOG_REPORT_ROW_CAP;
	const entries = truncated
		? rows.slice(0, PROBLEM_LOG_REPORT_ROW_CAP)
		: rows;

	const userLabel = await problemLogUserLabels(
		input.organizationId,
		entries.map((e) => e.affectedUserId),
	);

	return {
		truncated,
		rows: entries.map((e) => ({
			id: e.id,
			title: e.title,
			description: e.description,
			category: e.category,
			severity: e.severity,
			status: e.status,
			source: e.source,
			sourceType: e.sourceType,
			occurrenceCount: e.occurrenceCount,
			firstSeenAt: e.firstSeenAt,
			lastSeenAt: e.lastSeenAt,
			resolvedAt: e.resolvedAt,
			projectName: e.project?.name ?? null,
			affectedUser: e.affectedUserId
				? (userLabel.get(e.affectedUserId) ?? null)
				: null,
		})),
	};
}

/** Status transitions of one entry, oldest first, from the audit ledger. */
export async function listProblemLogStatusHistory(
	organizationId: string,
	entryId: string,
) {
	const rows = await db.auditLog.findMany({
		where: {
			organizationId,
			action: "project.problem_log.status_changed",
			resourceType: "problem_log_entry",
			resourceId: entryId,
		},
		orderBy: { createdAt: "asc" },
		select: {
			id: true,
			createdAt: true,
			userId: true,
			actorType: true,
			actorNameSnapshot: true,
			metadata: true,
		},
	});
	return rows.map((row) => {
		const meta = (row.metadata ?? {}) as Record<string, unknown>;
		return {
			id: row.id,
			at: row.createdAt,
			actorType: row.actorType,
			actorUserId: row.userId,
			actorName: row.actorNameSnapshot,
			previousStatus: meta.previousStatus as ProblemLogStatus | undefined,
			newStatus: meta.newStatus as ProblemLogStatus | undefined,
			note: typeof meta.note === "string" ? meta.note : null,
		};
	});
}

// ============================================================================
// Status change
// ============================================================================

export interface SetProblemLogEntryStatusInput {
	organizationId: string;
	entryId: string;
	status: ProblemLogStatus;
	note?: string | null;
	actor: {
		userId: string;
		emailSnapshot?: string | null;
		nameSnapshot?: string | null;
		impersonatedById?: string | null;
	};
}

/**
 * Moves an entry to `status` and records the immutable audit row in the same
 * transaction. Returns null when the entry does not exist in the
 * organization; a no-op (already in that status) returns the entry unchanged
 * and writes no audit row.
 */
export async function setProblemLogEntryStatus(
	input: SetProblemLogEntryStatusInput,
) {
	return db.$transaction(async (tx) => {
		const entry = await tx.problemLogEntry.findFirst({
			where: { id: input.entryId, organizationId: input.organizationId },
		});
		if (!entry) {
			return null;
		}
		if (entry.status === input.status) {
			return entry;
		}
		const changed = await tx.problemLogEntry.updateMany({
			where: { id: entry.id, status: entry.status },
			data:
				input.status === "RESOLVED"
					? {
							status: "RESOLVED",
							resolvedAt: new Date(),
							resolvedById: input.actor.userId,
						}
					: {
							status: input.status,
							resolvedAt: null,
							resolvedById: null,
						},
		});
		if (changed.count === 0) {
			// A concurrent change won; report the row as it is now.
			return tx.problemLogEntry.findUniqueOrThrow({
				where: { id: entry.id },
			});
		}
		await recordAuditTx(tx, {
			action: "project.problem_log.status_changed",
			actor: { type: "user", ...input.actor },
			organizationId: input.organizationId,
			projectId: entry.projectId,
			resource: {
				type: "problem_log_entry",
				id: entry.id,
				name: entry.title,
			},
			metadata: {
				previousStatus: entry.status,
				newStatus: input.status,
				note: input.note?.trim() || null,
			},
		});
		return tx.problemLogEntry.findUniqueOrThrow({
			where: { id: entry.id },
		});
	});
}

// ============================================================================
// Project context → drafted entries awaiting review
// ============================================================================

export type ContextProblemCategory = Extract<
	ProblemLogCategory,
	`PROJECT_${string}`
>;

const CONTEXT_CATEGORY_SEVERITY: Record<
	ContextProblemCategory,
	ProblemLogSeverity
> = {
	PROJECT_BLOCKER: "ERROR",
	PROJECT_ISSUE: "WARNING",
	PROJECT_RISK: "WARNING",
};

export interface DraftProblemsFromContextInput {
	organizationId: string | null | undefined;
	projectId: string;
	sourceType: Exclude<ProblemLogSourceType, "SYSTEM_EVENT">;
	/** The transcript / conversation / context row the drafts came from. */
	sourceId: string;
	drafts: Array<{
		category: ContextProblemCategory;
		title: string;
		description?: string | null;
		sourceQuote?: string | null;
		metadata?: Record<string, unknown> | null;
	}>;
}

/**
 * Writes problems an extractor found in project context as PENDING drafts.
 * Never throws. Idempotent: a draft is keyed on its source and normalized
 * title, so a re-extraction neither duplicates a draft nor revives one a
 * reviewer dismissed.
 *
 * ponytail: dedup is per source only; the same problem raised in two meetings
 * drafts twice. Upgrade path: a similarity check against open entries, like
 * `isSimilarDecision` in architecture-decisions queries.
 */
export async function draftProblemsFromContext(
	input: DraftProblemsFromContextInput,
): Promise<number> {
	if (!input.organizationId || input.drafts.length === 0) {
		return 0;
	}
	const organizationId = input.organizationId;
	try {
		const project = await db.project.findFirst({
			where: { id: input.projectId, organizationId },
			select: { id: true },
		});
		if (!project) {
			return 0;
		}
		const source = `context:${input.sourceType.toLowerCase()}`;
		const now = new Date();
		const result = await db.problemLogEntry.createMany({
			data: input.drafts
				.filter((d) => d.title.trim())
				.map((d) => ({
					organizationId,
					projectId: project.id,
					category: d.category,
					severity: CONTEXT_CATEGORY_SEVERITY[d.category],
					reviewState: "PENDING" as const,
					title: d.title.trim().slice(0, TITLE_MAX),
					description:
						d.description?.slice(0, DESCRIPTION_MAX) ?? null,
					source,
					sourceType: input.sourceType,
					sourceId: input.sourceId,
					sourceQuote:
						d.sourceQuote?.slice(0, DESCRIPTION_MAX) ?? null,
					dedupKey: problemDedupKey({
						// Fixed, so a re-extraction that re-labels an issue as a
						// risk still matches the existing draft.
						category: "PROJECT_ISSUE",
						source,
						fingerprint: `${input.sourceId}|${normalizeTitle(d.title)}`,
						projectId: project.id,
					}),
					firstSeenAt: now,
					lastSeenAt: now,
					metadata: toJson(d.metadata),
				})),
			skipDuplicates: true,
		});
		return result.count;
	} catch (error) {
		logger.warn("problem-log: failed to draft problems from context", {
			error,
			sourceType: input.sourceType,
			sourceId: input.sourceId,
		});
		return 0;
	}
}

/** Case, punctuation and whitespace never make two drafts different. */
function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export interface ReviewProblemLogEntryInput {
	organizationId: string;
	entryId: string;
	decision: "CONFIRM" | "DISMISS";
	/** Applied on confirm only; the confirmed entry carries the reviewer's text. */
	edits?: {
		title?: string;
		description?: string | null;
		category?: ContextProblemCategory;
		severity?: Exclude<ProblemLogSeverity, "INFO">;
	};
	actor: SetProblemLogEntryStatusInput["actor"];
}

/**
 * Confirms (optionally edited) or dismisses a PENDING draft, with its
 * `project.problem_log.reviewed` audit row in the same transaction. Returns
 * null when no PENDING draft with that id exists in the organization.
 */
export async function reviewProblemLogEntry(input: ReviewProblemLogEntryInput) {
	return db.$transaction(async (tx) => {
		const entry = await tx.problemLogEntry.findFirst({
			where: {
				id: input.entryId,
				organizationId: input.organizationId,
				reviewState: "PENDING",
			},
		});
		if (!entry) {
			return null;
		}
		const edits = input.decision === "CONFIRM" ? (input.edits ?? {}) : {};
		const title = edits.title?.trim();
		const changed = await tx.problemLogEntry.updateMany({
			// The state guard makes a double submit review once.
			where: { id: entry.id, reviewState: "PENDING" },
			data: {
				reviewState:
					input.decision === "CONFIRM" ? "CONFIRMED" : "DISMISSED",
				reviewedAt: new Date(),
				reviewedById: input.actor.userId,
				...(title ? { title: title.slice(0, TITLE_MAX) } : {}),
				...(edits.description !== undefined
					? {
							description:
								edits.description?.slice(0, DESCRIPTION_MAX) ||
								null,
						}
					: {}),
				...(edits.category ? { category: edits.category } : {}),
				...(edits.severity ? { severity: edits.severity } : {}),
			},
		});
		if (changed.count === 0) {
			return null;
		}
		// The dialog sends every field; record only the ones that changed.
		const editedFields = (
			Object.keys(edits) as Array<keyof typeof edits>
		).filter((key) => {
			const value = key === "title" ? title : edits[key];
			return (
				value !== undefined &&
				(value || null) !== ((entry[key] as string | null) || null)
			);
		});
		await recordAuditTx(tx, {
			action: "project.problem_log.reviewed",
			actor: { type: "user", ...input.actor },
			organizationId: input.organizationId,
			projectId: entry.projectId,
			resource: {
				type: "problem_log_entry",
				id: entry.id,
				name: title || entry.title,
			},
			metadata: {
				decision: input.decision,
				sourceType: entry.sourceType,
				editedFields,
			},
		});
		return tx.problemLogEntry.findUniqueOrThrow({
			where: { id: entry.id },
		});
	});
}

function toJson(
	metadata: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | undefined {
	return metadata
		? (redactSensitiveKeys(metadata) as Prisma.InputJsonValue)
		: undefined;
}
