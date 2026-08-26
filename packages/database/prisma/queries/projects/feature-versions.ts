/**
 * Database queries for Feature (UserStory) Version History
 * Tracks snapshots of feature content at each drafting stage transition
 */

import { db, type FeatureDraftingStage, type Prisma } from "../../client";

/**
 * Create a version snapshot for a feature.
 *
 * Pass `tx` to run the upsert on a caller-provided transaction client so the
 * version row is written in the SAME transaction as the state transition that
 * produced it (#1360) — otherwise a version-write failure could leave
 * state-without-history or history-without-state. Callers that omit `tx` keep
 * the global-client behavior unchanged.
 */
export async function createFeatureVersion(
	data: {
		storyId: string;
		version: number;
		description: string | null;
		acceptanceCriteria: string | null;
		draftingStage: FeatureDraftingStage;
		changeDescription?: string;
		changedBy?: string;
		userId?: string;
		organizationId?: string;
		/** Per-run change summary bullets (Feature Maturation V2). */
		changeSummary?: string[];
	},
	tx?: Prisma.TransactionClient,
) {
	// Upsert so the operation is idempotent: if a snapshot already exists at this
	// version number (e.g. a second AI enhancement call re-creates the same
	// "before" snapshot), keep the existing record unchanged.
	return await (tx ?? db).featureVersion.upsert({
		where: {
			storyId_version: {
				storyId: data.storyId,
				version: data.version,
			},
		},
		create: {
			storyId: data.storyId,
			version: data.version,
			description: data.description,
			acceptanceCriteria: data.acceptanceCriteria,
			draftingStage: data.draftingStage,
			changeDescription: data.changeDescription ?? null,
			changedBy: data.changedBy ?? null,
			userId: data.userId ?? null,
			organizationId: data.organizationId ?? null,
			changeSummary: data.changeSummary ?? [],
		},
		update: {}, // Version snapshots are immutable — no-op on conflict
	});
}

/**
 * Get paginated list of feature versions
 */
export async function getFeatureVersions(
	storyId: string,
	limit = 20,
	offset = 0,
) {
	const [versions, total] = await Promise.all([
		db.featureVersion.findMany({
			where: { storyId },
			orderBy: { version: "desc" },
			take: limit,
			skip: offset,
		}),
		db.featureVersion.count({ where: { storyId } }),
	]);

	return {
		versions,
		total,
		hasMore: offset + limit < total,
	};
}

/**
 * Get the most recent run's change summary for a feature (Feature Maturation V2).
 * Returns the latest version that carries a non-empty `changeSummary` (an enhance
 * run's "after" snapshot) so the editor can show a "Changes from this run" card.
 * Returns `null` when no run has produced a summary yet. Access is validated by
 * the caller (the story is already tenant-checked), so this scopes by `storyId`.
 */
export async function getLatestRunChangeSummary(storyId: string): Promise<{
	version: number;
	changeSummary: string[];
	changeDescription: string | null;
	createdAt: Date;
} | null> {
	const row = await db.featureVersion.findFirst({
		where: { storyId, NOT: { changeSummary: { isEmpty: true } } },
		orderBy: { version: "desc" },
		select: {
			version: true,
			changeSummary: true,
			changeDescription: true,
			createdAt: true,
		},
	});
	return row;
}

/**
 * Get specific version of a feature
 */
export async function getFeatureVersion(storyId: string, version: number) {
	return await db.featureVersion.findFirst({
		where: { storyId, version },
	});
}

/**
 * Restore feature to a previous version.
 * Snapshots current content before restoring, then updates the story.
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function restoreFeatureVersion(
	storyId: string,
	projectId: string,
	version: number,
	userId: string,
	tenantContext: {
		userId: string;
		organizationId?: string;
		lastEditedByName?: string | null;
	},
) {
	const versionData = await getFeatureVersion(storyId, version);

	if (!versionData) {
		throw new Error("Version not found");
	}

	// Get current story to snapshot before restoring
	const currentStory = await db.userStory.findFirst({
		where: { id: storyId, projectId },
	});

	if (!currentStory) {
		throw new Error("Story not found");
	}
	if (
		currentStory.description === versionData.description &&
		currentStory.acceptanceCriteria === versionData.acceptanceCriteria &&
		currentStory.draftingStage === versionData.draftingStage
	) {
		return currentStory;
	}

	return await db.$transaction(async (tx) => {
		const changedAt = new Date();
		// Snapshot current content before restoring
		await tx.featureVersion.create({
			data: {
				storyId,
				version: currentStory.version + 1,
				description: currentStory.description,
				acceptanceCriteria: currentStory.acceptanceCriteria,
				draftingStage: currentStory.draftingStage,
				changeDescription: `Snapshot before restoring to v${version}`,
				changedBy: userId,
				userId: tenantContext.userId,
				organizationId: tenantContext.organizationId ?? null,
			},
		});

		// Create version record for the restored content
		const restoredVersion = currentStory.version + 2;
		await tx.featureVersion.create({
			data: {
				storyId,
				version: restoredVersion,
				description: versionData.description,
				acceptanceCriteria: versionData.acceptanceCriteria,
				draftingStage: versionData.draftingStage,
				changeDescription: `Restored from v${version}`,
				changedBy: userId,
				userId: tenantContext.userId,
				organizationId: tenantContext.organizationId ?? null,
			},
		});

		// Update the story with restored content
		const updated = await tx.userStory.update({
			where: { id: storyId, projectId },
			data: {
				description: versionData.description,
				acceptanceCriteria: versionData.acceptanceCriteria,
				draftingStage: versionData.draftingStage,
				draftingStageUpdatedAt: changedAt,
				version: restoredVersion,
				pmAutoHidden: false,
				lastEditedAt: changedAt,
				lastEditedByName: tenantContext.lastEditedByName ?? null,
				lastEditedSource: "MANUAL",
			},
			include: {
				status: true,
				tasks: { orderBy: { order: "asc" } },
			},
		});

		return updated;
	});
}
