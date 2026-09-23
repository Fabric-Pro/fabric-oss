/**
 * Database queries for PendingBacklogProposal — the review inbox backing table.
 *
 * A PendingBacklogProposal stores a ChangeProposal JSON produced by the
 * backlog-context analysis pass, anchored to a source (Teams channel thread in v1).
 * Stories are only created when a user approves the proposal in the inbox UI.
 */

import { db } from "../../client";
import type { Prisma } from "../../generated/client";
import type {
	PendingBacklogProposalSource,
	PendingBacklogProposalStatus,
} from "../../generated/enums";
import { advisoryObjectKey } from "../lib/refresh-lock-key";

/**
 * Structural shape of one `AttachmentWarning` carried on
 * `PendingBacklogProposal.sourceMetadata.attachmentWarnings`. Kept
 * structural (not imported from `@repo/integrations`) to avoid a circular
 * package dependency — `@repo/integrations` already depends on
 * `@repo/database`. The canonical definition lives in
 * `packages/integrations/src/shared/attachment-types.ts`; the two must stay
 * in sync but cannot be made nominal here.
 */
export interface AttachmentWarningRecord {
	source: "slack" | "teams";
	refId: string;
	reason:
		| "unsupported_mime"
		| "image_too_large"
		| "thread_total_exceeded"
		| "count_cap_exceeded"
		| "scope_missing"
		| "external_workspace"
		| "download_failed"
		| "upload_failed"
		| "budget_exceeded";
	detail?: string;
}

/**
 * Extract a change's title, tolerating both the diff shape `{ from?, to }` and
 * a legacy plain-string title. Returns "" when no usable title is present.
 */
function extractChangeTitle(change: unknown): string {
	if (!change || typeof change !== "object") {
		return "";
	}
	const title = (change as { title?: unknown }).title;
	if (typeof title === "string") {
		return title.trim();
	}
	if (title && typeof title === "object" && !Array.isArray(title)) {
		const { to, from } = title as { to?: unknown; from?: unknown };
		if (typeof to === "string" && to.trim()) {
			return to.trim();
		}
		if (typeof from === "string") {
			return from.trim();
		}
	}
	return "";
}

/**
 * Headline for a proposal whose stored `summary` is empty.
 *
 * Monitored-source proposals (Teams channel/chat, Slack, meeting) are captured
 * with an analyzer prompt that asks for a per-change title + reasoning but no
 * top-level `summary`, so `summary` is routinely blank — leaving the review
 * inbox row with nothing to show. `createPendingBacklogProposal` stores this at
 * write time (and the summary backfill script fills pre-existing rows). Derive
 * it from the first change that carries a title, annotating any others.
 */
export function deriveProposalHeadline(proposal: unknown): string {
	if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
		return "";
	}
	const changes = (proposal as { changes?: unknown }).changes;
	if (!Array.isArray(changes) || changes.length === 0) {
		return "";
	}
	const title = changes.map(extractChangeTitle).find(Boolean) ?? "";
	if (!title) {
		return "";
	}
	return changes.length > 1
		? `${title} (+${changes.length - 1} more)`
		: title;
}

/**
 * The headline to store on a proposal: the analyzer's own `summary` when it
 * produced one, else a title derived from the changes. Every proposal write
 * site (this file's create + the two monitor activities that inline the create
 * inside their claim transaction) funnels through here so the review inbox row
 * is never blank.
 */
export function resolveProposalSummary(
	summary: string,
	proposal: unknown,
): string {
	return summary.trim() ? summary : deriveProposalHeadline(proposal);
}

/**
 * Fold an optional decision pre-check result into a proposal's
 * `sourceMetadata` bag under the `decisionPrecheck` key, preserving every
 * other top-level key. Returns the metadata untouched when there is no
 * result, so callers that never run the pre-check behave exactly as before.
 */
