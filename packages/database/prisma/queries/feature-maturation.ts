/**
 * Query helpers for Feature Maturation V2 — Three-Tab Feature Editor
 * (spec 2026-06-09 §5). Covers the two new tenant tables added in TG1:
 *
 *   - `DecisionLogEntry` — threaded, append-only maturation changelog (§5.2).
 *   - `MaturationApprovalPreference` — per-user default approval mode per tab,
 *     plus the "Auto-accept all" preset (§5.3).
 *
 * Both apply the multi-tenant XOR pattern (CLAUDE.md), but with DIFFERENT where
 * shapes that must match each table's RLS policy (apply-rls-direct.ts):
 *
 *   - DecisionLogEntry → `user_owned`: org context filters by `organizationId`
 *     alone (org members share the log); personal context is
 *     `{ organizationId: null, userId }`.
 *   - MaturationApprovalPreference → `per_user_within_org`: `userId` is required
 *     in BOTH branches because it is a per-USER default.
 *
 * The XOR is always exclusive — never an `OR` across tenants. Personal context
 * is `organizationId: null` (required), never `undefined`.
 */

import { db, Prisma } from "../client";
import type {
	DecisionLogEntry,
	MaturationApprovalMode,
	MaturationApprovalPreference,
	StoryKind,
} from "../generated/client";

/**
 * Tenant scope for a maturation read/write. `undefined` is intentionally not
 * allowed — callers commit to a tenant upstream (mirrors how
 * `tenantProtectedProcedure` resolves the XOR before the data layer).
 */
export type MaturationTenantFilter =
	| { organizationId: string; userId: string }
	| { organizationId: null; userId: string };

/** The three maturation tabs, used by the effective-mode resolver. */
export type MaturationTab = "cleanSpec" | "decisionLog" | "summaryQuestions";

/**
 * Hard defaults when neither a per-feature override nor a per-user default is
 * set (§5.3): Clean Spec / Decision Log auto-accept, Summary & Questions manual.
 */
export const HARD_DEFAULT_APPROVAL_MODE: Record<
	MaturationTab,
	MaturationApprovalMode
> = {
	cleanSpec: "AUTO_ACCEPT",
	decisionLog: "AUTO_ACCEPT",
	summaryQuestions: "MANUAL",
};

// ---------------------------------------------------------------------------
// DecisionLogEntry (user_owned RLS)
// ---------------------------------------------------------------------------

/**
 * Build the `where` fragment for the `user_owned` tenant shape. Org context
 * shares the org's rows; personal context is pinned to the caller's userId with
 * a null org. Kept in one place so a future refactor only touches this function.
 */
function buildDecisionLogTenantWhere(
	tenant: MaturationTenantFilter,
): Prisma.DecisionLogEntryWhereInput {
	return tenant.organizationId === null
		? { organizationId: null, userId: tenant.userId }
		: { organizationId: tenant.organizationId };
}

export interface CreateDecisionLogEntryInput {
	tenantFilter: MaturationTenantFilter;
	userStoryId: string;
	authorType: DecisionLogEntry["authorType"];
	/** Thread root when omitted; a reply when set to a parent entry id. */
	parentId?: string | null;
	status?: DecisionLogEntry["status"];
	summary?: string | null;
	content?: string | null;
	impactedSection?: string | null;
	/** Fixed-taxonomy topic label for grouping open questions (Summary tab). */
	topic?: string | null;
	questionId?: string | null;
	source?: DecisionLogEntry["source"];
	authorUserId?: string | null;
	decidedBy?: string | null;
	/** How the answer was produced relative to the AI recommendation (#7). */
	answerSource?: DecisionLogEntry["answerSource"];
	metadata?: Prisma.InputJsonValue;
	authorName?: string | null;
	sourceProvenance?: string | null;
}

/**
 * Create a Decision Log entry (a thread root or a reply). The append-only log is
 * the human-readable maturation changelog — callers must NOT mutate prior rows.
 */
export async function createDecisionLogEntry({
	tenantFilter,
	userStoryId,
	authorType,
	parentId = null,
	status,
	summary = null,
	content = null,
	impactedSection = null,
	topic = null,
	questionId = null,
	source,
	authorUserId = null,
	decidedBy = null,
	answerSource = null,
	metadata,
	authorName = null,
	sourceProvenance = null,
}: CreateDecisionLogEntryInput): Promise<DecisionLogEntry> {
	return db.decisionLogEntry.create({
		data: {
			userStoryId,
			parentId,
			authorType,
			...(status ? { status } : {}),
			summary,
			content,
			impactedSection,
			topic,
			questionId,
			...(source ? { source } : {}),
			authorUserId,
			decidedBy,
			answerSource,
			...(metadata === undefined ? {} : { metadata }),
			authorName,
			sourceProvenance,
			organizationId: tenantFilter.organizationId,
			userId: tenantFilter.userId,
		},
	});
}

export interface AppendDecisionLogReplyInput {
	tenantFilter: MaturationTenantFilter;
	userStoryId: string;
	parentId: string;
	authorType: DecisionLogEntry["authorType"];
	content: string;
	summary?: string | null;
	source?: DecisionLogEntry["source"];
	authorUserId?: string | null;
	/** Display name captured at write time, as roots already do. */
	authorName?: string | null;
	metadata?: Prisma.InputJsonValue;
}

/**
 * Append a reply turn to an existing thread. Thin wrapper over
 * `createDecisionLogEntry` that requires a `parentId` so the call site reads as
 * an append rather than a root creation.
 */
export async function appendDecisionLogReply({
	parentId,
	...rest
}: AppendDecisionLogReplyInput): Promise<DecisionLogEntry> {
	return createDecisionLogEntry({ parentId, ...rest });
}

export interface FindDecisionByQuestionInput {
	tenantFilter: MaturationTenantFilter;
	userStoryId: string;
	questionId: string;
}

/**
 * Look up the existing decision thread root minted for a given question/gap
 * (`questionId`), if any. Backs the answer dedupe (AC-2.4): the same underlying
 * question must not mint a second decision. Soft-deleted rows are excluded and
 * only thread roots (`parentId: null`) are considered. Newest match wins so a
 * stable answer is returned on a re-answer.
 */
export async function findDecisionByQuestionId({
	tenantFilter,
	userStoryId,
	questionId,
}: FindDecisionByQuestionInput): Promise<DecisionLogEntry | null> {
	return db.decisionLogEntry.findFirst({
		where: {
			...buildDecisionLogTenantWhere(tenantFilter),
			userStoryId,
			questionId,
			parentId: null,
			deletedAt: null,
		},
		orderBy: { createdAt: "desc" },
	});
}

export interface CountAgentQuestionRootsInput {
	tenantFilter: MaturationTenantFilter;
	userStoryId: string;
}

/**
 * Count the AGENT-authored question roots ever minted for a feature (any status,
 * excluding soft-deleted). The auto-seed trigger uses this to tell a feature that
 * has NEVER been scanned (count 0 → safe to auto-scan) apart from one whose
 * questions the PO has simply all answered (count > 0, open list empty → must NOT
 * re-scan). Tenant- and feature-scoped via the shared Decision Log where-builder.
 */
export async function countAgentQuestionRoots({
	tenantFilter,
	userStoryId,
}: CountAgentQuestionRootsInput): Promise<number> {
	return db.decisionLogEntry.count({
		where: {
			...buildDecisionLogTenantWhere(tenantFilter),
			userStoryId,
			authorType: "AGENT",
			parentId: null,
			deletedAt: null,
		},
	});
}

