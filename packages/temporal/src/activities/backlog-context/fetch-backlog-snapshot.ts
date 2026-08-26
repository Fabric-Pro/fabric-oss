/**
 * Fetch Backlog Snapshot Activities
 *
 * Fetches the current state of the project backlog from Fabric DB.
 * `user_story` is the only work-item table (the Epic/Feature folder tables
 * were dropped), so the snapshot is a flat story list. The legacy
 * `epics`/`orphanFeatures` arrays are kept in the RETURN SHAPE (always empty)
 * for Temporal replay/workflow compatibility — `backlogContextAnalysisWorkflow`
 * destructures them when flattening the snapshot into `existingBacklog`.
 */
import { db } from "@repo/database";
import { logger } from "@repo/logs";

// =============================================================================
// Constants
// =============================================================================

/**
 * Per-item description cap applied at the source.
 *
 * The downstream LLM prompt (see analyze-context.ts) inlines at most 200
 * characters of description per item, and drops story descriptions entirely.
 * Capping here keeps the activity result well under Temporal's 2 MiB input
 * limit when projects accumulate large numbers of items with multi-KB
 * descriptions (PRDs stored as story descriptions). The 500-char cap leaves
 * a 2.5x buffer over current prompt usage so future prompt expansion does
 * not require touching this file.
 */
export const SNAPSHOT_DESCRIPTION_MAX_CHARS = 500;

function truncateDescription(value?: string | null): string | null | undefined {
	if (value === null || value === undefined) {
		return value;
	}
	return value.length > SNAPSHOT_DESCRIPTION_MAX_CHARS
		? value.slice(0, SNAPSHOT_DESCRIPTION_MAX_CHARS)
		: value;
}

// =============================================================================
// Types
// =============================================================================

export interface BacklogSnapshotItem {
	id: string;
	identifier: string;
	title: string;
	description?: string | null;
	externalId?: string | null;
	externalUrl?: string | null;
}

export interface BacklogSnapshot {
	/** Always empty — the Epic folder table was dropped. Shape kept for replay safety. */
	epics: Array<
		BacklogSnapshotItem & {
			features: Array<
				BacklogSnapshotItem & { stories: BacklogSnapshotItem[] }
			>;
		}
	>;
	/** Always empty — the Feature folder table was dropped. Shape kept for replay safety. */
	orphanFeatures: Array<
		BacklogSnapshotItem & { stories: BacklogSnapshotItem[] }
	>;
	/** The flat work-item list (every UserStory row in the project). */
	orphanStories: BacklogSnapshotItem[];
}

// =============================================================================
// Activity
// =============================================================================

/**
 * Fetch the flat backlog (every UserStory row) from Fabric DB.
 *
 * Returns a simplified snapshot with only the fields needed for context
 * analysis. All items land in `orphanStories`; the legacy hierarchy arrays
 * are returned empty.
 */
export async function fetchBacklogSnapshot(input: {
	projectId: string;
}): Promise<BacklogSnapshot> {
	const { projectId } = input;

	logger.info("[Backlog Snapshot] Fetching backlog", { projectId });

	const stories = await db.userStory.findMany({
		where: { projectId },
		orderBy: { order: "asc" },
		select: {
			id: true,
			identifier: true,
			title: true,
			description: true,
			externalId: true,
			externalUrl: true,
		},
	});

	const snapshot: BacklogSnapshot = {
		epics: [],
		orphanFeatures: [],
		orphanStories: stories.map((s) => ({
			id: s.id,
			identifier: s.identifier,
			title: s.title,
			description: truncateDescription(s.description),
			externalId: s.externalId,
			externalUrl: s.externalUrl,
		})),
	};

	logger.info("[Backlog Snapshot] Fetched", {
		projectId,
		totalStories: snapshot.orphanStories.length,
	});

	return snapshot;
}
