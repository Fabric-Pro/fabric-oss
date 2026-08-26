/**
 * Database query for roadmap semantic search (Fizzy #1937).
 *
 * Tenant isolation: reached only through a procedure that has already
 * validated project access, and the query is scoped by `projectId` — mirroring
 * `listActiveStoriesForDetection` and the rest of the story child-tables.
 */

import { db } from "../../client";

/**
 * Every project story that can participate in a roadmap search: DECLINED items
 * are excluded (they are resolved work nobody is looking for), but CLOSED
 * ("Hidden") items stay IN — the client splits them into its existing
 * hidden-match count/reveal affordance rather than dropping them, so hidden
 * semantics are identical across keyword and AI search.
 *
 * Selects exactly the fields `detectionTextForStory` consumes so results can
 * share the StoryDuplicateEmbedding cache with duplicate detection and
 * action-item routing without recomputing text shapes per consumer.
 */
export async function listSearchableStories(projectId: string) {
	return db.userStory.findMany({
		where: { projectId, draftingStage: { not: "DECLINED" } },
		// Deterministic order matters beyond tidiness: when a cold backlog
		// exceeds the per-request inline-embed cap, the cap slices THIS
		// ordering — most recently updated first, so repeated searches warm
		// the most relevant slice instead of arbitrary heap order.
		orderBy: { updatedAt: "desc" },
		select: {
			id: true,
			draftingStage: true,
			title: true,
			description: true,
			acceptanceCriteria: true,
			tasks: {
				select: { title: true, description: true },
				orderBy: { createdAt: "asc" },
			},
		},
	});
}

/**
 * The owning tenant of a project — the org id, or null for a personal project.
 * The semantic-search procedure uses this to bill AI usage against the
 * project's OWN tenant instead of any caller-supplied organization id (which
 * arrives unvalidated and must never decide whose provider key is spent).
 */
export async function getProjectTenantId(projectId: string) {
	return db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
}
