/**
 * Publishing Suggestion — Contributor Resolution Activity
 *
 * Turns each topic's provenance into the Fabric user IDs whose work it derives
 * from (stories: createdById + assigneeId; documents: userId — the only
 * provenance sources with real user FKs; see 1B design §4). Lives in an ACTIVITY
 * because it needs `@repo/database` (forbidden in the workflow sandbox).
 *
 * Degrade-safe (NFR): a resolution failure for a topic yields [] for that topic
 * and NEVER throws — a contributor lookup must not fail a suggestion cycle.
 */

import type { PersistCycleTerminalInput } from "@repo/database";
import { resolveProjectContributorIds } from "@repo/database";
import { Context, log } from "@temporalio/activity";

type TopicIn = PersistCycleTerminalInput["topics"][number];

export interface ResolveTopicContributorsInput {
	tenant: {
		projectId: string;
		organizationId: string | null;
		userId: string | null;
	};
	topics: TopicIn[];
	/**
	 * `${repoFullName}#${prNumber}` → PR author's numeric GitHub id (string).
	 * Built by the workflow from the collected PR items. Optional so older call
	 * sites (and replayed histories) resolve with no PR authors.
	 */
	prAuthorGithubIdByPr?: Record<string, string>;
}

export async function resolveTopicContributors(
	input: ResolveTopicContributorsInput,
): Promise<{ topics: TopicIn[] }> {
	Context.current().heartbeat();
	// Constant for the whole activity run — hoisted out of the per-topic loop
	// (Copilot review #2148).
	const prMap = input.prAuthorGithubIdByPr ?? {};
	const topics = await Promise.all(
		input.topics.map(async (t) => {
			try {
				const prov = (t.provenance ?? {}) as {
					storyIds?: string[];
					docIds?: string[];
					repoPrs?: { repoFullName?: unknown; prNumber?: unknown }[];
				};
				// DEFENSIVE (FR-A4): the `as` cast does NOT guarantee `repoPrs` is a
				// well-formed array at runtime. Guard against a non-array value and
				// null / non-object / mis-typed entries so this map lookup can NEVER
				// throw — a throw here would hit the outer catch and erase the
				// story/doc contributors resolved by the resolver below.
				const repoPrs = Array.isArray(prov.repoPrs) ? prov.repoPrs : [];
				const githubAuthorIds = [
					...new Set(
						repoPrs
							.map((pr) =>
								pr &&
								typeof pr.repoFullName === "string" &&
								typeof pr.prNumber === "number"
									? prMap[`${pr.repoFullName}#${pr.prNumber}`]
									: undefined,
							)
							.filter((id): id is string => id != null),
					),
				];
				const contributorUserIds = await resolveProjectContributorIds(
					input.tenant.projectId,
					{
						storyIds: prov.storyIds,
						docIds: prov.docIds,
						githubAuthorIds,
					},
				);
				return { ...t, contributorUserIds };
			} catch (error) {
				// Degrade-safe: never fail the cycle over a contributor lookup.
				// Log so recurring DB/provenance faults are visible in prod
				// rather than silently shipping untagged topics.
				log.warn(
					"[publishing-suggestion/resolve-topic-contributors] contributor resolution failed for a topic — degrading to []",
					{ projectId: input.tenant.projectId, error },
				);
				return { ...t, contributorUserIds: [] };
			}
		}),
	);
	return { topics };
}