export interface GetOpenDecisionsForStoriesInput {
	tenantFilter: MaturationTenantFilter;
	/**
	 * The project the caller has been authorized against. Every returned row is
	 * constrained to it — the tenant filter alone only narrows to the org, and
	 * org membership is not project access (`hasProjectAccess` additionally
	 * requires ownership or an accepted ProjectMember row). Without this, a
	 * caller authorized for one project could pass another project's story ids
	 * and read its questions.
	 */
	projectId: string;
	userStoryIds: string[];
	/** How many questions to return per feature. The count is always exact. */
	maxPerStory: number;
}

/**
 * How much of a question's text travels. The roadmap renders one clamped line
 * per question, so the full `content` — bounded only by the API's 10 KB input
 * ceiling — would be discarded by the browser. Truncated in the database so the
 * payload cannot grow with how much anyone typed; the full text is one click
 * away in the Decision Log.
 */
const QUESTION_PREVIEW_CHARS = 300;

/** One open question on a feature, as the roadmap shows it. */
export interface OpenDecisionSummary {
	id: string;
	/** Agent-authored roots sometimes fill only `content`, so both travel and
	 * the caller renders `summary ?? content` — the same fallback the Decision
	 * Log and Summary panels use. */
	summary: string | null;
	content: string | null;
}

export interface OpenDecisionsForStories {
	/** Exact number of open threads per feature — never the capped length. */
	counts: Record<string, number>;
	/** Up to `maxPerStory` newest questions per feature. */
	questions: Record<string, OpenDecisionSummary[]>;
}

/**
 * Open decision threads for a batch of features: an exact count plus the first
 * few questions themselves. Powers the roadmap Priority layout, which both
 * ranks on the count and shows the questions in the expanded row, and so must
 * not fan out into a query per feature.
 *
 * Roots only: resolving a thread flips the ROOT to RESOLVED but leaves replies
 * carrying their own status, so counting every row would over-count a thread
 * that is already closed. Features with no open threads are simply absent from
 * both maps — callers default to 0 / [].
 *
 * The count is exact while the questions are capped, and the two are fetched
 * SEPARATELY on purpose. The Priority score reads the count, so capping it
 * alongside the display would silently change the ranking — but computing it by
 * fetching every row's text and counting in JS hauled back every open root just
 * to increment a counter, with `content` unbounded up to the API's 10 KB input
 * ceiling.
 *
 * Measured on 2026-07-21 against Postgres with 500 features x 20 open roots and
 * 4 KB of text per row (EXPLAIN ANALYZE, local dev instance):
 *
 *   old  one findMany, 10,000 rows with content   18.1 ms   38.6 MB on the wire
 *   new  groupBy counts                            2.7 ms
 *        + LATERAL, 1,500 rows truncated to 300    5.0 ms
 *                                          total   7.7 ms      508 KB
 *
 * So ~2.4x faster and ~78x less data at that shape. The saving grows with how
 * much text people write, because the old shape's cost scaled with `content`
 * length and the new one does not.
 *
 * Three cheap statements rather than one large one:
 *   1. narrow the caller's ids to the authorized project (PK lookup),
 *   2. exact counts via `groupBy` — aggregate only, no heap text,
 *   3. the first `maxPerStory` questions per feature via `CROSS JOIN LATERAL`,
 *      which Prisma cannot express — a plain `take` would cap the whole result
 *      set, not each feature's slice.
 *
 * Note on indexes, from the same measurement: neither statement used the partial
 * index `decision_log_entry_open_roots_idx`. The aggregate chose a sequential
 * scan (every row matched, so the index buys nothing), and the LATERAL drove off
 * the pre-existing `("userStoryId", "createdAt")` index, which already supplies
 * the ordering the per-feature LIMIT needs. Do not assume the partial index is
 * carrying this query — it was added for the older count-only shape.
 *
 * Step 1 is also the authorization boundary: the caller proved access to
 * `projectId`, so ids belonging to any other project drop out before either
 * later statement sees them. Keeping it here rather than as a join on the hot
 * path leaves steps 2 and 3 single-table.
 */
export async function getOpenDecisionsForStories({
	tenantFilter,
	projectId,
	userStoryIds,
	maxPerStory,
}: GetOpenDecisionsForStoriesInput): Promise<OpenDecisionsForStories> {
	if (userStoryIds.length === 0) {
		return { counts: {}, questions: {} };
	}

	// 1. Authorize the items, not just the container.
	const authorized = await db.userStory.findMany({
		where: { id: { in: userStoryIds }, projectId },
		select: { id: true },
	});
	const ids = authorized.map((story) => story.id);
	if (ids.length === 0) {
		return { counts: {}, questions: {} };
	}

	const tenantWhere = buildDecisionLogTenantWhere(tenantFilter);

	// 2. Exact counts, without reading any question text.
	const grouped = await db.decisionLogEntry.groupBy({
		by: ["userStoryId"],
		where: {
			...tenantWhere,
			userStoryId: { in: ids },
			status: "OPEN",
			parentId: null,
			deletedAt: null,
		},
		_count: { _all: true },
	});

	const counts: Record<string, number> = Object.fromEntries(
		grouped.map((row) => [row.userStoryId, row._count._all]),
	);
	if (grouped.length === 0) {
		return { counts, questions: {} };
	}

	// 3. Up to `maxPerStory` questions per feature. Only features that actually
	// have open threads are probed, and the text is truncated in the database —
	// the row renders one clamped line, so shipping a 10 KB `content` to build
	// it is waste that grows with whatever anyone typed.
	const withOpen = grouped.map((row) => row.userStoryId);
	const tenantSql =
		tenantFilter.organizationId === null
			? Prisma.sql`d."organizationId" IS NULL AND d."userId" = ${tenantFilter.userId}`
			: Prisma.sql`d."organizationId" = ${tenantFilter.organizationId}`;

	const rows = await db.$queryRaw<
		{
			userStoryId: string;
			id: string;
			summary: string | null;
			content: string | null;
		}[]
	>(Prisma.sql`
		SELECT q."userStoryId", q.id, q.summary, q.content
		FROM unnest(${withOpen}::text[]) AS s(id)
		CROSS JOIN LATERAL (
			SELECT
				d.id,
				d."userStoryId",
				left(d.summary, ${QUESTION_PREVIEW_CHARS}) AS summary,
				left(d.content, ${QUESTION_PREVIEW_CHARS}) AS content
			FROM "decision_log_entry" d
			WHERE d."userStoryId" = s.id
				AND d."status" = 'OPEN'
				AND d."parentId" IS NULL
				AND d."deletedAt" IS NULL
				AND ${tenantSql}
			-- Newest first so the capped slice shows the most recent questions,
			-- with id breaking ties so the same rows come back on every call --
			-- a list the user reads should not reshuffle between renders.
			ORDER BY d."createdAt" DESC, d.id ASC
			LIMIT ${maxPerStory}
		) q
	`);

	const questions: Record<string, OpenDecisionSummary[]> = {};
	for (const row of rows) {
		const bucket = questions[row.userStoryId] ?? [];
		bucket.push({
			id: row.id,
			summary: row.summary,
			content: row.content,
		});
		questions[row.userStoryId] = bucket;
	}

	return { counts, questions };
}

