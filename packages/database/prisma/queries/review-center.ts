import { db } from "../client";
import type {
	LastEditSource,
	PendingPmStateChangeAction,
	StoryKind,
} from "../generated/client";

/**
 * Review Center — live actionable inbox.
 *
 * The actionable list comes from a **live query against existing per-item
 * fields** — NOT from `PmSyncLog`. The audit log is
 * the history trail; the inbox is reconstructed on every read from:
 *
 * - `UserStory.lastPmSyncStatus IN (CONFLICT, FAILED)` —
 *   served by `@@index([projectId, lastPmSyncStatus])`.
 * - `PendingPmStateChange.status = PENDING` (ADO pull-drift) — served by
 *   `@@index([projectId, status])`.
 *
 * Stories are the only work-item rows since the Epic/Feature folder tables
 * were dropped; legacy EPIC/FEATURE pending rows are excluded from the inbox.
 *
 * Neither query reads or reconstructs `PmSyncLog` rows. Reads are unaudited
 * (D-Q11): these functions write nothing.
 */

/** Hard cap on the bounded inbox. */
const REVIEW_CENTER_ITEM_CAP = 50;

/** Generic fallback when a CONFLICT row carries no error summary. */
const CONFLICT_FALLBACK_SUMMARY = "Local and remote versions diverged";

/**
 * Tenant scope. `projectId` is the primary filter; `organizationId`/`userId`
 * provide org-vs-personal XOR (never both, never OR).
 */
type ReviewCenterTenant =
	| { organizationId: string; userId?: null }
	| { organizationId?: null; userId: string };

export type ReviewCenterInput = ReviewCenterTenant & {
	projectId: string;
};

/** Discriminator driving the FE action button. */
export type ReviewCenterItemType = "conflict" | "failure" | "pull-drift";

/**
 * Entity kind for the underlying row. STORY is the only live value — the
 * Epic/Feature folder tables were dropped (no `TASK` either — spec §5.4).
 */
export type ReviewCenterEntityType = "STORY";

export interface ReviewCenterItem {
	/** Row primary key (UserStory id, or PendingPmStateChange id). */
	id: string;
	type: ReviewCenterItemType;
	entityType: ReviewCenterEntityType;
	/** The underlying entity id (story id). */
	entityId: string;
	/** Human identifier, e.g. "F-039" / "US-001". */
	identifier: string;
	title: string;
	/** Project-level PM tool key (e.g. "azure-devops"); null if unresolved. */
	pmTool: string | null;
	/**
	 * The entity's stored PM-tool card URL (`externalUrl`) so the FE can render a
	 * "View in {tool}" link without a second round-trip. Null when the entity is
	 * unlinked (or the link was cleared, e.g. after a FLAG_MISSING unlink).
	 */
	externalUrl: string | null;
	/** One-line what-changed / error summary for the row. */
	summary: string;
	/**
	 * Fabric-side description for conflict rows so the Resolve dialog can render
	 * the diff without a second round-trip. Empty string when the entity has no
	 * description (the column is nullable).
	 */
	fabricDescription: string;
	/**
	 * Fabric-side semantic last-edit timestamp, ISO 8601,
	 * so the Resolve dialog can show "Updated {when}" on the Fabric column
	 * without a second round-trip. `null` when unavailable (e.g. a pull-drift
	 * row whose entity could not be resolved). Author is intentionally absent —
	 * Fabric entities track no `updatedBy` (separate follow-up).
	 */
	fabricUpdatedAt: string | null;
	/**
	 * Fabric-side last-editor display name (`UserStory.lastEditedByName`), so the
	 * Resolve dialog can show "Updated {when} by {name}". `null` for system/AI
	 * edits and pre-feature rows.
	 */
	fabricAuthor: string | null;
	/**
	 * Fabric-side last-edit provenance (`UserStory.lastEditedSource`), so the
	 * dialog can show a source label ("Manual edit", "Pulled from {tool}", …).
	 * `null` for pre-feature rows.
	 */
	fabricSource: LastEditSource | null;
	/**
	 * Pull-drift discriminator (`PendingPmStateChange.proposedAction`). Only set
	 * on `type === "pull-drift"` rows; `null` for conflict/failure rows. Lets the
	 * FE tell a `CONTENT_DRIFT` pull-drift row (resolved via the unified Resolve
	 * dialog) apart from `HIDE`/`UNHIDE`/`FLAG_MISSING` rows (Accept / Reject).
	 */
	proposedAction: PendingPmStateChangeAction | null;
	/**
	 * PM work-item type derived from the underlying `UserStory.kind`
	 * (`BUG → "bug"`, else `"story"`). Threaded into `retryPmSync`/
	 * `retryPmSyncBatch` so a BUG retries as the correct PM work-item type
	 * instead of defaulting to `"story"` and re-failing. Populated for
	 * all three groups — harmless on conflict/pull-drift rows.
	 */
	itemType: "story" | "bug";
}

