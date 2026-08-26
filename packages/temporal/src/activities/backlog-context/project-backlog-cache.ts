/**
 * Shared, short-TTL cache of a project's flat backlog (every UserStory row)
 * for the channel/chat monitor analyzers.
 *
 * Replaces the per-activity `getProjectHierarchy` caches: `user_story` is the
 * only work-item table (the Epic/Feature folder tables were dropped), so the
 * backlog is a flat story list. The 60s TTL bounds repeat DB reads when many
 * bundles for the same project are analyzed in one poll tick.
 */
import { db } from "@repo/database";

const BACKLOG_CACHE_TTL_MS = 60_000;

export interface CachedBacklogStory {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	externalId: string | null;
}

const backlogCache = new Map<
	string,
	{
		stories: CachedBacklogStory[];
		expiresAt: number;
	}
>();

/**
 * Fetch (or reuse, within the TTL) the project's flat story list in the
 * `existingBacklog.stories` shape `analyzeContextAndPropose` expects.
 */
export async function getCachedProjectBacklog(
	projectId: string,
): Promise<{ stories: CachedBacklogStory[] }> {
	const now = Date.now();
	const cached = backlogCache.get(projectId);
	if (cached && cached.expiresAt > now) {
		return { stories: cached.stories };
	}
	const stories = await db.userStory.findMany({
		where: { projectId },
		orderBy: { order: "asc" },
		select: {
			id: true,
			identifier: true,
			title: true,
			description: true,
			externalId: true,
		},
	});
	backlogCache.set(projectId, {
		stories,
		expiresAt: now + BACKLOG_CACHE_TTL_MS,
	});
	return { stories };
}
