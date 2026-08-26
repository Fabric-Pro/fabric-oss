import { db, normalizeStoryIdentifierQuery, type Prisma } from "@repo/database";
import { rankStoryIdsBySemanticActivity } from "@repo/database/prisma/queries/projects/story-activity-ranking";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/** Rows returned to the @mentions autocomplete. */
const SEARCH_RESULT_LIMIT = 10;

/**
 * Search user stories in a project for @mentions autocomplete.
 *
 * AUTHORIZATION: requireProjectPermission(STORY_READ) gates project access.
 */
export const searchStoriesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/search-stories",
		tags: ["Projects"],
		summary: "Search stories",
		description:
			"Search user stories in a project for @mentions autocomplete",
	})
	.input(
		z.object({
			projectId: z.string(),
			query: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const normalizedQuery = input.query.toLowerCase();
		// Strip legacy `F-`/`B-`/`US-`/`TASK-` prefixes from the identifier
		// portion of the search so a query like `B-011` resolves both legacy
		// `B-011` rows and new plain-numeric `11` rows (spec 2026-05-21 §7.4).
		// Apply BOTH the raw and the normalized form to the identifier
		// haystack via `OR`; title is matched against the raw needle only.
		const identifierQuery = normalizeStoryIdentifierQuery(normalizedQuery);

		const where: Prisma.UserStoryWhereInput = {
			projectId: input.projectId,
			OR: [
				{
					title: {
						contains: normalizedQuery,
						mode: "insensitive",
					},
				},
				{
					identifier: {
						contains: normalizedQuery,
						mode: "insensitive",
					},
				},
				...(identifierQuery && identifierQuery !== normalizedQuery
					? [
							{
								identifier: {
									contains: identifierQuery,
									mode: "insensitive" as const,
								},
							},
						]
					: []),
				{
					externalId: {
						contains: normalizedQuery,
						mode: "insensitive",
					},
				},
				{
					description: {
						contains: normalizedQuery,
						mode: "insensitive",
					},
				},
			],
		};

		// This matches on `description`, so an unbounded read would pull every
		// matching body on an autocomplete keystroke. Rank ids under a cap first,
		// then read only the rows actually returned.
		const rankedIds = await rankStoryIdsBySemanticActivity(
			where,
			SEARCH_RESULT_LIMIT,
		);
		if (rankedIds.length === 0) {
			return { stories: [] };
		}
		const rows = await db.userStory.findMany({
			where: { projectId: input.projectId, id: { in: rankedIds } },
			select: {
				id: true,
				identifier: true,
				title: true,
				status: { select: { name: true } },
			},
		});
		const rowsById = new Map(rows.map((row) => [row.id, row]));
		const stories = rankedIds.flatMap((id) => rowsById.get(id) ?? []);

		return {
			stories: stories.map((story) => ({
				id: story.id,
				identifier: story.identifier,
				title: story.title,
				status: story.status.name,
			})),
		};
	});
