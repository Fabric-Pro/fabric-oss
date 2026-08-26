import { db } from "../client";
import type {
	PendingPmStateChangeAction,
	PmStateChangeEntityType,
	PmSyncStatus,
} from "../generated/client";

/**
 * Upsert a pending PM state change.
 *
 * Dedup is keyed on `proposedAction` so distinct lanes (HIDE / UNHIDE /
 * FLAG_MISSING / CONTENT_DRIFT) for the same entity never stomp each other.
 *
 * Logic:
 * - DISMISSED short-circuit (per action lane):
 *   - CONTENT_DRIFT matches on the exact `detectedPmHash` — a dismissed row only
 *     suppresses re-proposing *that exact ADO content hash*; a newer ADO edit
 *     (different hash) is a fresh drift and re-surfaces.
 *   - HIDE / UNHIDE / FLAG_MISSING keep matching on `newState` (unchanged).
 * - If a PENDING row exists for the same entity + action, update it
 *   (CONTENT_DRIFT advances `detectedPmHash`; others refresh state) → "updated".
 * - Otherwise insert a new PENDING row → "created".
 */
export async function upsertPendingChange(params: {
	projectId: string;
	entityType: PmStateChangeEntityType;
	entityId: string;
	externalId: string;
	previousState: string;
	newState: string;
	proposedAction: PendingPmStateChangeAction;
	/**
	 * The ADO content hash at detection time. Set for CONTENT_DRIFT rows
	 * (drives the action-aware dedup + DISMISSED staleness check); null for
	 * HIDE / UNHIDE / FLAG_MISSING rows.
	 */
	detectedPmHash?: string | null;
	/**
	 * The PM server the story's link belonged to at FLAG_MISSING detection time
	 * (#1360 review Fix B). Persisted so the atomic unlink predicate can refuse
	 * to sever a link that was retooled/imported onto a different server since.
	 * Only meaningful for FLAG_MISSING; other actions pass undefined → stored null.
	 */
	expectedExternalMcpServerId?: string | null;
}): Promise<{
	action: "created" | "updated" | "skipped";
	pendingId: string | null;
}> {
	const {
		projectId,
		entityType,
		entityId,
		externalId,
		previousState,
		newState,
		proposedAction,
		detectedPmHash = null,
		expectedExternalMcpServerId,
	} = params;

	// FLAG_MISSING-only provenance: the expected server is meaningless for the
	// other lanes, so they store null even if a caller passed a value.
	const expectedServer =
		proposedAction === "FLAG_MISSING"
			? (expectedExternalMcpServerId ?? null)
			: null;

	const isContentDrift = proposedAction === "CONTENT_DRIFT";

	// DISMISSED short-circuit, scoped to this action lane. For CONTENT_DRIFT the
	// match must be on the exact `detectedPmHash` (dismissed-at-hash-X only
	// suppresses hash X; a newer hash re-surfaces). For state-transition actions
	// the legacy `newState` match is preserved. For FLAG_MISSING the match is ALSO
	// server-scoped on `expectedExternalMcpServerId` (#1360): a dismissed flag for
	// server A / externalId `123` must NOT suppress a genuinely different server B
	// ticket that merely shares the externalId string — otherwise a valid future
	// missing ticket would be permanently unreviewable. This mirrors the
	// server-snapshot invariant used by the consume/unlink/auto-dismiss paths.
	const dismissed = await db.pendingPmStateChange.findFirst({
		where: {
			projectId,
			entityType,
			entityId,
			status: "DISMISSED",
			proposedAction,
			...(isContentDrift
				? { detectedPmHash }
				: proposedAction === "FLAG_MISSING"
					? {
							externalId,
							expectedExternalMcpServerId: expectedServer,
						}
					: { newState }),
		},
	});

	if (dismissed) {
		return { action: "skipped", pendingId: null };
	}

	// Check if a PENDING row already exists for this entity + action lane.
	const existing = await db.pendingPmStateChange.findFirst({
		where: {
			projectId,
			entityType,
			entityId,
			status: "PENDING",
			proposedAction,
		},
	});

	if (existing) {
		await db.pendingPmStateChange.update({
			where: { id: existing.id },
			data: isContentDrift
				? { detectedPmHash, createdAt: new Date() }
				: {
						previousState,
						newState,
						proposedAction,
						createdAt: new Date(),
						...(proposedAction === "FLAG_MISSING"
							? {
									externalId,
									expectedExternalMcpServerId: expectedServer,
								}
							: {}),
					},
		});
		return { action: "updated", pendingId: existing.id };
	}

	// Active-slot arbitration (FLAG_MISSING only): the partial unique index
	// pending_pm_state_unique_active permits one PENDING row per entity across
	// ALL action lanes. If a different action already occupies the slot, defer
	// FLAG_MISSING — the streak stays capped and re-attempts once the slot frees.
	if (proposedAction === "FLAG_MISSING") {
		const slotHolder = await db.pendingPmStateChange.findFirst({
			where: { projectId, entityType, entityId, status: "PENDING" },
			select: { id: true },
		});
		if (slotHolder) {
			return { action: "skipped", pendingId: null };
		}
	}

	try {
		const created = await db.pendingPmStateChange.create({
			data: {
				projectId,
				entityType,
				entityId,
				externalId,
				previousState,
				newState,
				proposedAction,
				detectedPmHash,
				expectedExternalMcpServerId: expectedServer,
				status: "PENDING",
			},
			select: { id: true },
		});
		return { action: "created", pendingId: created.id };
	} catch (err: any) {
		// FLAG_MISSING has durable streak retry, so a unique-index race can be
		// safely deferred. HIDE/UNHIDE/CONTENT_DRIFT are one-shot off the
		// changed-item path — swallowing their P2002 would silently lose a
		// proposal — so they rethrow (loud, Temporal-retryable).
		if (proposedAction === "FLAG_MISSING" && err?.code === "P2002") {
			return { action: "skipped", pendingId: null };
		}
		throw err;
	}
}