export interface GetDecisionLogEntryByIdInput {
	tenantFilter: MaturationTenantFilter;
	userStoryId: string;
	id: string;
}

/**
 * Load a single Decision Log entry by id, tenant- and feature-scoped. Used by the
 * MANUAL accept flow (TG6) to read the PENDING patch set stashed in `metadata`.
 * Returns `null` on a miss / wrong tenant / soft-deleted.
 */
export async function getDecisionLogEntryById({
	tenantFilter,
	userStoryId,
	id,
}: GetDecisionLogEntryByIdInput): Promise<DecisionLogEntry | null> {
	return db.decisionLogEntry.findFirst({
		where: {
			...buildDecisionLogTenantWhere(tenantFilter),
			id,
			userStoryId,
			deletedAt: null,
		},
	});
}

export interface ResolveQuestionThreadInput {
	tenantFilter: MaturationTenantFilter;
	/** The OPEN thread root (a question/gap) to resolve. */
	rootId: string;
	/** The PO's answer, appended as a reply turn (non-destructive, AC-2.6). */
	answer: string;
	/** Optional one-sentence summary written onto the resolved root. */
	summary?: string | null;
	impactedSection?: string | null;
	authorUserId: string;
	decidedBy: string;
	/** Origin of the answer relative to the AI recommendation (#7) — set on the reply. */
	answerSource?: DecisionLogEntry["answerSource"];
	authorName?: string | null;
	sourceProvenance?: string | null;
}

/**
 * Resolve an OPEN question thread by appending the answer as a reply (AC-2.6,
 * non-destructive) and flipping the root to RESOLVED so it leaves the open list
 * (AC-2.4 — the answered question cannot resurface). Done in a transaction so a
 * thread is never left half-resolved. The root flip is tenant-scoped via
 * `updateMany`; the function returns the updated root (or `null` if the flip
 * matched nothing — wrong tenant / already gone). The summary/impactedSection
 * are written onto the root only when provided (omitted = left untouched).
 */
export async function resolveQuestionThread({
	tenantFilter,
	rootId,
	answer,
	summary,
	impactedSection,
	authorUserId,
	decidedBy,
	answerSource = null,
	authorName = null,
	sourceProvenance = null,
}: ResolveQuestionThreadInput): Promise<DecisionLogEntry | null> {
	return db.$transaction(async (tx) => {
		// Locate the OPEN root inside the caller's tenant. A miss (wrong tenant /
		// already resolved / soft-deleted) returns null without writing.
		const root = await tx.decisionLogEntry.findFirst({
			where: {
				...buildDecisionLogTenantWhere(tenantFilter),
				id: rootId,
				parentId: null,
				deletedAt: null,
			},
			select: { id: true, userStoryId: true },
		});
		if (!root) {
			return null;
		}

		await tx.decisionLogEntry.create({
			data: {
				userStoryId: root.userStoryId,
				parentId: root.id,
				authorType: "USER",
				authorUserId,
				status: "RESOLVED",
				source: "HUMAN",
				content: answer,
				answerSource,
				authorName,
				sourceProvenance,
				organizationId: tenantFilter.organizationId,
				userId: tenantFilter.userId,
			},
		});

		return tx.decisionLogEntry.update({
			where: { id: root.id },
			data: {
				status: "RESOLVED",
				decidedBy,
				...(summary === undefined ? {} : { summary }),
				...(impactedSection === undefined ? {} : { impactedSection }),
			},
		});
	});
}

export interface AmendQuestionAnswerInput {
	tenantFilter: MaturationTenantFilter;
	/** The RESOLVED thread root whose answer is being amended. */
	rootId: string;
	/** The answer turn being replaced. Must be the thread's live (non-superseded) answer. */
	supersedesId: string;
	/** The corrected answer, appended as a new turn. */
	answer: string;
	authorUserId: string;
	decidedBy: string;
	/** Provenance of the amended answer — an amended AI answer is an edit (#1910). */
	answerSource?: DecisionLogEntry["answerSource"];
	authorName?: string | null;
	sourceProvenance?: string | null;
}

/**
 * Amend a resolved question's answer by APPENDING a new turn that supersedes the
 * previous one (#1910). Nothing is mutated: the superseded turn stays byte-identical
 * and readable as history, which is what keeps the Decision Log append-only and lets
 * the Decisions tab stay a log rather than an editor.
 *
 * Mirrors `resolveQuestionThread`: a transaction, a tenant-scoped lookup, and `null`
 * on a miss so the caller surfaces NOT_FOUND rather than minting a parallel answer.
 * The root is left RESOLVED — amending changes the answer, never the status.
 *
 * A turn can be superseded at most once, enforced by a unique index on
 * `supersedesId`: a second amendment supersedes the first amendment, keeping the
 * chain linear. We check for an existing superseder inside the transaction so a
 * lost race returns `null` instead of surfacing a raw constraint violation.
 *
 * CRITICAL for callers: a turn with a `supersededBy` row is retracted and must be
 * excluded from every AI surface — see the Temporal feature-decisions handler.
 */
export async function amendQuestionAnswer({
	tenantFilter,
	rootId,
	supersedesId,
	answer,
	authorUserId,
	decidedBy,
	answerSource = null,
	authorName = null,
	sourceProvenance = null,
}: AmendQuestionAnswerInput): Promise<DecisionLogEntry | null> {
	return db.$transaction(async (tx) => {
		const root = await tx.decisionLogEntry.findFirst({
			where: {
				...buildDecisionLogTenantWhere(tenantFilter),
				id: rootId,
				parentId: null,
				deletedAt: null,
			},
			select: { id: true, userStoryId: true },
		});
		if (!root) {
			return null;
		}

		// The target must be a live answer turn ON THIS THREAD, in this tenant, and
		// not already superseded. Any miss is a stale client or a lost race.
		const target = await tx.decisionLogEntry.findFirst({
			where: {
				...buildDecisionLogTenantWhere(tenantFilter),
				id: supersedesId,
				parentId: root.id,
				deletedAt: null,
				supersededBy: null,
			},
			select: { id: true },
		});
		if (!target) {
			return null;
		}

		return tx.decisionLogEntry.create({
			data: {
				userStoryId: root.userStoryId,
				parentId: root.id,
				authorType: "USER",
				authorUserId,
				status: "RESOLVED",
				source: "HUMAN",
				content: answer,
				answerSource,
				authorName,
				sourceProvenance,
				supersedesId: target.id,
				decidedBy,
				organizationId: tenantFilter.organizationId,
				userId: tenantFilter.userId,
			},
		});
	});
}

export interface DecisionLogThread {
	root: DecisionLogEntry;
	replies: DecisionLogEntry[];
}

export interface ListDecisionLogThreadsInput {
	tenantFilter: MaturationTenantFilter;
	userStoryId: string /**
	 * Drop answer turns that a later amendment superseded (#1910).
	 *
	 * Default `false` keeps every turn, which is what the Decisions tab needs — it
	 * renders the superseded answer as collapsed history. Pass `true` from any AI
	 * surface: a retracted answer handed to a model reads as a second, equally
	 * authoritative decision for the same question.
	 */;
	excludeSuperseded?: boolean;
}

/**
 * Fetch the threaded Decision Log for a feature in a SINGLE query (no N+1),
 * then assemble thread roots + replies in memory. Soft-deleted rows
 * (`deletedAt`) are excluded. Roots are returned reverse-chronological
 * (newest first, AC-3.2); replies within a thread are chronological.
 */
