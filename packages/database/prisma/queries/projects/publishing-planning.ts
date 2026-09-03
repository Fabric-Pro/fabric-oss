/**
 * Planning & Analysis persistence (Publishing Suite Phase 2A-2, Fizzy #1851).
 *
 * Three writes and one read, and every one of them is shaped by a race this
 * repository has already lost once somewhere else:
 *
 *  - `startPlanningAnalysisAttempt` locks the Project `FOR UPDATE` and derives
 *    the tenant tuple from the LOCKED row, because `resolveProjectTenant`
 *    followed by a create is two ops with an org transfer possible in between —
 *    the "C-High (tenant TOCTOU)" that `createManualPublishingTopic` exists to
 *    fix.
 *  - `completePlanningAnalysis` / `failPlanningAnalysis` re-validate that tuple
 *    under lock, because the model call between start and finish takes minutes,
 *    and they CAS on `status = 'GENERATING'`, because a reclaimed attempt's
 *    activity is still running and must not resurrect itself.
 *  - `getLatestPlanningAnalysis` returns two rows rather than one, because a
 *    failed regeneration must not blank a good previous analysis.
 */

import { db } from "../../client";
import type {
	ReconcilableQuestion,
	ReconcileOutcome,
} from "./publishing-decisions";
import { reconcileTopicQuestions } from "./publishing-decisions";
// The tenant fence lives beside this module rather than in it, because
// `publishing-drafts.ts` needs the identical check and a second copy of the
// thing that stops one org's row being written under another's identity is the
// worst duplication in this subsystem.
import {
	type DraftCommitOutcome,
	type DraftCommitRefusal,
	isUniqueViolation,
	lockProjectTenant,
	sameTenant,
} from "./publishing-tenant-lock";

/** How long a GENERATING row stays valid before a later attempt may reclaim it. */
export const PLANNING_ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000;

export type PlanningAnalysisPromptSource =
	| "BOUND"
	| "DEFAULT_UNBOUND"
	| "DEFAULT_RENDER_FAILED";

export type StartPlanningAnalysisResult =
	| { status: "started"; analysisId: string; version: number }
	| { status: "in_flight" }
	/**
	 * The project is gone, archived or soft-deleted as of the lock.
	 *
	 * Distinct from `not_found` on purpose. Both used to collapse into "topic not
	 * found", which is untrue when the topic is fine and the project was archived
	 * in another tab between the caller's eligibility check and this lock.
	 * Separating them leaks nothing: a caller only reaches here after proving
	 * this project ACTIVE, so being told it no longer is says nothing new —
	 * whereas topic existence stays indistinguishable, which is the part DV16
	 * protects.
	 */
	| { status: "project_ineligible" }
	| { status: "not_found" };

/**
 * Open a new Planning & Analysis attempt for one topic.
 *
 * Lock order is fixed — Project first, then the analysis rows — so two
 * concurrent attempts on the same topic cannot deadlock against each other.
 */
export async function startPlanningAnalysisAttempt(input: {
	topicId: string;
	projectId: string;
	requestedById: string;
}): Promise<StartPlanningAnalysisResult> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { status: "project_ineligible" as const };
		}

		// Re-scope the topic by BOTH ids. A topic id alone is never trusted: a
		// valid id from another project must resolve to the same nothing a
		// missing one does (DV16).
		const topic = await tx.publishingTopic.findFirst({
			where: { id: input.topicId, projectId: input.projectId },
			select: { id: true },
		});
		if (!topic) {
			return { status: "not_found" as const };
		}

		// Reclaim an orphaned attempt. Without this the partial unique index is a
		// PERMANENT lock: a worker that dies between the insert below and the
		// terminal marker leaves a GENERATING row that refuses every later
		// attempt, and no user action recovers it.
		//
		// The blocker is looked up by (topicId, projectId) — matching the index,
		// which is NOT tenant-scoped — because a row stamped with an OLD tenant
		// still holds the slot. Tenant-scoping this lookup would miss that blocker
		// and leave the topic stuck on it forever. The tenant decision belongs in
		// the reclaim rule below, not in the lookup. Same shape as
		// `dispatch-suggestion.ts`'s F2 cross-tenant supersede.
		const blocker = await tx.publishingTopicPlanningAnalysis.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				status: "GENERATING",
			},
			select: {
				id: true,
				organizationId: true,
				userId: true,
				executionTimeoutAt: true,
			},
		});
		if (blocker) {
			// A row whose stored tuple no longer matches the project's is
			// reclaimed UNCONDITIONALLY, deadline or not: the terminal fence below
			// guarantees it can never legitimately complete, so making the topic
			// wait out ten minutes for a row that is already dead would be a lock
			// with no purpose.
			const tenantIntact = sameTenant(blocker, tenant);
			const expired =
				blocker.executionTimeoutAt != null &&
				blocker.executionTimeoutAt.getTime() < Date.now();
			if (!tenantIntact || expired) {
				await tx.publishingTopicPlanningAnalysis.updateMany({
					where: {
						id: blocker.id,
						projectId: input.projectId,
						status: "GENERATING",
					},
					data: {
						status: "FAILED",
						error: tenantIntact
							? "Generation timed out before it reported a result."
							: "Superseded: the project moved to a different owner while this run was in flight (transfer).",
						executionTimeoutAt: null,
					},
				});
			}
		}

		const { _max } = await tx.publishingTopicPlanningAnalysis.aggregate({
			where: { topicId: input.topicId, projectId: input.projectId },
			_max: { version: true },
		});
		const version = (_max?.version ?? 0) + 1;

		try {
			const created = await tx.publishingTopicPlanningAnalysis.create({
				data: {
					topicId: input.topicId,
					projectId: input.projectId,
					// Tenancy, from the locked row — never from client input and
					// never from ambient context.
					organizationId: tenant.organizationId,
					userId: tenant.userId,
					// Authorship. A different column on purpose: for an org project
					// `userId` is null, and conflating the two is what the XOR CHECK
					// would reject.
					requestedById: input.requestedById,
					version,
					status: "GENERATING",
					executionTimeoutAt: new Date(
						Date.now() + PLANNING_ANALYSIS_TIMEOUT_MS,
					),
				},
				select: { id: true, version: true },
			});
			return {
				status: "started" as const,
				analysisId: created.id,
				version: created.version,
			};
		} catch (error) {
			// The partial unique index fired: another attempt is genuinely in
			// flight. A double-click is routine, so this is an answer rather than
			// a 500.
			if (isUniqueViolation(error)) {
				return { status: "in_flight" as const };
			}
			throw error;
		}
	});
}