function mergeDecisionPrecheck(
	sourceMetadata: Prisma.InputJsonValue | undefined,
	decisionPrecheck: Prisma.InputJsonValue | undefined,
): Prisma.InputJsonValue | undefined {
	if (decisionPrecheck === undefined) {
		return sourceMetadata;
	}
	const base =
		sourceMetadata !== undefined &&
		typeof sourceMetadata === "object" &&
		!Array.isArray(sourceMetadata)
			? (sourceMetadata as Record<string, unknown>)
			: {};
	return { ...base, decisionPrecheck } as unknown as Prisma.InputJsonValue;
}

export interface CreatePendingBacklogProposalParams {
	projectId: string;
	source: PendingBacklogProposalSource;
	proposal: Prisma.InputJsonValue;
	summary: string;
	changeCount: number;
	sourceMetadata?: Prisma.InputJsonValue;
	// Async decision pre-check result to persist alongside the proposal at
	// creation time — the AI-Update path carries findings on the workflow
	// result before any row exists. Merged under
	// `sourceMetadata.decisionPrecheck` so the review UI reads it back durably.
	decisionPrecheck?: Prisma.InputJsonValue;
	userId?: string;
	organizationId?: string;
}

export async function createPendingBacklogProposal(
	params: CreatePendingBacklogProposalParams,
	client: Prisma.TransactionClient = db,
) {
	return await client.pendingBacklogProposal.create({
		data: {
			projectId: params.projectId,
			source: params.source,
			proposal: params.proposal,
			// Store a usable inbox headline. Monitored-source analyzer output
			// leaves the top-level summary blank, so fall back to a change title —
			// keeping the read path a lean projection.
			summary: resolveProposalSummary(params.summary, params.proposal),
			changeCount: params.changeCount,
			sourceMetadata: mergeDecisionPrecheck(
				params.sourceMetadata,
				params.decisionPrecheck,
			),
			userId: params.userId,
			organizationId: params.organizationId,
		},
	});
}

/**
 * Advisory-lock class id namespacing the once-per-run recommendation batch
 * write (arbitrary but stable). Distinct from every other `(int4, int4)`
 * class in the package, so it never collides with an unrelated lock domain.
 */
const ROADMAP_RECOMMENDATION_BATCH_ADVISORY_CLASS = 0x52524263; // "RRBc"

/**
 * Create the ROADMAP_RECOMMENDATION batch for one workflow run, at most once
 * (Fizzy #2208). Temporal can run two attempts of the persist activity at
 * once (a heartbeat-timed-out attempt keeps running beside its retry), so a
 * plain find-then-create would let both miss and insert two batches. The
 * run's advisory lock serializes the check and the create: the second
 * attempt waits, then finds the first one's row.
 */
