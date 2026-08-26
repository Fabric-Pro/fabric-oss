import type { Prisma } from "../../client";
import { db } from "../../client";
import { orderStoriesBySemanticActivity } from "./story-semantic-activity";

/**
 * Rank stories by semantic activity WITHOUT reading the whole matching set.
 *
 * Activity is `lastEditedAt ?? createdAt`, which Postgres cannot order by
 * through Prisma's `orderBy` — and a compound `lastEditedAt desc nulls last,
 * createdAt desc` is NOT the same ranking: it drops every never-edited story
 * below every edited one, so a story created today would sort under one last
 * touched two years ago.
 *
 * Reading each partition on its own key instead keeps the database doing the
 * ordering. Taking `take` from both sides is sufficient, not merely safe: each
 * partition is ordered by the very key that decides its rows' global position,
 * so anything belonging in the overall top `take` is already inside its own
 * partition's top `take`.
 */
export async function rankStoryIdsBySemanticActivity(
	where: Prisma.UserStoryWhereInput,
	take: number,
): Promise<string[]> {
	const select = { id: true, createdAt: true, lastEditedAt: true } as const;
	const [edited, neverEdited] = await Promise.all([
		db.userStory.findMany({
			where: { ...where, lastEditedAt: { not: null } },
			orderBy: { lastEditedAt: "desc" },
			take,
			select,
		}),
		db.userStory.findMany({
			where: { ...where, lastEditedAt: null },
			orderBy: { createdAt: "desc" },
			take,
			select,
		}),
	]);
	return orderStoriesBySemanticActivity([...edited, ...neverEdited])
		.slice(0, take)
		.map((story) => story.id);
}
