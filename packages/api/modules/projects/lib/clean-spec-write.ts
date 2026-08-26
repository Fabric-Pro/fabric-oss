/**
 * Shared versioned write for the Clean Spec (Feature Maturation V2). Used by both
 * the AUTO_ACCEPT propagation (TG4) and the MANUAL accept flow (TG6): write the
 * patched `description`/`acceptanceCriteria` back, snapshotting a FeatureVersion
 * before and after (so the change is rollback-able), and fire PM sync ONLY when
 * the feature's `pmAutoSyncEnabled` cloud toggle is on — same gate as a v1 editor
 * save. Never touches `draftingStage`: a decision-driven edit is an in-stage
 * Clean-Spec change, not a stage transition.
 */

import {
	createFeatureVersion,
	db,
	type FeatureDraftingStage,
	getStoryById,
	type MaturationTenantFilter,
} from "@repo/database";
import { logger } from "@repo/logs";
import { enqueuePmSync } from "./enqueue-pm-sync";

export interface WriteCleanSpecParams {
	projectId: string;
	storyId: string;
	tenantFilter: MaturationTenantFilter;
	newDescription: string;
	newAcceptanceCriteria: string;
	/** One-line summary for the version trail (e.g. applied patch summaries). */
	changeSummary: string;
	/** Present only when a person explicitly accepted the generated patch. */
	lastEditedByName?: string | null;
}

export async function writeCleanSpecWithVersion(
	params: WriteCleanSpecParams,
): Promise<{ pmSyncEnqueued: boolean }> {
	const story = await getStoryById(params.storyId, params.projectId);
	if (!story) {
		// The caller validated the feature exists; a miss here is a race.
		throw new Error(
			`Feature ${params.storyId} not found for Clean Spec write`,
		);
	}

	const tenantContext = {
		userId: params.tenantFilter.userId,
		organizationId: params.tenantFilter.organizationId ?? undefined,
	};
	const currentVersion = story.version ?? 1;
	const draftingStage = story.draftingStage as FeatureDraftingStage;
	if (
		story.description === params.newDescription &&
		story.acceptanceCriteria === params.newAcceptanceCriteria
	) {
		return { pmSyncEnqueued: false };
	}

	// Snapshot the pre-decision content as the prior version.
	await createFeatureVersion({
		storyId: params.storyId,
		version: currentVersion,
		description: story.description ?? null,
		acceptanceCriteria: story.acceptanceCriteria ?? null,
		draftingStage,
		changeDescription: `Before decision: ${params.changeSummary}`,
		changedBy: params.tenantFilter.userId,
		...tenantContext,
	});

	const newVersion = currentVersion + 1;
	await createFeatureVersion({
		storyId: params.storyId,
		version: newVersion,
		description: params.newDescription,
		acceptanceCriteria: params.newAcceptanceCriteria,
		draftingStage,
		changeDescription: `Decision applied: ${params.changeSummary}`,
		changedBy: params.tenantFilter.userId,
		...tenantContext,
	});

	const updated = await db.userStory.update({
		where: { id: params.storyId, projectId: params.projectId },
		data: {
			description: params.newDescription,
			acceptanceCriteria: params.newAcceptanceCriteria,
			version: newVersion,
			lastEditedAt: new Date(),
			lastEditedByName: params.lastEditedByName ?? null,
			lastEditedSource: "AI_MATURATION",
		},
		select: { id: true, pmAutoSyncEnabled: true },
	});

	// PM-sync gate (§7.7): the Clean Spec is the dev-facing surface, so a write to
	// it pushes to the linked PM ticket — but ONLY when the feature's cloud toggle
	// (`pmAutoSyncEnabled`) is on, exactly like a v1 editor save.
	if (updated.pmAutoSyncEnabled) {
		void enqueuePmSync({
			itemId: params.storyId,
			itemType: "story",
			projectId: params.projectId,
			userId: params.tenantFilter.userId,
			triggerSource: "manual-edit",
		}).catch((err) => {
			logger.warn(
				"[maturation] enqueuePmSync failed after Clean Spec write",
				{
					storyId: params.storyId,
					err: err instanceof Error ? err.message : String(err),
				},
			);
		});
		return { pmSyncEnqueued: true };
	}

	return { pmSyncEnqueued: false };
}