export async function createRoadmapRecommendationBatchOnce(
	params: Omit<CreatePendingBacklogProposalParams, "source"> & {
		workflowRunId: string;
	},
): Promise<{ id: string; changeCount: number; created: boolean }> {
	const { workflowRunId, ...create } = params;
	return db.$transaction(
		async (tx) => {
			// `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock()` returns
			// void, which the driver adapter's `$queryRaw` cannot deserialize.
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROADMAP_RECOMMENDATION_BATCH_ADVISORY_CLASS}::int, ${advisoryObjectKey(workflowRunId)}::int)`;
			const existing = await tx.pendingBacklogProposal.findFirst({
				where: {
					projectId: create.projectId,
					source: "ROADMAP_RECOMMENDATION",
					sourceMetadata: {
						path: ["workflowRunId"],
						equals: workflowRunId,
					},
				},
				select: { id: true, changeCount: true },
			});
			if (existing) {
				return { ...existing, created: false };
			}
			const row = await createPendingBacklogProposal(
				{ ...create, source: "ROADMAP_RECOMMENDATION" },
				tx,
			);
			return { id: row.id, changeCount: row.changeCount, created: true };
		},
		{ timeout: 10_000, maxWait: 10_000 },
	);
}

export async function listPendingBacklogProposals(params: {
	projectId: string;
	status?: PendingBacklogProposalStatus | PendingBacklogProposalStatus[];
	limit?: number;
}) {
	const statusFilter = Array.isArray(params.status)
		? { in: params.status }
		: params.status;
	return await db.pendingBacklogProposal.findMany({
		where: {
			projectId: params.projectId,
			...(statusFilter !== undefined ? { status: statusFilter } : {}),
		},
		select: {
			id: true,
			source: true,
			status: true,
			summary: true,
			changeCount: true,
			sourceMetadata: true,
			applyError: true,
			errorClass: true,
			errorMessage: true,
			failedAt: true,
			createdAt: true,
			reviewedAt: true,
			appliedAt: true,
			// Drives the "Applying…" affordance + Cancel control: a PENDING row
			// with a dispatch timestamp is mid-apply (vs. awaiting review).
			applyStartedAt: true,
		},
		orderBy: { createdAt: "desc" },
		// Show the full pending set the roadmap banner already counts (via a
		// separate COUNT) rather than only the newest 50; 200 is a safety bound.
		take: params.limit ?? 200,
	});
}

export async function getPendingBacklogProposal(proposalId: string) {
	return await db.pendingBacklogProposal.findUnique({
		where: { id: proposalId },
	});
}

export async function countPendingBacklogProposals(
	projectId: string,
	status: PendingBacklogProposalStatus | PendingBacklogProposalStatus[] = [
		"PENDING",
		"FAILED",
	],
) {
	const statusFilter = Array.isArray(status) ? { in: status } : status;
	return await db.pendingBacklogProposal.count({
		where: { projectId, status: statusFilter },
	});
}

/**
 * Update only the applyWorkflowId field on a proposal. Separate from
 * markPendingProposalApproved so callers can set the workflow id after
 * launching a workflow without risking an overwrite of a terminal state
 * that the workflow may have already reached.
 */
export async function setProposalApplyWorkflowId(
	proposalId: string,
	applyWorkflowId: string | null,
) {
	return await db.pendingBacklogProposal.update({
		where: { id: proposalId },
		data: { applyWorkflowId },
	});
}

/**
 * Append change-indexes to `appliedChangeIndexes` on the proposal. Used to
 * track which creates have succeeded so retries of FAILED proposals can skip
 * already-applied work. No-op if the indexes are already recorded.
 */
export async function appendAppliedChangeIndexes(
	proposalId: string,
	indexes: number[],
) {
	if (indexes.length === 0) {
		return;
	}
	const existing = await db.pendingBacklogProposal.findUnique({
		where: { id: proposalId },
		select: { appliedChangeIndexes: true },
	});
	if (!existing) {
		return;
	}
	const merged = Array.from(
		new Set([...(existing.appliedChangeIndexes ?? []), ...indexes]),
	);
	await db.pendingBacklogProposal.update({
		where: { id: proposalId },
		data: { appliedChangeIndexes: merged },
	});
}

export async function markPendingProposalApproved(params: {
	proposalId: string;
	reviewedBy: string;
	applyWorkflowId?: string | null;
}) {
	return await db.pendingBacklogProposal.update({
		where: { id: params.proposalId },
		data: {
			status: "APPROVED",
			reviewedAt: new Date(),
			reviewedBy: params.reviewedBy,
			applyWorkflowId: params.applyWorkflowId ?? null,
			applyError: null,
		},
	});
}

export async function markPendingProposalApplied(proposalId: string) {
	return await db.pendingBacklogProposal.update({
		where: { id: proposalId },
		data: {
			status: "APPLIED",
			appliedAt: new Date(),
			applyError: null,
		},
	});
}

/**
 * Mark a proposal FAILED and persist the classified failure metadata.
 *
 * Three columns are written:
 *   - `errorClass`  — classifier output (`unwrapPmSyncError(...).errorClass`,
 *                     e.g. "PmAuthError"), truncated to 200 chars. Drives the
 *                     plain-English failure copy lookup on the inbox.
 *   - `errorMessage`— canonical short summary, truncated to 500 chars.
 *                     Renders inside the inbox row above the raw applyError.
 *   - `applyError`  — raw full text (truncated to 4000 chars). Falls back to
 *                     `errorMessage` when the caller doesn't supply
 *                     `rawApplyError`, preserving the legacy single-string
 *                     behaviour for callers that only have a flat string in
 *                     hand.
 *
 * `failedAt` is stamped to `new Date()` so the inbox + roadmap banner can
 * sort failed proposals by recency.
 *
 * The single-string overload was dropped in the same PR that introduced this
 * signature; every caller passes the structured object.
 */
export async function markPendingProposalFailed(
	proposalId: string,
	params: {
		errorClass: string;
		errorMessage: string;
		rawApplyError?: string;
	},
) {
	return await db.pendingBacklogProposal.update({
		where: { id: proposalId },
		data: {
			status: "FAILED",
			errorClass: params.errorClass.slice(0, 200),
			errorMessage: params.errorMessage.slice(0, 500),
			applyError: (params.rawApplyError ?? params.errorMessage).slice(
				0,
				4000,
			),
			failedAt: new Date(),
		},
	});
}

/**
 * Stamp the proposal at apply-dispatch time: records the workflow id AND the
 * dispatch wall-clock the stuck-apply watchdog measures staleness from. Call
 * right after `client.workflow.start("backlogApplyChangesWorkflow", …)` on the
 * AI Update apply path (the retry paths fold both fields into their atomic
 * PENDING flip instead, so they need no extra write).
 *
 * The write is a compare-and-set, because a fast workflow can finalize before
 * it lands:
 *   - `claimed`: the row carries this caller's claim (APPLYING + this
 *     workflow id). A late stamp after a keep-open finalize (the row is back
 *     to PENDING, awaiting review) or after another tab re-claimed the row
 *     matches nothing, so it can neither arm the watchdog against a batch
 *     waiting on a person nor overwrite the live claimant.
 *   - `fresh`: the row was created by this call and never claimed (PENDING,
 *     no workflow id yet). A row someone else claimed in between is left alone.
 *
 * Only `claimed` is distinguished by the caller: after a keep-open finalize a
 * claimed row looks exactly like a fresh one.
 *
 * @returns rows stamped — 0 when the row moved on before the stamp landed.
 */
export async function markProposalApplyDispatched(params: {
	proposalId: string;
	applyWorkflowId: string;
	mode: "claimed" | "fresh";
}): Promise<number> {
	const res = await db.pendingBacklogProposal.updateMany({
		where:
			params.mode === "claimed"
				? {
						id: params.proposalId,
						status: "APPLYING",
						applyWorkflowId: params.applyWorkflowId,
					}
				: {
						id: params.proposalId,
						status: "PENDING",
						applyWorkflowId: null,
					},
		data: {
			applyWorkflowId: params.applyWorkflowId,
			applyStartedAt: new Date(),
		},
	});
	return res.count;
}

/**
 * Compare-and-set terminal stop for a proposal still mid-apply — used by manual
 * cancel and by the stuck-apply watchdog. Transitions ONLY `PENDING → FAILED`
 * (a `updateMany` status guard), so a concurrent workflow finalize or a second
 * stop can't be clobbered: whoever flips the row out of PENDING first wins.
 *
 * Reuses the FAILED terminal state (with a distinguishing `errorClass` —
 * "Cancelled" / "TimedOut") rather than a new enum value, so the existing
 * Retry / Dismiss inbox controls keep working on a stopped proposal.
 *
 * @returns rows updated — 1 when this caller won the transition, 0 when the row
 * was already terminal (or never pending).
 */
export async function stopApplyingProposal(params: {
	proposalId: string;
	errorClass: string;
	errorMessage: string;
}): Promise<number> {
	const res = await db.pendingBacklogProposal.updateMany({
		where: { id: params.proposalId, status: "PENDING" },
		data: {
			status: "FAILED",
			errorClass: params.errorClass.slice(0, 200),
			errorMessage: params.errorMessage.slice(0, 500),
			applyError: params.errorMessage.slice(0, 4000),
			failedAt: new Date(),
		},
	});
	return res.count;
}

/**
 * Find proposals stuck mid-apply: still `PENDING` with an apply dispatched
 * (`applyStartedAt` set) longer than `cutoff` ago. Awaiting-review proposals
 * (`applyStartedAt = null`) are never returned, so the watchdog can never touch
 * a proposal that's legitimately waiting on a human. Oldest dispatch first,
 * capped by `limit`. Global (not project-scoped): the stuck-apply watchdog is a
 * system sweep, mirroring the Weave execution watchdog.
 */
export async function findStaleApplyingProposals(params: {
	cutoff: Date;
	limit: number;
}): Promise<
	Array<{
		id: string;
		projectId: string;
		organizationId: string | null;
		applyWorkflowId: string | null;
		applyStartedAt: Date | null;
	}>
> {
	return await db.pendingBacklogProposal.findMany({
		where: {
			status: "PENDING",
			applyStartedAt: { not: null, lt: params.cutoff },
		},
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			applyWorkflowId: true,
			applyStartedAt: true,
		},
		orderBy: { applyStartedAt: "asc" },
		take: params.limit,
	});
}

/**
 * List FAILED proposals for a project, ordered by most recently failed.
 *
 * Used by the roadmap-banner failed-count query (via `countPendingBacklogProposals`),
 * the inbox "Failed (N)" group, and the retry-all batch path. The optional
 * `source` filter takes either a single enum value or an array — undefined
 * matches every source.
 *
 * Tenant XOR is enforced by the caller (the procedure layer resolves
 * `{ organizationId, userId }` and either calls this with a project id that
 * already belongs to the resolved tenancy or post-filters by the same pair).
 */
export async function listFailedProposals(params: {
	projectId: string;
	source?: PendingBacklogProposalSource | PendingBacklogProposalSource[];
}) {
	const sourceFilter = Array.isArray(params.source)
		? { in: params.source }
		: params.source;
	return await db.pendingBacklogProposal.findMany({
		where: {
			projectId: params.projectId,
			status: "FAILED",
			...(sourceFilter !== undefined ? { source: sourceFilter } : {}),
		},
		orderBy: { failedAt: "desc" },
	});
}

/**
 * Reject (dismiss) a proposal via a status compare-and-set: PENDING, FAILED, or
 * BACKLOG proposals can be rejected. BACKLOG is included so a deferred proposal
 * can be transitioned to REJECTED (FR5) — without it, reject-from-backlog
 * matches 0 rows and surfaces a false "already actioned" conflict. A proposal
 * another reviewer already actioned (APPROVED/APPLIED/REJECTED/SUPERSEDED)
 * matches 0 rows, so `updated` is false and the caller surfaces a conflict
 * instead of silently overwriting the other reviewer's decision. Race-safe —
 * the guard is the WHERE clause, not a prior read.
 */
export async function markPendingProposalRejected(params: {
	proposalId: string;
	reviewedBy: string;
}): Promise<{ updated: boolean }> {
	const result = await db.pendingBacklogProposal.updateMany({
		where: {
			id: params.proposalId,
			status: { in: ["PENDING", "FAILED", "BACKLOG"] },
		},
		data: {
			status: "REJECTED",
			reviewedAt: new Date(),
			reviewedBy: params.reviewedBy,
		},
	});
	return { updated: result.count === 1 };
}

/**
 * Move a proposal to BACKLOG via a status compare-and-set: only a PENDING
 * proposal can be deferred (the "Move to Backlog" action is offered on pending
 * rows only). A proposal another reviewer already actioned matches 0 rows, so
 * `updated` is false and the caller surfaces a conflict instead of silently
 * overwriting the other decision. Race-safe — the guard is the WHERE clause.
 *
 * BACKLOG is a deferral, NOT a dismissal: the row is preserved and stays
 * retrievable, but is excluded from every active list / count / context path
 * exactly like REJECTED (all of which use inclusive status allow-lists, so a
 * distinct BACKLOG value is auto-excluded). It is reversible — a later approve
 * or reject transitions it out (see `approve-pending-proposal` which now admits
 * BACKLOG, and `markPendingProposalRejected`).
 */
export async function markPendingProposalBacklog(params: {
	proposalId: string;
	reviewedBy: string;
}): Promise<{ updated: boolean }> {
	const result = await db.pendingBacklogProposal.updateMany({
		where: {
			id: params.proposalId,
			status: "PENDING",
		},
		data: {
			status: "BACKLOG",
			reviewedAt: new Date(),
			reviewedBy: params.reviewedBy,
		},
	});
	return { updated: result.count === 1 };
}

/**
 * Merge an apply-time set of `AttachmentWarning` entries into the proposal's
 * `sourceMetadata.attachmentWarnings` JSON, preserving every other top-level
 * key of `sourceMetadata`.
 *
 * Called by the Slack and Teams `approve-pending-proposal` procedures after
 * the central `attachPendingMediaToStory` orchestrator returns its
 * cumulative warning list. Spec § 4.6 step 8, FR-22, FR-23.
 *
 * Behaviour:
 *   - Reads the existing row's `sourceMetadata` (so we don't have to
 *     duplicate the other keys — `channelDisplayName`, `threadRootId`,
 *     etc. — into the update payload).
 *   - Merges the new warnings with the existing array (if any), deduping
 *     by the `{ source, refId, reason }` triple per decisions § 12.
 *   - Writes the merged JSON back via a single Prisma `update`.
 *
 * Idempotency: on rerun with the same warnings, the dedup
 * step collapses every duplicate into the previously-stored entry. On
 * rerun with an empty `warnings` array AND no existing warnings, the
 * function exits early without performing any write — the caller can
 * trust this to be a no-op on the common "no warnings happened" path.
 *
 * Tenant XOR: this function does NOT filter by project / org. Tenant
 * isolation is enforced by the caller (the `tenantProtectedProcedure`
 * inside the approve handler resolves `proposalId` from the current
 * project's `listPendingBacklogProposals` result, so a foreign proposal
 * id can never reach this function).
 */
export async function setPendingProposalAttachmentResult(
	proposalId: string,
	warnings: AttachmentWarningRecord[],
): Promise<void> {
	const existing = await db.pendingBacklogProposal.findUnique({
		where: { id: proposalId },
		select: { sourceMetadata: true },
	});
	if (!existing) {
		// No such proposal — silently drop. This mirrors the
		// `appendAppliedChangeIndexes` early-return behavior for the same
		// shape of race / deletion.
		return;
	}

	const existingMeta =
		existing.sourceMetadata !== null &&
		typeof existing.sourceMetadata === "object" &&
		!Array.isArray(existing.sourceMetadata)
			? (existing.sourceMetadata as Record<string, unknown>)
			: {};

	const existingWarnings = Array.isArray(existingMeta.attachmentWarnings)
		? (existingMeta.attachmentWarnings as AttachmentWarningRecord[])
		: [];

	// Fast-path no-op: rerun with empty warnings and no existing warnings —
	// nothing to merge, so skip the write entirely.
	if (warnings.length === 0 && existingWarnings.length === 0) {
		return;
	}

	// Dedup by `{ source, refId, reason }` triple. Order-preserving:
	// existing entries come first, new ones (only the ones not already
	// represented) are appended.
	const seen = new Set<string>();
	const merged: AttachmentWarningRecord[] = [];
	const keyOf = (w: AttachmentWarningRecord) =>
		`${w.source}\0${w.refId}\0${w.reason}`;
	for (const w of existingWarnings) {
		const k = keyOf(w);
		if (!seen.has(k)) {
			seen.add(k);
			merged.push(w);
		}
	}
	for (const w of warnings) {
		const k = keyOf(w);
		if (!seen.has(k)) {
			seen.add(k);
			merged.push(w);
		}
	}

	const nextMeta = {
		...existingMeta,
		attachmentWarnings: merged,
	};

	await db.pendingBacklogProposal.update({
		where: { id: proposalId },
		// `attachmentWarnings: AttachmentWarningRecord[]` is structurally
		// compatible with `Prisma.InputJsonValue` (each entry is a flat
		// `{ string, string, string, string? }` object), but TypeScript can't
		// prove the structural-vs-nominal match — funnel through `unknown`.
		data: {
			sourceMetadata: nextMeta as unknown as Prisma.InputJsonValue,
		},
	});
}

// ---------------------------------------------------------------------------
// Apply claiming + idempotent application records (plan §F3)
// ---------------------------------------------------------------------------

/**
 * Atomically claim a proposal for application: PENDING | FAILED → APPLYING,
 * stamping the workflow that owns the apply. Returns false when another
 * claimant won (or the proposal is in a terminal state). Every subsequent
 * write must include the same `applyWorkflowId`, so only the claimant can
 * advance the row.
 */
export async function claimPendingProposalForApply(params: {
	proposalId: string;
	reviewedBy: string;
	applyWorkflowId: string;
	/**
	 * Also claim a BACKLOG (moved-to-Rejected) row. Passed only for a
	 * ROADMAP_RECOMMENDATION batch, whose only accept door is apply-changes;
	 * without it a batch moved to Rejected could never be restored.
	 */
	admitBacklog?: boolean;
}): Promise<boolean> {
	const claimable: Array<"PENDING" | "FAILED" | "BACKLOG"> =
		params.admitBacklog
			? ["PENDING", "FAILED", "BACKLOG"]
			: ["PENDING", "FAILED"];
	const result = await db.pendingBacklogProposal.updateMany({
		where: {
			id: params.proposalId,
			status: { in: claimable },
		},
		data: {
			status: "APPLYING",
			reviewedAt: new Date(),
			reviewedBy: params.reviewedBy,
			applyWorkflowId: params.applyWorkflowId,
			applyError: null,
		},
	});
	return result.count === 1;
}

/**
 * Retry-door branch for a FAILED ROADMAP_RECOMMENDATION batch (Fizzy #2208):
 * FAILED → PENDING with the claim and failure fields cleared, so the reviewer
 * re-selects what to accept. The stored changes do not record which
 * candidates were selected, so replaying them would create features nobody
 * accepted. Returns false when the row is no longer FAILED.
 */
export async function returnFailedRecommendationToReview(
	proposalId: string,
): Promise<boolean> {
	const result = await db.pendingBacklogProposal.updateMany({
		where: { id: proposalId, status: "FAILED" },
		data: {
			status: "PENDING",
			applyWorkflowId: null,
			applyStartedAt: null,
			applyError: null,
			errorClass: null,
			errorMessage: null,
			failedAt: null,
		},
	});
	return result.count === 1;
}

/**
 * Change indexes already applied for a proposal, read from the application
 * table (authoritative). `appliedChangeIndexes` is kept as a mirror for one
 * release for readers that have not migrated.
 */
export async function getAppliedChangeIndexes(
	proposalId: string,
): Promise<Set<number>> {
	const rows = await db.pendingBacklogProposalApplication.findMany({
		where: { proposalId },
		select: { changeIndex: true },
	});
	return new Set(rows.map((r) => r.changeIndex));
}

/**
 * Record that `changeIndex` of `proposalId` was applied, in the SAME
 * transaction as the mutation it records. Idempotent on the unique
 * (proposalId, changeIndex): a retry that re-applies is rejected by the
 * unique index before it can create a second entity. Also mirrors into the
 * legacy `appliedChangeIndexes` array.
 */
export async function recordProposalApplication(
	tx: Prisma.TransactionClient,
	params: {
		proposalId: string;
		changeIndex: number;
		action: "create" | "update";
		createdEntityType?: "epic" | "feature" | "story" | "bug";
		createdEntityId?: string;
	},
): Promise<void> {
	await tx.pendingBacklogProposalApplication.create({
		data: {
			proposalId: params.proposalId,
			changeIndex: params.changeIndex,
			action: params.action,
			createdEntityType: params.createdEntityType,
			createdEntityId: params.createdEntityId,
		},
	});
	const existing = await tx.pendingBacklogProposal.findUnique({
		where: { id: params.proposalId },
		select: { appliedChangeIndexes: true },
	});
	if (
		existing &&
		!existing.appliedChangeIndexes.includes(params.changeIndex)
	) {
		await tx.pendingBacklogProposal.update({
			where: { id: params.proposalId },
			data: {
				appliedChangeIndexes: {
					set: [...existing.appliedChangeIndexes, params.changeIndex],
				},
			},
		});
	}
}

/**
 * Claimant-checked terminal transitions. Only the workflow that claimed the
 * proposal (matching `applyWorkflowId`) may flip it out of APPLYING.
 * Returns false when the caller is not the claimant or the row moved on.
 */
export async function finalizeClaimedProposal(params: {
	proposalId: string;
	applyWorkflowId: string;
	outcome: "applied" | "failed";
	errorMessage?: string;
	errorClass?: string;
	rawApplyError?: string;
}): Promise<boolean> {
	// Fizzy #2208 partial accept: a ROADMAP_RECOMMENDATION batch keeps its
	// unaccepted candidates in review. While any change is unresolved the row
	// returns to PENDING (claim released, watchdog clock cleared) instead of
	// closing, whether this apply succeeded or failed: a retry door would
	// replay every unapplied change, including candidates nobody selected.
	const row = await db.pendingBacklogProposal.findUnique({
		where: { id: params.proposalId },
		select: { source: true, changeCount: true, appliedChangeIndexes: true },
	});
	if (row?.source === "ROADMAP_RECOMMENDATION") {
		const applications =
			await db.pendingBacklogProposalApplication.findMany({
				where: { proposalId: params.proposalId },
				select: { changeIndex: true },
			});
		const resolved = new Set([
			...applications.map((a) => a.changeIndex),
			...row.appliedChangeIndexes,
		]);
		if (resolved.size < row.changeCount) {
			const failed = params.outcome === "failed";
			const reopened = await db.pendingBacklogProposal.updateMany({
				where: {
					id: params.proposalId,
					status: "APPLYING",
					applyWorkflowId: params.applyWorkflowId,
				},
				data: {
					status: "PENDING",
					applyWorkflowId: null,
					applyStartedAt: null,
					...(failed
						? {
								applyError: (
									params.rawApplyError ??
									params.errorMessage ??
									"apply workflow failed"
								).slice(0, 4000),
								errorClass: (
									params.errorClass ?? "default"
								).slice(0, 200),
								errorMessage: (
									params.errorMessage ??
									"apply workflow failed"
								).slice(0, 500),
								failedAt: new Date(),
							}
						: {
								applyError: null,
								errorClass: null,
								errorMessage: null,
								failedAt: null,
							}),
				},
			});
			return reopened.count === 1;
		}
	}

	const result = await db.pendingBacklogProposal.updateMany({
		where: {
			id: params.proposalId,
			status: "APPLYING",
			applyWorkflowId: params.applyWorkflowId,
		},
		data:
			params.outcome === "applied"
				? { status: "APPLIED", appliedAt: new Date(), applyError: null }
				: {
						status: "FAILED",
						applyError: (
							params.errorMessage ?? "apply workflow failed"
						).slice(0, 4000),
					},
	});
	return result.count === 1;
}
