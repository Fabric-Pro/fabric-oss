/**
 * Repository files the project's Living Memory sync already keeps in Context
 * and indexes there: the code index leaves them out, so a document is
 * searched once, as context, not again as code.
 *
 * Only rows the sync manages (`repositorySyncId` set) for the same
 * repository integration count, and only while they are indexed: a
 * store-only folder (`indexingExcluded`) is not searchable as context, so the
 * code index keeps those files. `sourcePath` is the sync's storage key, the
 * repository-relative path the code index walks.
 */

import { db } from "../../client";

export async function listContextCoveredCodePaths(input: {
	projectId: string;
	repositoryIntegrationId: string | null | undefined;
	/** Only these paths; omit for every covered path. */
	paths?: string[];
}): Promise<Set<string>> {
	if (!input.repositoryIntegrationId || input.paths?.length === 0) {
		return new Set();
	}
	const rows = await db.projectContext.findMany({
		where: {
			projectId: input.projectId,
			indexingExcluded: false,
			repositorySync: {
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId,
			},
			...(input.paths ? { sourcePath: { in: input.paths } } : {}),
		},
		select: { sourcePath: true },
	});
	return new Set(
		rows.flatMap((row) => (row.sourcePath ? [row.sourcePath] : [])),
	);
}