export interface ReviewCenterItemsResult {
	/** Fixed group order: Conflicts → Failures → Pull-drift. */
	conflicts: ReviewCenterItem[];
	failures: ReviewCenterItem[];
	pullDrift: ReviewCenterItem[];
	/** Total returned items (post-cap), for convenience. */
	total: number;
}

type StoryRow = {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	lastEditedAt: Date | null;
	lastPmSyncError: string | null;
	externalUrl: string | null;
	lastEditedByName: string | null;
	lastEditedSource: LastEditSource | null;
	kind: StoryKind;
};

/** Derive the PM work-item type from the story's kind. */
function itemTypeFromKind(kind: StoryKind): "story" | "bug" {
	return kind === "BUG" ? "bug" : "story";
}

/**
 * Build the tenant WHERE for the `Project` lookup. `Project` is the only model
 * here that carries `organizationId`/`userId`; the per-item tables
 * (`UserStory`/`PendingPmStateChange`) scope by `projectId`
 * alone and inherit tenancy through the project (the calling procedure already
 * enforces `hasProjectAccess`, mirroring `list-pending-state-changes.ts`).
 * Exactly one of `organizationId`/`userId` is applied (XOR), never OR-filtered.
 */
function projectTenantWhere(input: ReviewCenterInput): {
	id: string;
	organizationId?: string | null;
	userId?: string;
} {
	const where: {
		id: string;
		organizationId?: string | null;
		userId?: string;
	} = {
		id: input.projectId,
		organizationId: input.organizationId ?? null,
	};
	if (input.organizationId == null) {
		where.userId = input.userId;
	}
	return where;
}

/**
 * Resolve the project-level PM tool key once per query. Derived from
 * `project.projectManagementMcpServerId` → `MCPServer.key` (e.g.
 * "azure-devops"). The per-item entities carry no `pmTool` column, so the
 * whole project shares one value. Returns `null` when no PM tool is linked.
 *
 * The project lookup also enforces tenant scope so a cross-tenant projectId
 * resolves to `null` rather than leaking another tenant's tool.
 */
async function resolveProjectPmTool(
	input: ReviewCenterInput,
): Promise<string | null> {
	const project = await db.project.findFirst({
		where: projectTenantWhere(input),
		select: { projectManagementMcpServerId: true },
	});
	if (!project?.projectManagementMcpServerId) {
		return null;
	}
	const server = await db.mCPServer.findUnique({
		where: { id: project.projectManagementMcpServerId },
		select: { key: true },
	});
	return server?.key ?? null;
}

// UserStory carries last-edit provenance so the conflict dialog can show
// author + source.
const STORY_SELECT = {
	id: true,
	identifier: true,
	title: true,
	description: true,
	lastEditedAt: true,
	lastPmSyncError: true,
	externalUrl: true,
	lastEditedByName: true,
	lastEditedSource: true,
	kind: true,
};

/**
 * Bounded (~50), grouped actionable list for the Review Center inbox.
 *
 * Groups in fixed order Conflicts → Failures → Pull-drift; the combined list
 * is capped at {@link REVIEW_CENTER_ITEM_CAP}. The cap is applied across
 * groups in priority order so conflicts are never starved by a large failure
 * backlog. Overflow is surfaced via the "View all in Sync History" footer
 * (handled on the FE), not paginated here (D-Q9).
 */