/**
 * Commit a finished analysis.
 *
 * TWO guards, and neither subsumes the other:
 *
 *  1. The project tuple is re-validated under lock. The activity checked it
 *     before a multi-minute model call; a transfer, archive or delete during
 *     that call must not be committed under the stale tenant.
 *  2. The write CASes on `status = 'GENERATING'`. Once a deadline reclaim has
 *     marked this attempt FAILED and let a newer one through the partial index,
 *     this attempt's activity is still running — without the CAS it would
 *     resurrect itself to READY, leaving two terminal rows for one topic with
 *     the older one silently newer.
 *
 * A lost CAS is not an error. It means the attempt was superseded, which is a
 * normal outcome, so it returns `{ persisted: false }` rather than throwing.
 */
export async function completePlanningAnalysis(input: {
	id: string;
	projectId: string;
	content: unknown;
	sourceRefs: unknown;
	model: string | null;
	promptSource: PlanningAnalysisPromptSource;
	// REQUIRED, not optional (Phase 2A-3 fix round 1). `questions?: ...` with
	// `input.questions ?? []` conflated "the caller passed nothing" with "the
	// analysis raised no questions" — and the second meaning soft-closes EVERY
	// live OPEN root. There is exactly one production caller and it always
	// passes a value, so an explicit array costs it nothing and removes a mode
	// that can silently wipe a topic's open questions.
	questions: ReconcilableQuestion[];
}): Promise<
	| { persisted: true; reconciled: ReconcileOutcome | null }
	| { persisted: false; reason: DraftCommitRefusal; reconciled: null }
> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return {
				persisted: false,
				reason: "project_ineligible",
				reconciled: null,
			};
		}

		// TENANT FENCE. The lock above proves the project is still eligible; it
		// does NOT prove this attempt belongs to the tenant that now owns it. An
		// attempt opened under org A and completed after a transfer to org B would
		// otherwise be marked READY, putting content generated under A's identity
		// in front of B's members on a row whose own columns contradict its
		// project. `dispatch-suggestion.ts` already defends the sibling table this
		// way; this table needs the same fence.
		const stored = await tx.publishingTopicPlanningAnalysis.findFirst({
			where: { id: input.id, projectId: input.projectId },
			select: {
				organizationId: true,
				userId: true,
				topicId: true,
				version: true,
			},
		});
		if (!stored) {
			return {
				persisted: false,
				reason: "attempt_missing",
				reconciled: null,
			};
		}
		if (!sameTenant(stored, tenant)) {
			return {
				persisted: false,
				reason: "tenant_changed",
				reconciled: null,
			};
		}

		const { count } = await tx.publishingTopicPlanningAnalysis.updateMany({
			where: {
				id: input.id,
				projectId: input.projectId,
				status: "GENERATING",
			},
			data: {
				status: "READY",
				content: input.content as object,
				sourceRefs: input.sourceRefs as object,
				model: input.model,
				promptSource: input.promptSource,
				error: null,
				// Terminal rows may leave the deadline NULL — the CHECK only binds
				// it while GENERATING — and clearing it keeps a stale timestamp
				// from reading like a live one.
				executionTimeoutAt: null,
			},
		});
		if (count === 0) {
			// A reclaimed attempt. Its analysis is not the one the topic will show,
			// so its questions must not be minted either.
			return { persisted: false, reason: "superseded", reconciled: null };
		}

		// Reconcile inside THIS transaction. Outside it, a crash between the READY
		// flip and the minting would leave a terminal analysis whose questions were
		// never created, and nothing would ever retry it.
		const reconciled = await reconcileTopicQuestions(
			tx as unknown as Parameters<typeof reconcileTopicQuestions>[0],
			{
				topicId: stored.topicId,
				projectId: input.projectId,
				// The tenant tuple comes from the LOCKED project row, not from the
				// stored analysis and never from client input.
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				analysisVersion: stored.version,
				questions: input.questions,
			},
		);

		return { persisted: true, reconciled };
	});
}

