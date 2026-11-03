/**
 * Re-chunking a project after a saved chunking change (spec 2026-10-28 §8a).
 *
 * Every source is re-chunked from the text Fabric already stores (a context's
 * `content`, a document's `content`); nothing is downloaded again. New points
 * are written before the old ones are removed, so a source never drops out of
 * search, and a failed source keeps its previous points.
 *
 * Idempotent: a source already at the run's chunking version is skipped, and
 * a run whose version is no longer the project's (a newer change was saved)
 * stops without touching anything.
 */

import { getSystemEmbeddingRAGProviderConfig } from "@repo/ai";
import {
	db,
	getProjectChunkingRun,
	getProjectChunkingSettings,
	listProjectSourcesBehindChunkingVersion,
	markProjectContextChunkingVersion,
	markProjectDocumentChunkingVersion,
	type Prisma,
	updateProjectChunkingRun,
} from "@repo/database";
import { rechunkProjectDocument, reembedProjectContext } from "@repo/rag";
import { heartbeat } from "@temporalio/activity";

/** Upper bound of sources one run takes on; the sweep picks up the rest. */
export const RECHUNK_MAX_SOURCES = 5000;

export interface ProjectRechunkScope {
	projectId: string;
	organizationId: string;
	userId: string;
	runId: string;
	chunkingVersion: number;
}

export interface RechunkSources {
	contextIds: string[];
	documentIds: string[];
	/** False when a newer chunking change was saved before this run began. */
	current: boolean;
}

export async function listRechunkSourcesActivity(
	scope: ProjectRechunkScope,
): Promise<RechunkSources> {
	const settings = await getProjectChunkingSettings(scope.projectId);
	if (settings.chunkingVersion !== scope.chunkingVersion) {
		return { contextIds: [], documentIds: [], current: false };
	}
	const sources = await listProjectSourcesBehindChunkingVersion({
		projectId: scope.projectId,
		chunkingVersion: scope.chunkingVersion,
		take: RECHUNK_MAX_SOURCES,
	});
	await updateProjectChunkingRun(scope.runId, {
		progress: {
			total: sources.contextIds.length + sources.documentIds.length,
			done: 0,
			failed: 0,
		},
	});
	return { ...sources, current: true };
}

export type RechunkSourceOutcome =
	| "rechunked"
	| "skipped"
	| "failed"
	| "superseded";

/**
 * Re-chunk one source. Never throws for a source that cannot be embedded:
 * the outcome is recorded and the run goes on; the old points stay.
 */
export async function rechunkProjectSourceActivity(
	params: ProjectRechunkScope & {
		source: "context" | "document";
		sourceId: string;
	},
): Promise<{ outcome: RechunkSourceOutcome; error?: string }> {
	heartbeat(params.sourceId);
	// A large source can take minutes to embed (hundreds of chunks on a slow
	// or local model); keep heartbeating so it is not taken for a dead worker.
	const beat = setInterval(() => heartbeat(params.sourceId), 30_000);
	try {
		return await rechunkProjectSource(params);
	} finally {
		clearInterval(beat);
	}
}

async function rechunkProjectSource(
	params: ProjectRechunkScope & {
		source: "context" | "document";
		sourceId: string;
	},
): Promise<{ outcome: RechunkSourceOutcome; error?: string }> {
	const { projectId, organizationId, userId, chunkingVersion } = params;
	const settings = await getProjectChunkingSettings(projectId);
	if (settings.chunkingVersion !== chunkingVersion) {
		return { outcome: "superseded" };
	}

	try {
		const apiKey = await getSystemEmbeddingRAGProviderConfig({
			userId,
			organizationId,
		});
		if (params.source === "context") {
			// Scoped to the run's project and organization: a source id from
			// another tenant matches nothing.
			const row = await db.projectContext.findFirst({
				where: { id: params.sourceId, projectId, organizationId },
				select: {
					id: true,
					type: true,
					content: true,
					metadata: true,
					mimeType: true,
					originalFilename: true,
					sourceUrl: true,
					sourceTitle: true,
					chunkProfile: true,
					chunkingVersion: true,
				},
			});
			if (!row || (row.chunkingVersion ?? 0) >= chunkingVersion) {
				return { outcome: "skipped" };
			}
			if (!row.content.trim()) {
				await markProjectContextChunkingVersion(
					row.id,
					chunkingVersion,
				);
				return { outcome: "skipped" };
			}
			const result = await reembedProjectContext({
				contextId: row.id,
				projectId,
				userId,
				organizationId,
				content: row.content,
				type: row.type,
				apiKey,
				chunkProfile: row.chunkProfile,
				metadata: {
					...((row.metadata as Record<string, unknown> | null) ?? {}),
					filename: row.originalFilename ?? undefined,
					mimeType: row.mimeType ?? undefined,
					sourceUrl: row.sourceUrl ?? undefined,
					sourceTitle: row.sourceTitle ?? undefined,
				},
			});
			if (!result.success) {
				return { outcome: "failed", error: result.error };
			}
			await markProjectContextChunkingVersion(row.id, chunkingVersion);
			return { outcome: "rechunked" };
		}

		const doc = await db.projectDocument.findFirst({
			where: { id: params.sourceId, projectId, organizationId },
			select: {
				id: true,
				type: true,
				title: true,
				content: true,
				version: true,
				isActive: true,
				userId: true,
				chunkProfile: true,
				chunkingVersion: true,
			},
		});
		if (!doc || (doc.chunkingVersion ?? 0) >= chunkingVersion) {
			return { outcome: "skipped" };
		}
		if (!doc.isActive || !doc.content.trim()) {
			await markProjectDocumentChunkingVersion(doc.id, chunkingVersion);
			return { outcome: "skipped" };
		}
		const result = await rechunkProjectDocument({
			documentId: doc.id,
			projectId,
			userId: doc.userId ?? userId,
			organizationId,
			content: doc.content,
			documentType: doc.type,
			title: doc.title,
			apiKey,
			expectedVersion: doc.version,
			chunkProfile: doc.chunkProfile,
		});
		if (!result.success) {
			return { outcome: "failed", error: result.error };
		}
		await markProjectDocumentChunkingVersion(doc.id, chunkingVersion);
		return { outcome: "rechunked" };
	} catch (error) {
		return {
			outcome: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function recordProjectRechunkProgressActivity(params: {
	runId: string;
	total: number;
	done: number;
	failed: number;
	skipped: number;
	finalStatus?: "COMPLETED" | "FAILED" | "SUPERSEDED";
	error?: string;
}): Promise<void> {
	const { runId, finalStatus, error, ...progress } = params;
	// The snapshot taken at the start stays next to the final counts: it is
	// the baseline the next chunking check compares against (spec §8d).
	const snapshot = finalStatus
		? ((
				(await getProjectChunkingRun(runId))?.result as {
					snapshot?: unknown;
				} | null
			)?.snapshot ?? null)
		: null;
	await updateProjectChunkingRun(runId, {
		progress,
		...(finalStatus
			? {
					status: finalStatus,
					result: (snapshot
						? { ...progress, snapshot }
						: progress) as Prisma.InputJsonValue,
					error: error ?? null,
					finished: true,
				}
			: {}),
	});
}