export async function listDecisionLogThreads({
	tenantFilter,
	userStoryId,
	excludeSuperseded = false,
}: ListDecisionLogThreadsInput): Promise<DecisionLogThread[]> {
	const rows = await db.decisionLogEntry.findMany({
		where: {
			...buildDecisionLogTenantWhere(tenantFilter),
			userStoryId,
			deletedAt: null,
		},
		orderBy: { createdAt: "asc" },
	});

	// A turn is superseded when some OTHER row points at it. Derived from the rows
	// already fetched, so filtering costs no extra query.
	const supersededIds = new Set<string>();
	if (excludeSuperseded) {
		for (const row of rows) {
			if (row.supersedesId) {
				supersededIds.add(row.supersedesId);
			}
		}
	}

	const repliesByParent = new Map<string, DecisionLogEntry[]>();
	const roots: DecisionLogEntry[] = [];

	for (const row of rows) {
		if (supersededIds.has(row.id)) {
			continue;
		}
		if (row.parentId === null) {
			roots.push(row);
			continue;
		}
		const bucket = repliesByParent.get(row.parentId);
		if (bucket) {
			bucket.push(row);
		} else {
			repliesByParent.set(row.parentId, [row]);
		}
	}

	// Reverse-chronological roots (newest first); replies stay chronological.
	roots.reverse();

	return roots.map((root) => ({
		root,
		replies: repliesByParent.get(root.id) ?? [],
	}));
}

export interface SoftDeleteDecisionLogEntryInput {
	tenantFilter: MaturationTenantFilter;
	id: string;
}

/**
 * Soft-delete an entry (mirrors UserStoryComment). Tenant-scoped via
 * `updateMany` so a cross-tenant id can never flip a row it doesn't own.
 * Returns the number of rows affected (0 = miss / wrong tenant).
 */
export async function softDeleteDecisionLogEntry({
	tenantFilter,
	id,
}: SoftDeleteDecisionLogEntryInput): Promise<number> {
	const result = await db.decisionLogEntry.updateMany({
		where: { ...buildDecisionLogTenantWhere(tenantFilter), id },
		data: { deletedAt: new Date() },
	});
	return result.count;
}

export interface SetDecisionMetadataInput {
	tenantFilter: MaturationTenantFilter;
	id: string;
	metadata: Prisma.InputJsonValue;
}

/**
 * Stamp the `metadata` JSONB of a single Decision Log entry — used by TG4 to
 * record the Clean-Spec propagation outcome on the decision it was minted from
 * (applied summaries, or the PENDING patch set awaiting manual accept, or a
 * located-block failure). Tenant-scoped via `updateMany` so a cross-tenant id
 * can never write a row it doesn't own; returns the affected count (0 = miss).
 * This writes ONLY `metadata`, never the Clean Spec, so it does not itself
 * trigger PM sync (§7.7).
 */
export async function setDecisionMetadata({
	tenantFilter,
	id,
	metadata,
}: SetDecisionMetadataInput): Promise<number> {
	const result = await db.decisionLogEntry.updateMany({
		where: { ...buildDecisionLogTenantWhere(tenantFilter), id },
		data: { metadata },
	});
	return result.count;
}

// ---------------------------------------------------------------------------
// MaturationApprovalPreference (per_user_within_org RLS)
// ---------------------------------------------------------------------------

/**
 * Build the `where` fragment for the `per_user_within_org` tenant shape:
 * `userId` is required in BOTH branches (it is a per-user default). Used by the
 * read helper; the upsert keys on the `(userId, organizationId)` unique index.
 */
function buildApprovalPreferenceTenantWhere(
	tenant: MaturationTenantFilter,
): Prisma.MaturationApprovalPreferenceWhereInput {
	return {
		userId: tenant.userId,
		organizationId: tenant.organizationId,
	};
}

export interface GetApprovalPreferenceInput {
	tenantFilter: MaturationTenantFilter;
}

/**
 * Read the caller's per-tab default preference for the current tenant. Returns
 * `null` when the user has never set one — callers fall through to
 * `HARD_DEFAULT_APPROVAL_MODE` (see `effectiveApprovalMode`).
 */
export async function getApprovalPreference({
	tenantFilter,
}: GetApprovalPreferenceInput): Promise<MaturationApprovalPreference | null> {
	return db.maturationApprovalPreference.findFirst({
		where: buildApprovalPreferenceTenantWhere(tenantFilter),
	});
}

export interface UpsertApprovalPreferenceInput {
	tenantFilter: MaturationTenantFilter;
	cleanSpecMode?: MaturationApprovalMode;
	decisionLogMode?: MaturationApprovalMode;
	summaryQuestionsMode?: MaturationApprovalMode;
	autoAcceptAll?: boolean;
}

/**
 * Create or update the caller's per-user default preference for the current
 * tenant. Only the provided fields are changed on update; omitted fields keep
 * their stored value (and DB defaults apply on first create).
 *
 * Prisma cannot drive `upsert` through a composite unique selector whose column
 * is `null` (personal context has `organizationId: null`), so this resolves the
 * existing row with the tenant `findFirst` and branches to create/update inside
 * a transaction.
 *
 * Single-row guarantee is at the DB level, not the application level: the
 * find-then-create is NOT atomic under READ COMMITTED (a concurrent insert can
 * race between the lookup and the create). What backstops it is the uniqueness
 * on `(userId, organizationId)` — for org rows the schema's `@@unique`, and for
 * personal rows (`organizationId IS NULL`, which Postgres treats as DISTINCT in
 * a plain unique index) the hand-written PARTIAL unique index
 * `maturation_approval_preference_user_personal_unique` added in the migration.
 * The concurrent loser throws a unique-violation rather than inserting a
 * duplicate; callers may retry the read.
 */
export async function upsertApprovalPreference({
	tenantFilter,
	cleanSpecMode,
	decisionLogMode,
	summaryQuestionsMode,
	autoAcceptAll,
}: UpsertApprovalPreferenceInput): Promise<MaturationApprovalPreference> {
	const mutableFields = {
		...(cleanSpecMode === undefined ? {} : { cleanSpecMode }),
		...(decisionLogMode === undefined ? {} : { decisionLogMode }),
		...(summaryQuestionsMode === undefined ? {} : { summaryQuestionsMode }),
		...(autoAcceptAll === undefined ? {} : { autoAcceptAll }),
	};

	return db.$transaction(async (tx) => {
		const existing = await tx.maturationApprovalPreference.findFirst({
			where: buildApprovalPreferenceTenantWhere(tenantFilter),
			select: { id: true },
		});

		if (existing) {
			return tx.maturationApprovalPreference.update({
				where: { id: existing.id },
				data: mutableFields,
			});
		}

		return tx.maturationApprovalPreference.create({
			data: {
				userId: tenantFilter.userId,
				organizationId: tenantFilter.organizationId,
				...mutableFields,
			},
		});
	});
}

// ---------------------------------------------------------------------------
// Per-feature approval override + maturation state (UserStory columns, §5.1)
// ---------------------------------------------------------------------------

/**
 * The UserStory maturation columns the three-tab editor needs to hydrate the
 * editor state (§5.1) plus the Clean Spec (which IS `description` +
 * `acceptanceCriteria`, §4.1 — no parallel `cleanSpecContent` field). Narrow
 * projection so callers never pull the whole heavily-decorated UserStory row.
 */