export async function getReviewCenterItems(
	input: ReviewCenterInput,
): Promise<ReviewCenterItemsResult> {
	// The per-item tables scope by `projectId` only — they have no
	// organizationId/userId columns; tenancy flows through the project (the
	// procedure already enforced `hasProjectAccess`).
	const projectId = input.projectId;

	const pmTool = await resolveProjectPmTool(input);

	// CONFLICT + FAILED story rows and the PENDING ADO pull-drift rows, each
	// bounded to the cap. We over-fetch per group to the cap and trim the
	// concatenation afterwards.
	const [conflictStories, failedStories, pending] = await Promise.all([
		db.userStory.findMany({
			where: { projectId, lastPmSyncStatus: "CONFLICT" },
			select: STORY_SELECT,
			take: REVIEW_CENTER_ITEM_CAP,
		}),
		db.userStory.findMany({
			where: { projectId, lastPmSyncStatus: "FAILED" },
			select: STORY_SELECT,
			take: REVIEW_CENTER_ITEM_CAP,
		}),
		db.pendingPmStateChange.findMany({
			// Legacy EPIC/FEATURE pending rows (pre-drop) are excluded — their
			// entities no longer exist and cannot be resolved or actioned.
			where: { projectId, status: "PENDING", entityType: "STORY" },
			select: {
				id: true,
				entityId: true,
				previousState: true,
				newState: true,
				proposedAction: true,
			},
			orderBy: { createdAt: "desc" },
			take: REVIEW_CENTER_ITEM_CAP,
		}),
	]);

	// FLAG_MISSING recovery wins over the bare FAILED/CONFLICT row (the deleted-
	// card case): a push to a deleted PM card stamps BOTH `lastPmSyncStatus =
	// FAILED` AND a PENDING FLAG_MISSING proposal, but only the pull-drift row
	// carries the terminal-state recovery verbs (Unlink / Re-push / Dismiss). A
	// bare failure row offers only Retry, which re-fails forever on a deleted
	// card. So a story with a PENDING FLAG_MISSING change must surface as its
	// pull-drift recovery row — never as a (suppressing) conflict/failure row.
	const flagMissingEntityIds = new Set<string>(
		pending
			.filter((p) => p.proposedAction === "FLAG_MISSING")
			.map((p) => p.entityId),
	);

	const conflicts: ReviewCenterItem[] = conflictStories
		.filter((row) => !flagMissingEntityIds.has(row.id))
		.map((row) => toStoryItem(row, "conflict", pmTool));

	const failures: ReviewCenterItem[] = failedStories
		.filter((row) => !flagMissingEntityIds.has(row.id))
		.map((row) => toStoryItem(row, "failure", pmTool));

	// Cross-tab dedup (D1, spec §7.3): a story that is simultaneously
	// CONFLICT/FAILED and has a PENDING *non*-FLAG_MISSING pull-drift change
	// (HIDE/UNHIDE/CONTENT_DRIFT) still surfaces only in its higher-priority
	// conflict/failure tab. FLAG_MISSING rows are the exception handled above —
	// they are always kept in pull-drift (and their entity is already excluded
	// from conflicts/failures), so the recovery triad is never hidden.
	const conflictOrFailureEntityIds = new Set<string>([
		...conflicts.map((c) => c.entityId),
		...failures.map((f) => f.entityId),
	]);
	const dedupedPending = pending.filter(
		(p) =>
			p.proposedAction === "FLAG_MISSING" ||
			!conflictOrFailureEntityIds.has(p.entityId),
	);

	// Pull-drift rows have no title/identifier of their own — resolve them
	// from the underlying stories in one batched lookup.
	const pullDrift = await buildPullDriftItems(
		input.projectId,
		dedupedPending,
		pmTool,
	);

	// Apply the combined cap in priority order: conflicts first, then
	// failures, then pull-drift, so high-signal conflicts are never starved.
	const cappedConflicts = conflicts.slice(0, REVIEW_CENTER_ITEM_CAP);
	const remainingAfterConflicts =
		REVIEW_CENTER_ITEM_CAP - cappedConflicts.length;
	const cappedFailures = failures.slice(
		0,
		Math.max(0, remainingAfterConflicts),
	);
	const remainingAfterFailures =
		remainingAfterConflicts - cappedFailures.length;
	const cappedPullDrift = pullDrift.slice(
		0,
		Math.max(0, remainingAfterFailures),
	);

	return {
		conflicts: cappedConflicts,
		failures: cappedFailures,
		pullDrift: cappedPullDrift,
		total:
			cappedConflicts.length +
			cappedFailures.length +
			cappedPullDrift.length,
	};
}