/**
 * Get all linked external IDs for a project (user stories that have a
 * non-null externalId), with each item's content-drift baseline
 * (`lastSyncedPmHash`) and push-time sync status (`lastPmSyncStatus`).
 *
 * The baseline + status are selected in the SAME batch so the reconcile
 * activity (Group 3) can compute drift and apply the skip rules without a
 * per-item round trip (`backend/queries.md`: no N+1), and the fetch classifier
 * reads `draftingStage`/`pmAutoHidden` for the reopen predicate from the same
 * batch. Stories are the only work-item rows since the Epic/Feature folder
 * tables were dropped.
 */
export async function getLinkedExternalIds(projectId: string): Promise<
	Array<{
		entityType: PmStateChangeEntityType;
		entityId: string;
		externalId: string;
		/** Current lifecycle stage — the poll's fetch classifier needs it for the
		 *  reopen predicate (non-terminal + CLOSED + pmAutoHidden). */
		draftingStage: string;
		/** Auto-hide provenance — drives the reopen (auto-unhide) classification. */
		pmAutoHidden: boolean;
		lastSyncedPmHash: string | null;
		lastPmSyncStatus: PmSyncStatus | null;
	}>
> {
	const stories = await db.userStory.findMany({
		where: { projectId, externalId: { not: null } },
		select: {
			id: true,
			externalId: true,
			draftingStage: true,
			pmAutoHidden: true,
			lastSyncedPmHash: true,
			lastPmSyncStatus: true,
		},
	});

	return stories.map((s) => ({
		entityType: "STORY" as const,
		entityId: s.id,
		externalId: s.externalId!,
		draftingStage: s.draftingStage,
		pmAutoHidden: s.pmAutoHidden,
		lastSyncedPmHash: s.lastSyncedPmHash,
		lastPmSyncStatus: s.lastPmSyncStatus,
	}));
}

/**
 * Find a Fabric entity by its external (ADO) ID within a project.
 *
 * Returns the entity's `draftingStage` + `entityType`, plus its content-drift
 * baseline (`lastSyncedPmHash`) and push-time sync status (`lastPmSyncStatus`)
 * so the reconcile activity (Group 3) can compute drift and apply the skip
 * rules from the same lookup it already performs per item. Returns null if not
 * found.
 */
export async function findFabricItemByExternalId(
	projectId: string,
	externalId: string,
): Promise<{
	entityType: PmStateChangeEntityType;
	entityId: string;
	draftingStage: string;
	lastSyncedPmHash: string | null;
	lastPmSyncStatus: PmSyncStatus | null;
	/**
	 * The auto-hide marker. Returned for all three entity types (epic, feature,
	 * and story) — each carries its own `pmAutoHidden` column (#1360 Task 2).
	 */
	pmAutoHidden?: boolean;
} | null> {
	const select = {
		id: true,
		draftingStage: true,
		lastSyncedPmHash: true,
		lastPmSyncStatus: true,
	} as const;

	// Stories are the only work-item rows since the Epic/Feature folder tables
	// were dropped.
	const story = await db.userStory.findFirst({
		where: { projectId, externalId },
		select: { ...select, pmAutoHidden: true },
	});
	if (story) {
		return {
			entityType: "STORY",
			entityId: story.id,
			draftingStage: story.draftingStage,
			lastSyncedPmHash: story.lastSyncedPmHash,
			lastPmSyncStatus: story.lastPmSyncStatus,
			pmAutoHidden: story.pmAutoHidden,
		};
	}

	return null;
}

/**
 * True if a PENDING FLAG_MISSING row already exists for this entity/externalId.
 * Used by the poll's per-cycle cap to gate NET-NEW creates only (refreshes of
 * existing rows must not consume the cap budget).
 */