export interface FeatureMaturationState {
	id: string;
	projectId: string;
	title: string;
	/** Work-item kind — drives kind-scoped Summary / Clean Spec prompt resolution. */
	kind: StoryKind;
	description: string | null;
	acceptanceCriteria: string | null;
	summaryDigest: string | null;
	workingNotesContent: string | null;
	lastQuestionScanHash: string | null;
	lastSummaryHash: string | null;
	lastContextUpdateAt: Date | null;
	maturationV2OptedIn: boolean;
	/** Auto-propose AI answers for newly minted questions (#7). Default true. */
	autoProposeAnswers: boolean;
	/** Raw QA-tab analysis payload. Parse with `parseQaAnalysis`. */
	qaAnalysis: Prisma.JsonValue | null;
	cleanSpecApprovalMode: MaturationApprovalMode | null;
	decisionLogApprovalMode: MaturationApprovalMode | null;
	summaryQuestionsApprovalMode: MaturationApprovalMode | null;
}

export interface GetFeatureMaturationStateInput {
	userStoryId: string;
	projectId: string;
}

/**
 * Load the maturation columns + Clean Spec content for a feature in one query,
 * scoped to its project. Returns `null` when the feature does not exist under
 * that project (the procedure maps that to NOT_FOUND). Tenant isolation is
 * enforced upstream by the procedure's project-access check; this projection is
 * deliberately narrow (`queries.md` — select only needed columns).
 */
export async function getFeatureMaturationState({
	userStoryId,
	projectId,
}: GetFeatureMaturationStateInput): Promise<FeatureMaturationState | null> {
	return db.userStory.findFirst({
		where: { id: userStoryId, projectId },
		select: {
			id: true,
			projectId: true,
			title: true,
			kind: true,
			description: true,
			acceptanceCriteria: true,
			summaryDigest: true,
			workingNotesContent: true,
			lastQuestionScanHash: true,
			lastSummaryHash: true,
			lastContextUpdateAt: true,
			maturationV2OptedIn: true,
			autoProposeAnswers: true,
			qaAnalysis: true,
			cleanSpecApprovalMode: true,
			decisionLogApprovalMode: true,
			summaryQuestionsApprovalMode: true,
		},
	});
}

export interface SetLastQuestionScanHashInput {
	userStoryId: string;
	projectId: string;
	hash: string;
}

/**
 * Record the Clean Spec hash at the moment questions were last extracted, so the
 * next extraction can no-op when the spec is unchanged. Scoped via `updateMany`
 * on `(id, projectId)`. Touches ONLY `lastQuestionScanHash`, never the Clean
 * Spec, so it does not trigger PM sync (§7.7).
 */
export async function setLastQuestionScanHash({
	userStoryId,
	projectId,
	hash,
}: SetLastQuestionScanHashInput): Promise<number> {
	const result = await db.userStory.updateMany({
		where: { id: userStoryId, projectId },
		data: { lastQuestionScanHash: hash },
	});
	return result.count;
}

export interface SetLastSummaryHashInput {
	userStoryId: string;
	projectId: string;
	hash: string;
}

/**
 * Record the hash of (Clean Spec + bound Summary prompt) at the moment the Logic
 * Summary was last generated, so the next seed can no-op when neither the spec nor
 * the Summary prompt changed (demo feedback #4a). Scoped via `updateMany` on
 * `(id, projectId)`. Touches ONLY `lastSummaryHash`, never the Clean Spec, so it
 * does not trigger PM sync (§7.7).
 */
export async function setLastSummaryHash({
	userStoryId,
	projectId,
	hash,
}: SetLastSummaryHashInput): Promise<number> {
	const result = await db.userStory.updateMany({
		where: { id: userStoryId, projectId },
		data: { lastSummaryHash: hash },
	});
	return result.count;
}

export interface SetLastContextUpdateAtInput {
	userStoryId: string;
	projectId: string;
	at?: Date;
}

/**
 * Stamp the moment the Clean Spec was last (re)built by an AI/context path — a
 * stage Enhance, an "Update using context" run, or a "Refresh Clean Spec" run
 * (demo feedback #2/#3). Deliberately NOT called from manual-edit writes, so the
 * editor can colour the refresh control by genuine staleness. Scoped via
 * `updateMany` on `(id, projectId)`; touches ONLY `lastContextUpdateAt`, so it does
 * not trigger PM sync (§7.7). Returns the affected count (0 = miss / wrong project).
 */
export async function setLastContextUpdateAt({
	userStoryId,
	projectId,
	at = new Date(),
}: SetLastContextUpdateAtInput): Promise<number> {
	const result = await db.userStory.updateMany({
		where: { id: userStoryId, projectId },
		data: { lastContextUpdateAt: at },
	});
	return result.count;
}

export interface MarkQuestionsPossiblyResolvedInput {
	tenantFilter: MaturationTenantFilter;
	userStoryId: string;
	/** Stable keys still present in the freshly-refreshed spec — these stay OPEN. */
	presentQuestionIds: string[];
}

/**
 * Reconcile open questions against a freshly-refreshed Clean Spec (demo feedback
 * #5, option A+C). Any OPEN, AGENT-authored question root whose `questionId` is no
 * longer present in the refreshed spec is SOFT-closed to `POSSIBLY_RESOLVED` — it
 * leaves the active open list but is never deleted (collapsed + restorable in the
 * UI), preserving recall. A later refresh that re-emits the question reactivates it
 * (see the extractor's dedupe path). Tenant- and feature-scoped via the shared
 * Decision Log where-builder; writes a maturation surface only, so no PM sync
 * (§7.7). Returns the number of roots soft-closed.
 */
export async function markQuestionsPossiblyResolved({
	tenantFilter,
	userStoryId,
	presentQuestionIds,
}: MarkQuestionsPossiblyResolvedInput): Promise<number> {
	const result = await db.decisionLogEntry.updateMany({
		where: {
			...buildDecisionLogTenantWhere(tenantFilter),
			userStoryId,
			authorType: "AGENT",
			parentId: null,
			status: "OPEN",
			deletedAt: null,
			...(presentQuestionIds.length > 0
				? { questionId: { notIn: presentQuestionIds } }
				: {}),
		},
		data: { status: "POSSIBLY_RESOLVED" },
	});
	return result.count;
}

export interface SetQuestionStatusInput {
	tenantFilter: MaturationTenantFilter;
	/** The question thread root id. */
	rootId: string;
	status: DecisionLogEntry["status"];
}

/**
 * Set the status of a single question thread root, tenant-scoped via `updateMany`.
 * Used to reactivate a `POSSIBLY_RESOLVED` question back to `OPEN` when a later
 * refresh re-emits it, and to back the manual "restore" action in the UI (demo
 * feedback #5). Writes a maturation surface only → no PM sync (§7.7). Returns the
 * affected count (0 = miss / wrong tenant).
 */
export async function setQuestionStatus({
	tenantFilter,
	rootId,
	status,
}: SetQuestionStatusInput): Promise<number> {
	const result = await db.decisionLogEntry.updateMany({
		where: {
			...buildDecisionLogTenantWhere(tenantFilter),
			id: rootId,
			parentId: null,
			deletedAt: null,
		},
		data: { status },
	});
	return result.count;
}

export interface OptInFeatureMaturationV2Input {
	userStoryId: string;
	projectId: string;
}