function toStoryItem(
	row: StoryRow,
	type: "conflict" | "failure",
	pmTool: string | null,
): ReviewCenterItem {
	const summary =
		type === "failure"
			? (row.lastPmSyncError ?? "Sync failed")
			: (row.lastPmSyncError ?? CONFLICT_FALLBACK_SUMMARY);
	return {
		id: row.id,
		type,
		entityType: "STORY",
		entityId: row.id,
		identifier: row.identifier,
		title: row.title,
		pmTool,
		externalUrl: row.externalUrl,
		summary,
		fabricDescription: row.description ?? "",
		fabricUpdatedAt: row.lastEditedAt?.toISOString() ?? null,
		fabricAuthor: row.lastEditedAt ? (row.lastEditedByName ?? null) : null,
		fabricSource: row.lastEditedAt ? (row.lastEditedSource ?? null) : null,
		// Conflict/failure rows are not pull-drift, so no proposed action.
		proposedAction: null,
		itemType: itemTypeFromKind(row.kind),
	};
}

type PendingRow = {
	id: string;
	entityId: string;
	previousState: string;
	newState: string;
	proposedAction: PendingPmStateChangeAction;
};

/**
 * One-line summary for a pull-drift row. Status-transition lanes
 * (HIDE/UNHIDE/FLAG_MISSING) read as `previousState → newState`; a
 * CONTENT_DRIFT row is a title/description change rather than a state
 * transition, so it gets its own phrasing.
 */
function pullDriftSummary(p: PendingRow): string {
	if (p.proposedAction === "CONTENT_DRIFT") {
		return "Content changed in your PM tool";
	}
	return `${p.previousState} → ${p.newState}`;
}

/**
 * Resolve identifier + title for the pending pull-drift rows. The
 * `PendingPmStateChange` row stores only `entityId`/`entityType`, so we batch
 * a story lookup (no Prisma join exists between them).
 */
async function buildPullDriftItems(
	projectId: string,
	pending: PendingRow[],
	pmTool: string | null,
): Promise<ReviewCenterItem[]> {
	if (pending.length === 0) {
		return [];
	}

	const storyIds = pending.map((p) => p.entityId);

	const stories = await db.userStory.findMany({
		where: { id: { in: storyIds }, projectId },
		select: {
			id: true,
			identifier: true,
			title: true,
			description: true,
			lastEditedAt: true,
			externalUrl: true,
			lastEditedByName: true,
			lastEditedSource: true,
			kind: true,
		},
	});

	const lookup = new Map<
		string,
		{
			identifier: string;
			title: string;
			description: string | null;
			lastEditedAt: Date | null;
			externalUrl: string | null;
			lastEditedByName: string | null;
			lastEditedSource: LastEditSource | null;
			kind: StoryKind;
		}
	>();
	for (const s of stories) {
		lookup.set(s.id, {
			identifier: s.identifier,
			title: s.title,
			description: s.description,
			lastEditedAt: s.lastEditedAt,
			externalUrl: s.externalUrl,
			lastEditedByName: s.lastEditedByName,
			lastEditedSource: s.lastEditedSource,
			kind: s.kind,
		});
	}

	return pending.map((p) => {
		const entity = lookup.get(p.entityId);
		return {
			id: p.id,
			type: "pull-drift" as const,
			entityType: "STORY" as const,
			entityId: p.entityId,
			identifier: entity?.identifier ?? p.entityId,
			title: entity?.title ?? "(unknown item)",
			pmTool,
			externalUrl: entity?.externalUrl ?? null,
			summary: pullDriftSummary(p),
			// CONTENT_DRIFT rows open the unified Resolve dialog, whose Fabric
			// column is the entity's CURRENT content — so we carry the Fabric
			// description here (mirrors the conflict-row precedent above: avoids a
			// second round-trip). The PM side is still fetched live on open. The
			// row schema (`PendingPmStateChange`) stays un-denormalized; this is a
			// read-time join. HIDE/UNHIDE/FLAG_MISSING never open the dialog, so
			// they keep an empty description.
			fabricDescription:
				p.proposedAction === "CONTENT_DRIFT"
					? (entity?.description ?? "")
					: "",
			fabricUpdatedAt: entity?.lastEditedAt?.toISOString() ?? null,
			fabricAuthor: entity?.lastEditedAt
				? (entity.lastEditedByName ?? null)
				: null,
			fabricSource: entity?.lastEditedAt
				? (entity.lastEditedSource ?? null)
				: null,
			proposedAction: p.proposedAction,
			// Derive from the underlying story kind; default to "story" when the
			// entity could not be resolved (a bug would still attempt a story push,
			// but Re-push on an unresolved row is not offered).
			itemType: entity ? itemTypeFromKind(entity.kind) : "story",
		};
	});
}

