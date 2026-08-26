import {
	isRefreshDue,
	listEnabledAutoRefreshSettings,
	type RefreshActorCandidate,
	recordRefreshOutcomes,
	refreshWorkflowId,
	resolveValidRefreshActors,
} from "@repo/database";
import { logger } from "@repo/logs";
import { isLivingDocsRefreshEnabled } from "@repo/utils/feature-flag";
import { heartbeat } from "@temporalio/activity";

/**
 * The hourly sweep's find-due activity. It owns "now" — the workflow never reads
 * the clock, which is what keeps the workflow replay-deterministic.
 *
 * Gates run cheapest-first, and every database access is batched: this runs
 * against every enrolled document in the system, 24 times a day, forever.
 *   1. cadence          — in memory
 *   2. collision        — in memory (the lock and updatedAt came with the row)
 *   3. stale actor      — ONE query for the whole tick
 * and the skipped documents are then recorded in at most two more.
 */

/**
 * A refresh stands down when the document was edited within this window. It is
 * deliberately equal to the sweep interval: `DocumentLock` auto-expires after
 * five minutes and is kept alive by a heartbeat, so an active editor always
 * holds a live lock — the window only has to cover the person who just put the
 * document down. With a cadence measured in weeks, deferring an hour costs
 * nothing, and tying the number to the sweep means there is no arbitrary
 * threshold to defend.
 */
const COLLISION_WINDOW_MS = 60 * 60 * 1000;

export interface DueDocument {
	documentId: string;
	projectId: string;
	documentTitle: string;
	organizationId: string | null;
	userId: string | null;
	/** Whose identity the refresh runs under (model resolution + usage logging). */
	triggeredByUserId: string;
	/** Deterministic — a duplicate start is rejected by Temporal, not by a table. */
	workflowId: string;
}

export interface FindDueDocumentsOutput {
	due: DueDocument[];
}

export async function findDueDocumentsActivity(): Promise<FindDueDocumentsOutput> {
	heartbeat("findDueDocuments");

	// Gate in the handler, not in schedule registration: the schedule is always
	// registered, so flipping the flag on takes effect on the next tick with no
	// redeploy. (Repo convention — see ensure-context-summarization-schedules.ts.)
	if (!isLivingDocsRefreshEnabled()) {
		return { due: [] };
	}

	const now = new Date();
	const enrolled = await listEnabledAutoRefreshSettings(now);

	const collided: string[] = [];
	const misTenanted: string[] = [];
	const candidates: typeof enrolled = [];

	for (const s of enrolled) {
		if (
			!isRefreshDue(
				{
					documentId: s.documentId,
					enabled: s.enabled,
					cadence: s.cadence,
					lastRefreshedAt: s.lastRefreshedAt,
					lastAttemptAt: s.lastAttemptAt,
				},
				now,
			)
		) {
			continue;
		}

		// Never overwrite live human work. An unexpired lock means someone has the
		// editor open; a recent updatedAt means someone just put it down. Either
		// way, stand down and let the next sweep re-evaluate. Checked before the
		// actor lookup because it is free and this one costs a query.
		const lockedUntil = s.document?.lock?.expiresAt ?? null;
		const isLocked =
			lockedUntil !== null && lockedUntil.getTime() > now.getTime();
		const editedAt = s.document?.updatedAt ?? null;
		const editedRecently =
			editedAt !== null &&
			now.getTime() - editedAt.getTime() < COLLISION_WINDOW_MS;

		if (isLocked || editedRecently) {
			logger.info("[DocumentRefresh] Skipping: document is in use", {
				documentId: s.documentId,
				isLocked,
				editedRecently,
			});
			collided.push(s.documentId);
			continue;
		}

		// The settings row's tenant must agree with the project's. A row claiming
		// personal (organizationId null) on an ORG project would otherwise run as
		// personal — resolving the actor's own AI provider and billing them for an
		// org's document. That state is only reachable from a pre-existing
		// mis-tenanted parent, but this feature is what would turn a dormant data
		// bug into recurring, unattended, wrong-tenant spend. Fail closed.
		if (s.organizationId !== (s.project?.organizationId ?? null)) {
			logger.error(
				"[DocumentRefresh] Skipping: settings tenant does not match the project's",
				{
					documentId: s.documentId,
					settingsOrganizationId: s.organizationId,
					projectOrganizationId: s.project?.organizationId ?? null,
				},
			);
			misTenanted.push(s.documentId);
			continue;
		}

		candidates.push(s);
	}

	const actorCandidates: RefreshActorCandidate[] = candidates.map((s) => ({
		documentId: s.documentId,
		projectId: s.projectId,
		createdByUserId: s.createdByUserId,
		organizationId: s.organizationId,
		ownerUserId: s.project?.userId ?? null,
	}));
	// Nothing survived the cheap gates — do not go to the database to ask about
	// an empty list.
	const validActors = actorCandidates.length
		? await resolveValidRefreshActors(actorCandidates)
		: new Set<string>();

	const staleActor: string[] = [];
	const due: DueDocument[] = [];

	for (const s of candidates) {
		if (!validActors.has(s.documentId)) {
			logger.warn(
				"[DocumentRefresh] Skipping: enroller is no longer a valid member",
				{
					documentId: s.documentId,
					organizationId: s.organizationId,
					createdByUserId: s.createdByUserId,
				},
			);
			staleActor.push(s.documentId);
			continue;
		}

		due.push({
			documentId: s.documentId,
			projectId: s.projectId,
			documentTitle: s.document?.title ?? "Untitled document",
			organizationId: s.organizationId,
			userId: s.userId,
			triggeredByUserId: s.createdByUserId,
			workflowId: refreshWorkflowId(s.documentId, s.cadence, now),
		});
	}

	await Promise.all([
		recordRefreshOutcomes(
			collided,
			"SKIPPED_COLLISION",
			"Someone was editing the document. The refresh will retry on the next sweep.",
		),
		recordRefreshOutcomes(
			staleActor,
			"SKIPPED_STALE_ACTOR",
			"The member who enabled auto-refresh no longer has access to this project. Re-enable it to resume.",
		),
		recordRefreshOutcomes(
			misTenanted,
			"FAILED",
			"This document's auto-refresh settings do not match its project's tenant. Contact support.",
		),
	]);

	logger.info("[DocumentRefresh] Sweep found due documents", {
		enrolled: enrolled.length,
		due: due.length,
		skippedCollision: collided.length,
		skippedStaleActor: staleActor.length,
		skippedMisTenanted: misTenanted.length,
	});

	return { due };
}