/**
 * Lazily opt a feature into Feature Maturation V2 (§5.1) — set when the PO takes
 * their first v2 action (answering a question). The org-level
 * `featureMaturationV2Enabled` flag gates whether v2 is reachable at all; this
 * per-feature flag marks an individual feature as actively matured in v2 (and is
 * what arms Decision→Spec propagation). Scoped via `updateMany` on
 * `(id, projectId)`; callers skip the write when already opted in. Touches ONLY
 * the opt-in flag, never `description`/`acceptanceCriteria`, so it does not
 * trigger PM sync (§7.7). Returns the affected count (0 = miss / wrong project).
 */
export async function optInFeatureToMaturationV2({
	userStoryId,
	projectId,
}: OptInFeatureMaturationV2Input): Promise<number> {
	const result = await db.userStory.updateMany({
		where: { id: userStoryId, projectId },
		data: { maturationV2OptedIn: true },
	});
	return result.count;
}

/**
 * Whether AI answer recommendations are enabled for an org (#7, FR-15). Dogfood-
 * gated: defaults false until the org is enrolled (SQL flip, like
 * `featureMaturationV2Enabled`). Personal context (null org) is never enrolled, so
 * returns false. Gates the recommendation pass on top of the per-feature toggle.
 */
export async function isAiAnswerRecommendationsEnabled(
	organizationId: string | null,
): Promise<boolean> {
	if (!organizationId) {
		return false;
	}
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: { aiAnswerRecommendationsEnabled: true },
	});
	return org?.aiAnswerRecommendationsEnabled ?? false;
}

export interface SetAutoProposeAnswersInput {
	userStoryId: string;
	projectId: string;
	enabled: boolean;
}

/**
 * Toggle a feature's auto-propose-answers flag (#7). ON by default; disabling is
 * per-feature only and never cascades. Scoped via `updateMany` on `(id, projectId)`;
 * touches ONLY the toggle, never Clean Spec content, so it does not trigger PM sync
 * (§7.7). Returns the affected count (0 = miss / wrong project).
 */
export async function setAutoProposeAnswers({
	userStoryId,
	projectId,
	enabled,
}: SetAutoProposeAnswersInput): Promise<number> {
	const result = await db.userStory.updateMany({
		where: { id: userStoryId, projectId },
		data: { autoProposeAnswers: enabled },
	});
	return result.count;
}

export interface SetSummaryDigestInput {
	userStoryId: string;
	projectId: string;
	summaryDigest: string | null;
}

/**
 * Write the Logic Summary digest onto a feature (§5.1). Scoped via `updateMany`
 * on `(id, projectId)` so a cross-project id can never write a row it doesn't
 * own. Touches ONLY `summaryDigest` — never `description`/`acceptanceCriteria` —
 * so it does not change the dev-facing Clean Spec and must not trigger PM sync
 * (§7.7). Returns the affected count (0 = miss / wrong project).
 */
export async function setSummaryDigest({
	userStoryId,
	projectId,
	summaryDigest,
}: SetSummaryDigestInput): Promise<number> {
	const result = await db.userStory.updateMany({
		where: { id: userStoryId, projectId },
		data: { summaryDigest },
	});
	return result.count;
}

// ---------------------------------------------------------------------------
// QA tab analysis — UserStory.qaAnalysis Json column
// ---------------------------------------------------------------------------

/**
 * One under-specification warning from the QA analysis: the acceptance
 * criterion it concerns (free-text label like "AC 3" — ACs are a markdown blob
 * with no addressable entity) and why it is too ambiguous to test reliably.
 */
export interface QaAnalysisWarning {
	criterionRef: string;
	warning: string;
	/**
	 * True when writing the test cases is what exposed this gap, rather than the
	 * criterion being vague on its own terms.
	 *
	 * This is the test-first ordering's whole claim — drafting the cases first
	 * surfaces specification problems while they are still cheap to fix — and
	 * until it was parsed out it existed only as a `Drafting revealed:` prefix
	 * the model was asked to write, rendered identically to every other warning.
	 * A claim nobody can see is a claim nobody can check.
	 */
	fromDraftedCases?: boolean;
}

/**
 * The marker the analysis prompt asks for when a warning came out of the
 * drafted cases. Stripped on read so the flag carries the meaning and the
 * displayed text stays clean.
 *
 * Matched anywhere in the warning, not only at the start. The prompt asks for a
 * prefix, but the model sometimes folds two observations into one warning and
 * drops the marker at the second sentence instead — and a leading-only match
 * left that one rendering the raw `Drafting revealed:` string in the prose,
 * which is the single thing the chip exists to prevent.
 */
const DRAFTING_REVEALED_MARKER = /\s*\bdrafting revealed:\s*/gi;

/**
 * Split a stored warning into its display text and the drafting attribution.
 *
 * Uses `replace` rather than `test`: a `/g` regex carries `lastIndex` between
 * calls, so testing one warning would start the next one mid-string and skip
 * every other match.
 */
function parseDraftingAttribution(warning: string): {
	text: string;
	fromDraftedCases: boolean;
} {
	// Mid-sentence, the marker sat between two sentences — collapse it to the
	// single space that keeps them apart. Leading, it takes the space with it.
	const text = warning
		.replace(DRAFTING_REVEALED_MARKER, (_match, offset: number) =>
			offset === 0 ? "" : " ",
		)
		.trim();
	return { text, fromDraftedCases: text !== warning.trim() };
}

/**
 * The QA tab's persisted AI analysis. Test cases are NOT stored here — they are
 * real `TestCase` rows linked via `TestCaseWorkItemLink`; this payload carries
 * only the analysis sections generated alongside them. `specHash` is the Clean
 * Spec hash at generation time, so the tab can flag the analysis as stale when
 * the spec has since changed. `depth` records the project QA depth the analysis
 * was generated at (LIGHT omits the integration/E2E sections by design).
 */
export interface QaAnalysisContent {
	warnings: QaAnalysisWarning[];
	/** Markdown. Empty at LIGHT depth. */
	integrationNotes: string;
	/** Markdown. Empty at LIGHT depth. */
	e2eScenarios: string;
	depth: "LIGHT" | "STANDARD" | "STRICT";
	specHash: string;
	generatedAt: string;
	/**
	 * How many test cases this review read, on a test-first project.
	 *
	 * Absent on analyses stored before this was recorded, and on standard-flow
	 * projects where the review deliberately reads none. Exists so the tab can
	 * SHOW that the cases were part of the review: with test-first on and off
	 * the button, the spinner and the output sections were byte-identical, so
	 * the only way to tell whether the cases had been read was to inspect the
	 * prompt.
	 */
	reviewedAgainstCaseCount?: number;
}