/**
 * Per-category actionable counts for the Review Center: open
 * CONFLICT story rows, FAILED story rows, and ADO pull-drift
 * (`PendingPmStateChange.status = PENDING`). Does **not** count `PmSyncLog`
 * rows. `total` is the sum of the three — preserving the badge's existing
 * all-categories semantics exactly.
 *
 * Uses 3 id-only `findMany` calls in one `Promise.all` (conflict/failed/
 * FLAG_MISSING ids) plus a single pull-drift `count()` — the FLAG_MISSING
 * cross-tab arbitration is computed in memory, so it stays cheap on the 60s
 * badge poll path.
 */
export async function getReviewCenterCount(input: ReviewCenterInput): Promise<{
	conflictsCount: number;
	failuresCount: number;
	pullDriftCount: number;
	total: number;
}> {
	// Per-item tables scope by `projectId` only (no org/user columns); tenancy
	// is enforced upstream by `hasProjectAccess` in the procedure.
	const projectId = input.projectId;

	// Cross-tab dedup (D1, spec §7.4) — mirrors `getReviewCenterItems` EXACTLY so
	// the tab labels + badge agree with the rendered lists:
	//  - FLAG_MISSING recovery wins: a CONFLICT/FAILED story that also has a
	//    PENDING FLAG_MISSING proposal is counted in pull-drift (its recovery
	//    row), NOT in conflicts/failures.
	//  - Other pending rows (HIDE/UNHIDE/CONTENT_DRIFT) on a visible
	//    conflict/failure entity stay deduped out of pull-drift.
	// Fetch the conflict/failed ids and the PENDING FLAG_MISSING entity ids
	// cheaply (id column only) and compute the visible counts in memory.
	const [conflictIds, failedIds, flagMissingRows] = await Promise.all([
		db.userStory.findMany({
			where: { projectId, lastPmSyncStatus: "CONFLICT" },
			select: { id: true },
		}),
		db.userStory.findMany({
			where: { projectId, lastPmSyncStatus: "FAILED" },
			select: { id: true },
		}),
		db.pendingPmStateChange.findMany({
			where: {
				projectId,
				status: "PENDING",
				entityType: "STORY",
				proposedAction: "FLAG_MISSING",
			},
			select: { entityId: true },
		}),
	]);
	const flagMissingEntityIds = new Set(
		flagMissingRows.map((row) => row.entityId),
	);

	// Visible conflict/failure rows exclude entities that have a FLAG_MISSING
	// recovery row (those are counted in pull-drift below instead).
	const visibleConflictIds = conflictIds
		.map((row) => row.id)
		.filter((id) => !flagMissingEntityIds.has(id));
	const visibleFailedIds = failedIds
		.map((row) => row.id)
		.filter((id) => !flagMissingEntityIds.has(id));
	const conflictsCount = visibleConflictIds.length;
	const failuresCount = visibleFailedIds.length;

	// A non-FLAG_MISSING pending row whose entity is a visible conflict/failure is
	// hidden; FLAG_MISSING pending rows are always counted (the OR's first
	// branch). `notIn: []` matches all rows, so an empty exclude set is a no-op.
	const dedupExcludeIds = [...visibleConflictIds, ...visibleFailedIds];
	const pullDriftCount = await db.pendingPmStateChange.count({
		// Legacy EPIC/FEATURE pending rows are excluded (see items query).
		where: {
			projectId,
			status: "PENDING",
			entityType: "STORY",
			OR: [
				{ proposedAction: "FLAG_MISSING" },
				{ entityId: { notIn: dedupExcludeIds } },
			],
		},
	});

	return {
		conflictsCount,
		failuresCount,
		pullDriftCount,
		total: conflictsCount + failuresCount + pullDriftCount,
	};
}