export async function pendingFlagMissingExists(input: {
	projectId: string;
	entityType: "STORY" | "EPIC" | "FEATURE";
	entityId: string;
	externalId: string;
}): Promise<boolean> {
	const row = await db.pendingPmStateChange.findFirst({
		where: {
			projectId: input.projectId,
			entityType: input.entityType,
			entityId: input.entityId,
			externalId: input.externalId,
			proposedAction: "FLAG_MISSING",
			status: "PENDING",
		},
		select: { id: true },
	});
	return row !== null;
}

/**
 * Returns EVERY Fabric story sharing an externalId within a project, each
 * with its `externalMcpServerId` provenance and draftingStage. The
 * FLAG_MISSING producer uses this instead of the singular first-match
 * `findFabricItemByExternalId` so co-linked rows cannot mask each other.
 * Streaks and flags are keyed per (entityType, entityId, externalId).
 * Stories are the only work-item rows since the Epic/Feature folder tables
 * were dropped.
 */
export async function findFabricItemsByExternalId(
	projectId: string,
	externalId: string,
): Promise<
	Array<{
		entityType: PmStateChangeEntityType;
		entityId: string;
		draftingStage: string;
		externalMcpServerId: string | null;
	}>
> {
	const stories = await db.userStory.findMany({
		where: { projectId, externalId },
		select: {
			id: true,
			draftingStage: true,
			externalMcpServerId: true,
		},
	});
	return stories.map((s) => ({
		entityType: "STORY" as const,
		entityId: s.id,
		draftingStage: s.draftingStage,
		externalMcpServerId: s.externalMcpServerId,
	}));
}

/**
 * Auto-dismiss stale PENDING FLAG_MISSING proposals for PM tickets that
 * reappeared (#1360). For each candidate it does a per-row snapshot
 * compare-and-swap delete — `deleteMany WHERE { id, status: "PENDING",
 * proposedAction: "FLAG_MISSING", externalId, expectedExternalMcpServerId }` — so
 * a row a human Accept concurrently flipped to APPROVED, or one that
 * `upsertPendingChange` refreshed in place to a different ticket, yields count 0,
 * is left intact and NOT reported. The caller audits only rows actually deleted.
 * Server-scoped (`expectedExternalMcpServerId = activeServerId`) and lane-scoped
 * (`proposedAction = "FLAG_MISSING"`); covers EPIC/FEATURE/STORY by externalId.
 */
export async function autoDismissReappearedFlagMissing(input: {
	projectId: string;
	externalIds: string[];
	activeServerId: string;
}): Promise<
	Array<{
		entityType: PmStateChangeEntityType;
		entityId: string;
		externalId: string;
	}>
> {
	const { projectId, externalIds, activeServerId } = input;
	if (externalIds.length === 0) {
		return [];
	}

	const candidates = await db.pendingPmStateChange.findMany({
		where: {
			projectId,
			externalId: { in: externalIds },
			proposedAction: "FLAG_MISSING",
			status: "PENDING",
			expectedExternalMcpServerId: activeServerId,
		},
		select: {
			id: true,
			entityType: true,
			entityId: true,
			externalId: true,
		},
	});

	const dismissed: Array<{
		entityType: PmStateChangeEntityType;
		entityId: string;
		externalId: string;
	}> = [];
	for (const c of candidates) {
		// Snapshot compare-and-swap (Codex plan-R3): re-assert the candidate's
		// externalId + server + lane in the delete, so a row that upsertPendingChange
		// refreshed in place to a DIFFERENT ticket between the findMany and here
		// yields count 0 — it is not deleted and not reported (the refreshed
		// proposal survives).
		const { count } = await db.pendingPmStateChange.deleteMany({
			where: {
				id: c.id,
				status: "PENDING",
				proposedAction: "FLAG_MISSING",
				externalId: c.externalId,
				expectedExternalMcpServerId: activeServerId,
			},
		});
		if (count === 1) {
			dismissed.push({
				entityType: c.entityType,
				entityId: c.entityId,
				externalId: c.externalId,
			});
		}
	}
	return dismissed;
}

/**
 * Clear a story's PENDING CONTENT_DRIFT proposals. Called when the linked PM
 * item goes terminal: a Done/Closed ticket must not carry a dangling
 * content-drift review (emitted or not). Lane-scoped (CONTENT_DRIFT) and
 * status-scoped (PENDING) so HIDE/UNHIDE/FLAG_MISSING and already-DISMISSED
 * rows are untouched. Returns the number of rows deleted.
 */
export async function clearPendingContentDrift(input: {
	projectId: string;
	entityType: PmStateChangeEntityType;
	entityId: string;
}): Promise<number> {
	const { projectId, entityType, entityId } = input;
	const { count } = await db.pendingPmStateChange.deleteMany({
		where: {
			projectId,
			entityType,
			entityId,
			proposedAction: "CONTENT_DRIFT",
			status: "PENDING",
		},
	});
	return count;
}