/** Read the QA analysis back as typed content; `null` for absent/malformed. */
export function parseQaAnalysis(
	value: Prisma.JsonValue | null,
): QaAnalysisContent | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record.specHash !== "string" ||
		typeof record.generatedAt !== "string"
	) {
		return null;
	}
	const depth =
		record.depth === "LIGHT" ||
		record.depth === "STANDARD" ||
		record.depth === "STRICT"
			? record.depth
			: "STANDARD";
	const warnings: QaAnalysisWarning[] = [];
	if (Array.isArray(record.warnings)) {
		for (const entry of record.warnings) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				continue;
			}
			const w = entry as Record<string, unknown>;
			if (typeof w.warning === "string" && w.warning.trim()) {
				// Parsed on READ rather than stamped on write, so analyses
				// already stored under the old shape gain the grouping too.
				const { text, fromDraftedCases } = parseDraftingAttribution(
					w.warning,
				);
				// A warning that was nothing but the marker carries no
				// information, and would render as a chip labelling empty text.
				if (!text) {
					continue;
				}
				warnings.push({
					criterionRef:
						typeof w.criterionRef === "string"
							? w.criterionRef
							: "",
					warning: text,
					...(fromDraftedCases ? { fromDraftedCases } : {}),
				});
			}
		}
	}
	return {
		warnings,
		integrationNotes:
			typeof record.integrationNotes === "string"
				? record.integrationNotes
				: "",
		e2eScenarios:
			typeof record.e2eScenarios === "string" ? record.e2eScenarios : "",
		depth,
		specHash: record.specHash,
		generatedAt: record.generatedAt,
		...(typeof record.reviewedAgainstCaseCount === "number"
			? { reviewedAgainstCaseCount: record.reviewedAgainstCaseCount }
			: {}),
	};
}

export interface SetQaAnalysisInput {
	userStoryId: string;
	projectId: string;
	qaAnalysis: QaAnalysisContent;
	/** Who generated it — stamped onto the version snapshot (null for system). */
	generatedByUserId?: string | null;
}

/**
 * Write the QA analysis onto a feature AND snapshot it into the version history.
 *
 * Scoped via `updateMany` on `(id, projectId)` so a cross-project id can never
 * write a row it doesn't own; the version row is inserted in the SAME
 * transaction and only when the update actually hit (count === 1), so a miss
 * leaves no orphan snapshot. Touches ONLY `qaAnalysis` on the story — never
 * `description`/`acceptanceCriteria` — so it does not change the dev-facing
 * Clean Spec and must not trigger PM sync (§7.7). Returns the affected count
 * (0 = miss / wrong project).
 */
export async function setQaAnalysis({
	userStoryId,
	projectId,
	qaAnalysis,
	generatedByUserId,
}: SetQaAnalysisInput): Promise<number> {
	return await db.$transaction(async (tx) => {
		const result = await tx.userStory.updateMany({
			where: { id: userStoryId, projectId },
			data: {
				qaAnalysis: qaAnalysis as unknown as Prisma.InputJsonValue,
			},
		});
		if (result.count === 1) {
			await tx.qaAnalysisVersion.create({
				data: {
					userStoryId,
					projectId,
					depth: qaAnalysis.depth,
					specHash: qaAnalysis.specHash,
					content: qaAnalysis as unknown as Prisma.InputJsonValue,
					generatedByUserId: generatedByUserId ?? null,
				},
			});
		}
		return result.count;
	});
}

/** One QA-analysis snapshot, shaped for the version-history list. */
export interface QaAnalysisVersionSummary {
	id: string;
	depth: string;
	specHash: string;
	content: QaAnalysisContent | null;
	generatedByUserId: string | null;
	generatedByName: string | null;
	generatedAt: string;
}

/**
 * The QA-analysis version history for one feature, newest first. Project-scoped
 * so a cross-project story id resolves to nothing; the content blob is parsed
 * back to typed `QaAnalysisContent` (null when a stored row is malformed, never
 * a throw). Capped — the tab shows a bounded history, not the entire audit.
 */
export async function listQaAnalysisVersions(input: {
	projectId: string;
	userStoryId: string;
	limit?: number;
	offset?: number;
}): Promise<{ versions: QaAnalysisVersionSummary[]; total: number }> {
	const where = {
		projectId: input.projectId,
		userStoryId: input.userStoryId,
	};
	const [rows, total] = await Promise.all([
		db.qaAnalysisVersion.findMany({
			where,
			// Stable tiebreaker — see listTestCaseActivity: an unbroken tie
			// makes offset paging drop or repeat rows at a page boundary.
			orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
			take: input.limit ?? 20,
			skip: input.offset ?? 0,
			include: {
				generatedByUser: { select: { name: true } },
			},
		}),
		db.qaAnalysisVersion.count({ where }),
	]);
	return {
		versions: rows.map((row) => ({
			id: row.id,
			depth: row.depth,
			specHash: row.specHash,
			content: parseQaAnalysis(row.content),
			generatedByUserId: row.generatedByUserId,
			generatedByName: row.generatedByUser?.name ?? null,
			generatedAt: row.generatedAt.toISOString(),
		})),
		total,
	};
}

export interface SetWorkingNotesInput {
	userStoryId: string;
	projectId: string;
	workingNotesContent: string | null;
}

/**
 * Write the human-owned Tab-1 Notes (`workingNotesContent`). Scoped via
 * `updateMany` on `(id, projectId)`. Touches ONLY `workingNotesContent` — never
 * `description`/`acceptanceCriteria` — so it does not change the dev-facing Clean
 * Spec and must not trigger PM sync (§7.7). The notebook model treats Notes as a
 * human source of intent the AI reads but never writes. Returns the affected
 * count (0 = miss / wrong project).
 */
export async function setWorkingNotes({
	userStoryId,
	projectId,
	workingNotesContent,
}: SetWorkingNotesInput): Promise<number> {
	const result = await db.userStory.updateMany({
		where: { id: userStoryId, projectId },
		data: { workingNotesContent },
	});
	return result.count;
}

export interface SetFeatureApprovalOverrideInput {
	userStoryId: string;
	projectId: string;
	/**
	 * Each field is tri-state: omit to leave unchanged, `null` to CLEAR the
	 * per-feature override (fall through to the per-user default), or a mode to
	 * pin the override. Mirrors the `*ApprovalMode?` nullable columns (§5.1).
	 */
	cleanSpecApprovalMode?: MaturationApprovalMode | null;
	decisionLogApprovalMode?: MaturationApprovalMode | null;
	summaryQuestionsApprovalMode?: MaturationApprovalMode | null;
}

/**
 * Set (or clear) the per-feature approval-mode overrides on a UserStory (§5.1).
 * Scoped via `updateMany` on `(id, projectId)` so a cross-project id can never
 * flip a row it doesn't own; returns the affected count (0 = miss). Only the
 * provided fields are written — `null` clears an override, an omitted field is
 * left untouched. Touches ONLY the maturation override columns, never
 * `description`/`acceptanceCriteria`, so this write does not change the
 * dev-facing Clean Spec and must not trigger PM sync (§7.7).
 */
export async function setFeatureApprovalOverride({
	userStoryId,
	projectId,
	cleanSpecApprovalMode,
	decisionLogApprovalMode,
	summaryQuestionsApprovalMode,
}: SetFeatureApprovalOverrideInput): Promise<number> {
	const data = {
		...(cleanSpecApprovalMode === undefined
			? {}
			: { cleanSpecApprovalMode }),
		...(decisionLogApprovalMode === undefined
			? {}
			: { decisionLogApprovalMode }),
		...(summaryQuestionsApprovalMode === undefined
			? {}
			: { summaryQuestionsApprovalMode }),
	};

	const result = await db.userStory.updateMany({
		where: { id: userStoryId, projectId },
		data,
	});
	return result.count;
}

// ---------------------------------------------------------------------------
// Effective approval-mode resolution (§5.3, single source of truth)
// ---------------------------------------------------------------------------

/**
 * Per-feature override columns on `UserStory`, by tab. Only these three fields
 * are read here — callers can pass the whole story or a narrow projection.
 */
