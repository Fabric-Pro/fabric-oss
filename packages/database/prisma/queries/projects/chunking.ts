/**
 * Content-type chunking state of a project (spec 2026-10-28).
 *
 * `ProjectRagSettings.chunkingVersion` only ever goes up: every saved chunking
 * change bumps it, and a source whose own `chunkingVersion` is behind it is
 * re-chunked. A project with no settings row is at version 0 with content-type
 * chunking off — today's chunking.
 */

import { type ChunkSplitMethod, db, type Prisma } from "../../client";
import type {
	ProjectChunkingRunKind,
	ProjectChunkingRunStatus,
} from "../../generated/client";

export interface ProjectChunkingSettings {
	chunkByContentType: boolean;
	chunkProfiles: Prisma.JsonValue | null;
	chunkingVersion: number;
	chunkSize: number;
	chunkOverlap: number;
	splitMethod: ChunkSplitMethod;
}

const DEFAULT_CHUNKING: ProjectChunkingSettings = {
	chunkByContentType: false,
	chunkProfiles: null,
	chunkingVersion: 0,
	chunkSize: 3000,
	chunkOverlap: 500,
	splitMethod: "DOCUMENT",
};

export async function getProjectChunkingSettings(
	projectId: string,
): Promise<ProjectChunkingSettings> {
	const row = await db.projectRagSettings.findUnique({
		where: { projectId },
		select: {
			chunkByContentType: true,
			chunkProfiles: true,
			chunkingVersion: true,
			chunkSize: true,
			chunkOverlap: true,
			splitMethod: true,
		},
	});
	return row ?? DEFAULT_CHUNKING;
}

export interface ProjectChunkingChange {
	chunkByContentType?: boolean;
	chunkProfiles?: Prisma.InputJsonValue | null;
	chunkSize?: number;
	chunkOverlap?: number;
	splitMethod?: ChunkSplitMethod;
}

/**
 * Whether a change touches chunking at all. Retrieval settings (Top K,
 * threshold, reranking) never re-chunk.
 */
export function isChunkingChange(
	current: ProjectChunkingSettings,
	change: ProjectChunkingChange,
): boolean {
	return (
		(change.chunkByContentType !== undefined &&
			change.chunkByContentType !== current.chunkByContentType) ||
		(change.chunkSize !== undefined &&
			change.chunkSize !== current.chunkSize) ||
		(change.chunkOverlap !== undefined &&
			change.chunkOverlap !== current.chunkOverlap) ||
		(change.splitMethod !== undefined &&
			change.splitMethod !== current.splitMethod) ||
		(change.chunkProfiles !== undefined &&
			JSON.stringify(change.chunkProfiles ?? null) !==
				JSON.stringify(current.chunkProfiles ?? null))
	);
}

/**
 * Save a chunking change and bump the project's chunking version in one
 * write. Returns the new version; the caller starts the re-chunk with it.
 */
