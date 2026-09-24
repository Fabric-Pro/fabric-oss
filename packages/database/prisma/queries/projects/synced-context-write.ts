/**
 * The row shape of a synced knowledge file, shared by its two writers so they
 * cannot drift: `upsertContextBySourcePath` (`contexts.ts`, the CLI, MCP and
 * Context tab path, Fizzy #2616) and `applyRepositoryContextBatch`
 * (`context-repository-sync.ts`, the Living Memory repository sync's writer,
 * design 2026-09-23 §5.3.1 step 7).
 *
 * Internal to `prisma/queries/projects`: not re-exported from the package.
 * Pure except `readRepositorySyncLabel`, which reads through the caller's
 * transaction client.
 */

import type { Prisma } from "../../client";

/** A row's `metadata` as an object to spread, or an empty one. */
export function metadataObject(metadata: Prisma.JsonValue): Prisma.JsonObject {
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Prisma.JsonObject)
		: {};
}

/** The last segment of a normalized source path. */
export function pathBasename(sourcePath: string): string {
	return sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
}

/**
 * The title a synced file is written under when its writer names none: the
 * file name. The same default the API applies before it calls
 * `upsertContextBySourcePath` (`upsert-synced-context.ts`).
 */
export function syncedContextTitle(
	title: string | null | undefined,
	sourcePath: string,
): string {
	return title?.trim() || pathBasename(sourcePath);
}

/**
 * The title a STORED row is shown under: `metadata.title` when it is a
 * non-empty string, else its file name.
 */
export function storedSyncedContextTitle(
	metadata: Prisma.JsonValue,
	sourcePath: string,
): string {
	const title = metadataObject(metadata).title;
	return typeof title === "string" && title.trim()
		? title
		: pathBasename(sourcePath);
}

/**
 * The columns a new synced file is created with: a TEXT row carrying its
 * path, hash, who wrote it and when, and `{ title, sourcePath }` metadata.
 * `repositorySyncId` is written ONLY by the repository sync's writer; every
 * other caller omits it and the row is unowned.
 */
export function buildSyncedContextCreateData(input: {
	projectId: string;
	sourcePath: string;
	content: string;
	contentHash: string;
	/** Already resolved; see `syncedContextTitle`. */
	title: string;
	userId: string;
	organizationId: string | null;
	repositorySyncId?: string;
	now: Date;
}) {
	return {
		projectId: input.projectId,
		type: "TEXT" as const,
		content: input.content,
		sourcePath: input.sourcePath,
		contentHash: input.contentHash,
		contentUpdatedAt: input.now,
		contentUpdatedByUserId: input.userId,
		metadata: { title: input.title, sourcePath: input.sourcePath },
		userId: input.userId,
		organizationId: input.organizationId,
		...(input.repositorySyncId
			? { repositorySyncId: input.repositorySyncId }
			: {}),
	} satisfies Prisma.ProjectContextUncheckedCreateInput;
}

/**
 * The columns a content replace writes: the content and its hash, the
 * content pair (never the metadata edit's), the title and path refreshed in
 * `metadata` with every other key kept, and `embeddedAt` cleared so the row
 * reads as not yet indexed until the re-embed lands.
 */
export function buildSyncedContextReplaceData(input: {
	storedMetadata: Prisma.JsonValue;
	sourcePath: string;
	content: string;
	contentHash: string;
	/** Already resolved; see `syncedContextTitle`. */
	title: string;
	userId: string;
	now: Date;
}) {
	return {
		content: input.content,
		contentHash: input.contentHash,
		contentUpdatedAt: input.now,
		contentUpdatedByUserId: input.userId,
		metadata: {
			...metadataObject(input.storedMetadata),
			title: input.title,
			sourcePath: input.sourcePath,
		},
		embeddedAt: null,
	} satisfies Prisma.ProjectContextUpdateManyMutationInput;
}

/**
 * What a refusal names when a row belongs to a repository sync: the
 * repository as `owner/name` and the branch. Both are null only when the
 * configuration was removed while the caller ran — the row is being released
 * (the foreign key sets it back to NULL), and a retry is answered as for an
 * ordinary row.
 */
export interface RepositorySyncLabel {
	repository: string | null;
	ref: string | null;
}

/**
 * The label of the sync that owns a row, read through the caller's
 * transaction and bound to the row's project, so a row can never be labelled
 * with another project's configuration.
 */
export async function readRepositorySyncLabel(
	tx: Prisma.TransactionClient,
	input: { syncId: string; projectId: string },
): Promise<RepositorySyncLabel> {
	const sync = await tx.projectContextRepositorySync.findFirst({
		where: { id: input.syncId, projectId: input.projectId },
		select: {
			ref: true,
			repositoryIntegration: {
				select: { repositoryOwner: true, repositoryName: true },
			},
		},
	});
	if (!sync) {
		return { repository: null, ref: null };
	}
	return {
		repository: `${sync.repositoryIntegration.repositoryOwner}/${sync.repositoryIntegration.repositoryName}`,
		ref: sync.ref,
	};
}