export interface FeatureApprovalOverrides {
	cleanSpecApprovalMode: MaturationApprovalMode | null;
	decisionLogApprovalMode: MaturationApprovalMode | null;
	summaryQuestionsApprovalMode: MaturationApprovalMode | null;
}

/**
 * Per-user default columns, by tab. A `null` preference (user never set one)
 * resolves to the hard default.
 */
export interface UserApprovalPreferenceModes {
	cleanSpecMode: MaturationApprovalMode;
	decisionLogMode: MaturationApprovalMode;
	summaryQuestionsMode: MaturationApprovalMode;
}

const FEATURE_OVERRIDE_FIELD: Record<
	MaturationTab,
	keyof FeatureApprovalOverrides
> = {
	cleanSpec: "cleanSpecApprovalMode",
	decisionLog: "decisionLogApprovalMode",
	summaryQuestions: "summaryQuestionsApprovalMode",
};

const USER_PREFERENCE_FIELD: Record<
	MaturationTab,
	keyof UserApprovalPreferenceModes
> = {
	cleanSpec: "cleanSpecMode",
	decisionLog: "decisionLogMode",
	summaryQuestions: "summaryQuestionsMode",
};

/**
 * Resolve the effective approval mode for a tab (§5.3):
 *
 *   feature.<tab>ApprovalMode ?? userPref.<tab>Mode ?? hardDefault(tab)
 *
 * `feature`/`userPref` may be `null` (no override / no stored preference). The
 * "Auto-accept all" preset is applied upstream by writing AUTO_ACCEPT into the
 * three per-user modes, so it needs no special casing here.
 */
export function effectiveApprovalMode(
	feature: FeatureApprovalOverrides | null,
	userPref: UserApprovalPreferenceModes | null,
	tab: MaturationTab,
): MaturationApprovalMode {
	const featureMode = feature ? feature[FEATURE_OVERRIDE_FIELD[tab]] : null;
	if (featureMode != null) {
		return featureMode;
	}

	const userMode = userPref ? userPref[USER_PREFERENCE_FIELD[tab]] : null;
	if (userMode != null) {
		return userMode;
	}

	return HARD_DEFAULT_APPROVAL_MODE[tab];
}

// ---------------------------------------------------------------------------
// Question assignment (Fizzy #1751)
// ---------------------------------------------------------------------------

/**
 * A person assigned to an open question, plus who put them there.
 *
 * `assignedByUserId` is not bookkeeping: after a re-assignment there are two
 * candidate "askers", and this is what makes "notify the original assigner when
 * the question is answered" (AC-14) resolve to exactly one person.
 */
export interface QuestionAssignee {
	assigneeUserId: string;
	assignedByUserId: string;
}

/**
 * The same `user_owned` tenant shape as `buildDecisionLogTenantWhere`, typed for
 * the assignee table.
 *
 * A separate function rather than a shared generic: the two where-inputs are
 * nominally distinct in the generated client, and widening one to satisfy both
 * would let a filter meant for the parent be spread into the child unnoticed.
 * The child's tenant columns mirror the parent's, so the SHAPE stays identical —
 * and `assigneeUserId` is deliberately absent, because scoping by the assignee
 * would hide an assignment from the person who created it.
 */
function buildAssigneeTenantWhere(
	tenant: MaturationTenantFilter,
): Prisma.DecisionLogEntryAssigneeWhereInput {
	return tenant.organizationId === null
		? { organizationId: null, userId: tenant.userId }
		: { organizationId: tenant.organizationId };
}

export interface ListQuestionAssigneesInput {
	tenantFilter: MaturationTenantFilter;
	/** Thread-root ids to load assignees for. */
	entryIds: string[];
}

/**
 * Load assignees for a set of question roots in one query, keyed by entry id.
 *
 * TENANCY: the filter is the PARENT's tenant shape — `assigneeUserId` is never
 * a tenant predicate. Filtering on the assignee would scope the read to the
 * person being asked, so an author who assigned somebody else would stop seeing
 * their own assignment (AC-4, AC-21).
 */
export async function listQuestionAssignees({
	tenantFilter,
	entryIds,
}: ListQuestionAssigneesInput): Promise<Map<string, QuestionAssignee[]>> {
	if (entryIds.length === 0) {
		return new Map();
	}

	const rows = await db.decisionLogEntryAssignee.findMany({
		where: {
			...buildAssigneeTenantWhere(tenantFilter),
			decisionLogEntryId: { in: entryIds },
		},
		orderBy: { createdAt: "asc" },
		select: {
			decisionLogEntryId: true,
			assigneeUserId: true,
			assignedByUserId: true,
		},
	});

	const byEntry = new Map<string, QuestionAssignee[]>();
	for (const row of rows) {
		const assignee: QuestionAssignee = {
			assigneeUserId: row.assigneeUserId,
			assignedByUserId: row.assignedByUserId,
		};
		const bucket = byEntry.get(row.decisionLogEntryId);
		if (bucket) {
			bucket.push(assignee);
		} else {
			byEntry.set(row.decisionLogEntryId, [assignee]);
		}
	}
	return byEntry;
}

export interface SetQuestionAssigneesInput {
	tenantFilter: MaturationTenantFilter;
	/** The question thread root. */
	entryId: string;
	/** The complete desired assignee set. An empty array clears the question. */
	assigneeUserIds: string[];
	/** Who is performing the assignment. */
	assignedByUserId: string;
}

/**
 * Replace a question's assignee set (AC-2, AC-5, AC-6).
 *
 * Set semantics rather than add/remove: assigning, re-assigning and clearing
 * are the same call with a different desired set, so the caller never diffs.
 * Rows already present are left untouched so their original `assignedByUserId`
 * survives a re-save — re-picking someone already assigned must not silently
 * transfer who hears the answer.
 *
 * Returns the newly-added assignees, which is exactly the set to notify.
 */
export async function setQuestionAssignees({
	tenantFilter,
	entryId,
	assigneeUserIds,
	assignedByUserId,
}: SetQuestionAssigneesInput): Promise<string[]> {
	// Confirm the question is visible in this tenant before writing anything —
	// the child row's tenant columns are copied from it, never from the caller.
	const entry = await db.decisionLogEntry.findFirst({
		where: {
			...buildDecisionLogTenantWhere(tenantFilter),
			id: entryId,
			deletedAt: null,
		},
		select: { id: true, userId: true, organizationId: true },
	});
	if (!entry) {
		return [];
	}

	const desired = [...new Set(assigneeUserIds)];
	const existing = await db.decisionLogEntryAssignee.findMany({
		where: { decisionLogEntryId: entryId },
		select: { assigneeUserId: true },
	});
	const existingIds = new Set(existing.map((row) => row.assigneeUserId));
	const added = desired.filter((id) => !existingIds.has(id));
	const removed = [...existingIds].filter((id) => !desired.includes(id));

	await db.$transaction(async (tx) => {
		if (removed.length > 0) {
			await tx.decisionLogEntryAssignee.deleteMany({
				where: {
					decisionLogEntryId: entryId,
					assigneeUserId: { in: removed },
				},
			});
		}
		if (added.length > 0) {
			await tx.decisionLogEntryAssignee.createMany({
				data: added.map((assigneeUserId) => ({
					decisionLogEntryId: entryId,
					assigneeUserId,
					assignedByUserId,
					// Tenant columns inherited from the question, never from the
					// assignee — see the model's doc-comment.
					userId: entry.userId,
					organizationId: entry.organizationId,
				})),
			});
		}
	});

	return added;
}