export async function saveProjectChunkingChange(params: {
	projectId: string;
	userId: string;
	organizationId: string;
	change: ProjectChunkingChange;
}): Promise<{ chunkingVersion: number }> {
	const { projectId, userId, organizationId, change } = params;
	const data = {
		...(change.chunkByContentType !== undefined && {
			chunkByContentType: change.chunkByContentType,
		}),
		...(change.chunkProfiles !== undefined && {
			chunkProfiles:
				change.chunkProfiles === null
					? (null as unknown as Prisma.InputJsonValue)
					: change.chunkProfiles,
		}),
		...(change.chunkSize !== undefined && { chunkSize: change.chunkSize }),
		...(change.chunkOverlap !== undefined && {
			chunkOverlap: change.chunkOverlap,
		}),
		...(change.splitMethod !== undefined && {
			splitMethod: change.splitMethod,
		}),
	};
	const row = await db.projectRagSettings.upsert({
		where: { projectId },
		create: {
			projectId,
			userId,
			organizationId,
			...data,
			chunkingVersion: 1,
		},
		update: { ...data, chunkingVersion: { increment: 1 } },
		select: { chunkingVersion: true },
	});
	return { chunkingVersion: row.chunkingVersion };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function createProjectChunkingRun(params: {
	projectId: string;
	organizationId: string;
	userId: string | null;
	kind: ProjectChunkingRunKind;
	chunkingVersion?: number;
	workflowId?: string;
	result?: Prisma.InputJsonValue;
}) {
	return db.projectChunkingRun.create({
		data: {
			projectId: params.projectId,
			organizationId: params.organizationId,
			userId: params.userId,
			kind: params.kind,
			chunkingVersion: params.chunkingVersion,
			workflowId: params.workflowId,
			...(params.result !== undefined && { result: params.result }),
		},
	});
}

/**
 * What a chunking check saw, kept on its run's `result.snapshot` so the next
 * visit can tell whether the content or the embedding model changed since
 * (spec 2026-10-28 §8d). Counts only: no content is read.
 */
export interface ProjectChunkingSnapshot {
	at: string;
	sources: number;
	embeddingModel: string | null;
}

/** Sources that are chunked into the project index (not repository code). */
function chunkedContextWhere(projectId: string, organizationId: string) {
	return {
		projectId,
		organizationId,
		extractionStatus: "COMPLETED" as const,
		type: { notIn: ["CODE_FILE" as const, "CODE_FILE_SUMMARY" as const] },
	};
}

/**
 * How many sources the project index holds, and how many were added after
 * `since`. By `createdAt`: embedding and re-crawls bump `updatedAt`, so it
 * would report change where there is none. Two count queries per table.
 */
export async function countProjectChunkingSources(params: {
	projectId: string;
	organizationId: string;
	since?: Date;
}): Promise<{ sources: number; addedSince: number }> {
	const { projectId, organizationId, since } = params;
	const contextWhere = chunkedContextWhere(projectId, organizationId);
	const documentWhere = { projectId, organizationId, isActive: true };
	const [contexts, documents, addedContexts, addedDocuments] =
		await Promise.all([
			db.projectContext.count({ where: contextWhere }),
			db.projectDocument.count({ where: documentWhere }),
			since
				? db.projectContext.count({
						where: { ...contextWhere, createdAt: { gt: since } },
					})
				: 0,
			since
				? db.projectDocument.count({
						where: { ...documentWhere, createdAt: { gt: since } },
					})
				: 0,
		]);
	return {
		sources: contexts + documents,
		addedSince: addedContexts + addedDocuments,
	};
}

/**
 * The latest finished chunking check of a project (a measure, a tuning or a
 * re-chunk) and the snapshot it kept, or null when there has been none.
 */
export async function getLastProjectChunkingCheck(projectId: string): Promise<{
	finishedAt: Date;
	snapshot: ProjectChunkingSnapshot | null;
} | null> {
	// A finished re-chunk, or an analysis that reached its proposal. A tuning
	// waiting for approval has no `finishedAt` yet but is a check; a run still
	// waiting for its cost to be confirmed is not.
	const run = await db.projectChunkingRun.findFirst({
		where: {
			projectId,
			OR: [
				{ kind: "RECHUNK", status: "COMPLETED" },
				{
					kind: { in: ["MEASURE", "TUNE"] },
					status: { in: ["COMPLETED", "AWAITING_APPROVAL"] },
					result: { path: ["stage"], equals: "proposal" },
				},
			],
		},
		orderBy: { updatedAt: "desc" },
		select: { finishedAt: true, updatedAt: true, result: true },
	});
	if (!run) {
		return null;
	}
	const raw =
		run.result &&
		typeof run.result === "object" &&
		!Array.isArray(run.result)
			? (run.result as Record<string, unknown>).snapshot
			: undefined;
	const snapshot =
		raw &&
		typeof raw === "object" &&
		typeof (raw as ProjectChunkingSnapshot).sources === "number"
			? (raw as ProjectChunkingSnapshot)
			: null;
	return { finishedAt: run.finishedAt ?? run.updatedAt, snapshot };
}

/**
 * A newer re-chunk supersedes a running one: mark every other RUNNING
 * re-chunk of the project SUPERSEDED. Returns their workflow ids so the
 * caller can cancel them.
 */
export async function supersedeRunningRechunks(params: {
	projectId: string;
	exceptRunId: string;
}): Promise<string[]> {
	const running = await db.projectChunkingRun.findMany({
		where: {
			projectId: params.projectId,
			kind: "RECHUNK",
			status: "RUNNING",
			id: { not: params.exceptRunId },
		},
		select: { id: true, workflowId: true },
	});
	if (running.length > 0) {
		await db.projectChunkingRun.updateMany({
			where: { id: { in: running.map((r) => r.id) }, status: "RUNNING" },
			data: { status: "SUPERSEDED", finishedAt: new Date() },
		});
	}
	return running.flatMap((r) => (r.workflowId ? [r.workflowId] : []));
}

export async function updateProjectChunkingRun(
	runId: string,
	data: {
		status?: ProjectChunkingRunStatus;
		progress?: Prisma.InputJsonValue;
		result?: Prisma.InputJsonValue;
		error?: string | null;
		workflowId?: string;
		finished?: boolean;
	},
) {
	// A run already superseded or cancelled keeps that status; only its
	// progress may still be written by an activity finishing late.
	return db.projectChunkingRun.updateMany({
		where: {
			id: runId,
			...(data.status
				? { status: { in: ["RUNNING", "AWAITING_APPROVAL"] } }
				: {}),
		},
		data: {
			...(data.status && { status: data.status }),
			...(data.progress !== undefined && { progress: data.progress }),
			...(data.result !== undefined && { result: data.result }),
			...(data.error !== undefined && { error: data.error }),
			...(data.workflowId !== undefined && {
				workflowId: data.workflowId,
			}),
			...(data.finished && { finishedAt: new Date() }),
		},
	});
}

export async function getProjectChunkingRun(runId: string) {
	return db.projectChunkingRun.findUnique({ where: { id: runId } });
}

/** The latest run of each kind, for RAG Settings. */
export async function getLatestProjectChunkingRuns(projectId: string) {
	const kinds: ProjectChunkingRunKind[] = ["RECHUNK", "MEASURE", "TUNE"];
	const rows = await Promise.all(
		kinds.map((kind) =>
			db.projectChunkingRun.findFirst({
				where: { projectId, kind },
				orderBy: { startedAt: "desc" },
			}),
		),
	);
	return {
		rechunk: rows[0] ?? null,
		measure: rows[1] ?? null,
		tune: rows[2] ?? null,
	};
}

/** Sources of a project whose points are behind its chunking version. */
export async function listProjectSourcesBehindChunkingVersion(params: {
	projectId: string;
	chunkingVersion: number;
	take: number;
}) {
	const behind = {
		OR: [
			{ chunkingVersion: null },
			{ chunkingVersion: { lt: params.chunkingVersion } },
		],
	};
	const [contexts, documents] = await Promise.all([
		db.projectContext.findMany({
			where: {
				projectId: params.projectId,
				extractionStatus: "COMPLETED",
				// Code is chunked by the AST indexer and never re-chunked here.
				type: { notIn: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
				...behind,
			},
			select: { id: true },
			take: params.take,
		}),
		db.projectDocument.findMany({
			where: {
				projectId: params.projectId,
				embeddedAt: { not: null },
				...behind,
			},
			select: { id: true },
			take: params.take,
		}),
	]);
	return {
		contextIds: contexts.map((c) => c.id),
		documentIds: documents.map((d) => d.id),
	};
}

export async function markProjectContextChunkingVersion(
	contextId: string,
	chunkingVersion: number,
) {
	await db.projectContext.update({
		where: { id: contextId },
		data: { chunkingVersion },
	});
}

export async function markProjectDocumentChunkingVersion(
	documentId: string,
	chunkingVersion: number,
) {
	await db.projectDocument.update({
		where: { id: documentId },
		data: { chunkingVersion },
	});
}
