/**
 * Project Code File Queries
 *
 * The full text of each indexed repository file (spec 2026-10-29
 * code-index-sync §6b), stored beside its code index so AI agents read files
 * from the index in RAG mode. Rows follow the file's vectors: written when
 * the file is embedded, removed when it changes away or leaves the
 * repository, and dropped with the index.
 */

import { db } from "../client";

/** Identifies the repository a file belongs to within a project. */
export interface CodeFileRepoKey {
	projectId: string;
	repositoryIntegrationId: string | null;
}

/** The index row id of one repository branch, or null when there is none. */
export async function findProjectCodeIndexId(
	key: CodeFileRepoKey & { branch: string },
): Promise<string | null> {
	const row = await db.projectCodeIndex.findFirst({
		where: {
			projectId: key.projectId,
			repositoryIntegrationId: key.repositoryIntegrationId,
			branch: key.branch,
		},
		select: { id: true },
	});
	return row?.id ?? null;
}

export interface CodeFileText {
	path: string;
	language: string | null;
	content: string;
	blobSha?: string | null;
}

/** Store (or replace) the text of one indexed file. */
export async function upsertProjectCodeFile(input: {
	projectCodeIndexId: string;
	projectId: string;
	organizationId: string | null;
	file: CodeFileText;
}): Promise<void> {
	const { file } = input;
	const lineCount = file.content === "" ? 0 : file.content.split("\n").length;
	const data = {
		language: file.language,
		content: file.content,
		blobSha: file.blobSha ?? null,
		lineCount,
		sizeBytes: Buffer.byteLength(file.content, "utf8"),
	};
	await db.projectCodeFile.upsert({
		where: {
			projectCodeIndexId_path: {
				projectCodeIndexId: input.projectCodeIndexId,
				path: file.path,
			},
		},
		create: {
			projectCodeIndexId: input.projectCodeIndexId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			path: file.path,
			...data,
		},
		update: data,
	});
}

/** Remove the stored text of changed or deleted files of one repository. */
export async function deleteProjectCodeFilesForPaths(
	key: CodeFileRepoKey,
	paths: string[],
): Promise<number> {
	if (paths.length === 0) {
		return 0;
	}
	const result = await db.projectCodeFile.deleteMany({
		where: {
			projectId: key.projectId,
			path: { in: paths },
			codeIndex: { repositoryIntegrationId: key.repositoryIntegrationId },
		},
	});
	return result.count;
}

/**
 * After a full index, drop the text of files no longer in the repository: a
 * full run rewrites every file it still has, so anything else is gone.
 */
export async function pruneProjectCodeFiles(
	projectCodeIndexId: string,
	keepPaths: string[],
): Promise<number> {
	const keep = new Set(keepPaths);
	const stored = await db.projectCodeFile.findMany({
		where: { projectCodeIndexId },
		select: { id: true, path: true },
	});
	const gone = stored.filter((row) => !keep.has(row.path)).map((r) => r.id);
	if (gone.length === 0) {
		return 0;
	}
	const result = await db.projectCodeFile.deleteMany({
		where: { id: { in: gone } },
	});
	return result.count;
}

/** The stored text of one file of a project's indexed repositories. */
export async function getProjectCodeFile(input: {
	projectId: string;
	path: string;
	/** Limit to these repositories; every repository when left out. */
	repositoryIntegrationIds?: Array<string | null>;
}): Promise<
	Array<{
		repositoryIntegrationId: string | null;
		path: string;
		language: string | null;
		content: string;
		lineCount: number;
		sizeBytes: number;
	}>
> {
	const rows = await db.projectCodeFile.findMany({
		where: {
			projectId: input.projectId,
			path: input.path,
			...(input.repositoryIntegrationIds
				? {
						codeIndex: {
							repositoryIntegrationId: {
								in: input.repositoryIntegrationIds.filter(
									(id): id is string => id !== null,
								),
							},
						},
					}
				: {}),
		},
		select: {
			path: true,
			language: true,
			content: true,
			lineCount: true,
			sizeBytes: true,
			codeIndex: { select: { repositoryIntegrationId: true } },
		},
	});
	return rows.map(({ codeIndex, ...row }) => ({
		...row,
		repositoryIntegrationId: codeIndex.repositoryIntegrationId,
	}));
}
