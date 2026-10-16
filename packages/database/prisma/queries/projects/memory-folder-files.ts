/**
 * What a Living Memory write folder holds now (ADR-022): the files the
 * project's repository sync manages under the folder, as the sync last read
 * them. Reads only, scoped to the project and organization the caller
 * resolved, and found only through the project's own sync, so a stray
 * `targetId` reads nothing of another tenant's.
 *
 * The listing says which commit it reflects (`lastAppliedCommitSha`): the
 * folder in the repository may be ahead of it until the next sync run, and a
 * pull-request write is not here until its pull request is merged and a run
 * has read it. Content is read one file at a time, so a listing stays small
 * however large the folder is.
 */

import { db } from "../../client";
import type { ContextWriteMode } from "./context-write-targets";

export interface MemoryFolderState {
	sync: {
		id: string;
		ref: string;
		automatic: boolean;
		automaticPausedReason: string | null;
		lastAppliedCommitSha: string | null;
		repository: {
			provider: string;
			owner: string;
			name: string;
		};
	};
	target: {
		id: string;
		folder: string;
		mode: ContextWriteMode;
		version: number;
	};
}

export interface MemoryFolderFile {
	path: string;
	/** The git blob the sync read the content from; null until a run stamps it. */
	blobOid: string | null;
	contentHash: string | null;
	bytes: number;
}

/** `null` when the project has no sync or the target is not one of its. */
export async function getMemoryFolderState(input: {
	projectId: string;
	organizationId: string;
	targetId: string;
}): Promise<MemoryFolderState | null> {
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	const sync = await db.projectContextRepositorySync.findFirst({
		where: scope,
		select: {
			id: true,
			ref: true,
			automatic: true,
			automaticPausedReason: true,
			lastAppliedCommitSha: true,
			repositoryIntegration: {
				select: {
					provider: true,
					repositoryOwner: true,
					repositoryName: true,
				},
			},
		},
	});
	if (!sync) {
		return null;
	}
	const target = await db.projectContextWriteTarget.findFirst({
		where: { id: input.targetId, syncId: sync.id, ...scope },
		select: { id: true, folder: true, mode: true, version: true },
	});
	if (!target) {
		return null;
	}
	return {
		sync: {
			id: sync.id,
			ref: sync.ref,
			automatic: sync.automatic,
			automaticPausedReason: sync.automaticPausedReason,
			lastAppliedCommitSha: sync.lastAppliedCommitSha,
			repository: {
				provider: sync.repositoryIntegration.provider,
				owner: sync.repositoryIntegration.repositoryOwner,
				name: sync.repositoryIntegration.repositoryName,
			},
		},
		target,
	};
}

/** The sync's files under `folder`, by path, after `after`; at most `limit`. */
export async function listMemoryFolderFiles(input: {
	projectId: string;
	organizationId: string;
	syncId: string;
	folder: string;
	after: string | null;
	limit: number;
}): Promise<MemoryFolderFile[]> {
	const rows = await db.$queryRaw<
		Array<{
			sourcePath: string;
			sourceBlobOid: string | null;
			contentHash: string | null;
			bytes: number;
		}>
	>`
		SELECT c."sourcePath", c."sourceBlobOid", c."contentHash", octet_length(c."content") AS "bytes"
		FROM "project_context" c
		WHERE c."projectId" = ${input.projectId}
			AND c."organizationId" = ${input.organizationId}
			AND c."repositorySyncId" = ${input.syncId}
			AND starts_with(c."sourcePath", ${`${input.folder}/`})
			AND (${input.after}::text IS NULL OR c."sourcePath" > ${input.after})
			AND c."content" IS NOT NULL
		ORDER BY c."sourcePath" ASC
		LIMIT ${input.limit}
	`;
	return rows.map((row) => ({
		path: row.sourcePath,
		blobOid: row.sourceBlobOid,
		contentHash: row.contentHash,
		bytes: Number(row.bytes),
	}));
}

/** One file of the sync, with its text. `null` when the sync has no such path. */
export async function getMemoryFolderFile(input: {
	projectId: string;
	organizationId: string;
	syncId: string;
	path: string;
}): Promise<(MemoryFolderFile & { content: string }) | null> {
	const row = await db.projectContext.findFirst({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			repositorySyncId: input.syncId,
			sourcePath: input.path,
		},
		select: {
			sourcePath: true,
			sourceBlobOid: true,
			contentHash: true,
			content: true,
		},
	});
	if (!row || row.sourcePath === null || row.content === null) {
		return null;
	}
	return {
		path: row.sourcePath,
		blobOid: row.sourceBlobOid,
		contentHash: row.contentHash,
		bytes: Buffer.byteLength(row.content, "utf8"),
		content: row.content,
	};
}