/**
 * Mark an attempt failed.
 *
 * Same treatment as the success path — the lock, the tenant fence and the CAS —
 * and for a reason worth stating: this writes only an error string, but writing
 * that string into a reclaimed row, or into a row whose project has moved to a
 * different owner, is still a wrong write. A cheap payload does not make an
 * unscoped write safe, and the failure path is the one that runs when things
 * are already going wrong.
 *
 * When the fence refuses, the row is left GENERATING on purpose: it no longer
 * belongs to this project's tenant, and the next attempt's cross-tenant reclaim
 * is what terminalises it under the correct lock.
 */
export async function failPlanningAnalysis(input: {
	id: string;
	projectId: string;
	error: string;
}): Promise<DraftCommitOutcome> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { persisted: false, reason: "project_ineligible" };
		}

		const stored = await tx.publishingTopicPlanningAnalysis.findFirst({
			where: { id: input.id, projectId: input.projectId },
			select: { organizationId: true, userId: true },
		});
		if (!stored) {
			return { persisted: false, reason: "attempt_missing" };
		}
		if (!sameTenant(stored, tenant)) {
			return { persisted: false, reason: "tenant_changed" };
		}

		const { count } = await tx.publishingTopicPlanningAnalysis.updateMany({
			where: {
				id: input.id,
				projectId: input.projectId,
				status: "GENERATING",
			},
			data: {
				status: "FAILED",
				error: input.error.slice(0, 2000),
				executionTimeoutAt: null,
			},
		});
		return count > 0
			? { persisted: true }
			: { persisted: false, reason: "superseded" };
	});
}

export interface PlanningAnalysisRecord {
	id: string;
	version: number;
	status: string;
	content: unknown;
	sourceRefs: unknown;
	model: string | null;
	promptSource: string | null;
	error: string | null;
	requestedById: string | null;
	createdAt: Date;
	updatedAt: Date;
	/**
	 * A GENERATING row whose deadline has passed and which nothing terminalised.
	 *
	 * It exists because the ONLY code that reclaims a stranded row runs inside
	 * `startPlanningAnalysisAttempt`, and a UI that disables its generate button
	 * while an attempt reads GENERATING can never reach it — a run whose worker
	 * never started would lock the topic with no user action able to free it.
	 * Computed from the SERVER clock, so no client's skew can widen or narrow it.
	 */
	isExpired: boolean;
}

const ANALYSIS_SELECT = {
	id: true,
	executionTimeoutAt: true,
	version: true,
	status: true,
	content: true,
	sourceRefs: true,
	model: true,
	promptSource: true,
	error: true,
	requestedById: true,
	createdAt: true,
	updatedAt: true,
} as const;

/**
 * The topic's current Planning & Analysis state, as TWO rows.
 *
 * `latestReady` is what to render; `latestAttempt` is what to say about it. One
 * row cannot carry both: returning only "the newest row" would blank a perfectly
 * good analysis the moment a regeneration failed, and hide it again while the
 * next one runs — which is precisely when a user most wants to read the last
 * good one.
 *
 * Both reads are scoped by `projectId`, so a topic id from another project
 * yields the same empty answer a topic with no analysis does (DV16 — never a
 * distinguishable error).
 */
export async function getLatestPlanningAnalysis(input: {
	topicId: string;
	projectId: string;
}): Promise<{
	latestAttempt: PlanningAnalysisRecord | null;
	latestReady: PlanningAnalysisRecord | null;
}> {
	const scope = { topicId: input.topicId, projectId: input.projectId };
	const [latestAttempt, latestReady] = await Promise.all([
		db.publishingTopicPlanningAnalysis.findFirst({
			where: scope,
			orderBy: { version: "desc" },
			select: ANALYSIS_SELECT,
		}),
		db.publishingTopicPlanningAnalysis.findFirst({
			where: { ...scope, status: "READY" },
			orderBy: { version: "desc" },
			select: ANALYSIS_SELECT,
		}),
	]);
	const now = Date.now();
	const withExpiry = (
		row:
			| (typeof latestAttempt & { executionTimeoutAt?: Date | null })
			| null,
	): PlanningAnalysisRecord | null =>
		row
			? ({
					...row,
					isExpired:
						row.status === "GENERATING" &&
						row.executionTimeoutAt != null &&
						row.executionTimeoutAt.getTime() < now,
				} as PlanningAnalysisRecord)
			: null;

	return {
		latestAttempt: withExpiry(latestAttempt),
		latestReady: withExpiry(latestReady),
	};
}
