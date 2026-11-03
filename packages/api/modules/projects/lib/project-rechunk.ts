/**
 * Start a project re-chunk after a saved chunking change (spec 2026-10-28
 * §8a). One per project: the per-project workflow id with TERMINATE_EXISTING
 * makes a newer change supersede a running one, and its run row is marked
 * SUPERSEDED so RAG Settings shows the newer run.
 */

import { db } from "@repo/database";
import { startProjectRechunkRun } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

export async function startProjectRechunk(params: {
	projectId: string;
	organizationId: string;
	userId: string;
	chunkingVersion: number;
}): Promise<{ runId: string; workflowId: string }> {
	return startProjectRechunkRun(params, withCorrelationMemo);
}

export interface RechunkPreview {
	contexts: number;
	documents: number;
	characters: number;
	/** Rough embedding tokens (4 characters per token). */
	estimatedTokens: number;
}

/**
 * What saving a chunking change would re-chunk: every embedded source of the
 * project except code, which the AST indexer owns.
 */
export async function previewProjectRechunk(
	projectId: string,
	organizationId: string,
): Promise<RechunkPreview> {
	const [contexts, documents] = await Promise.all([
		db.projectContext.findMany({
			where: {
				projectId,
				organizationId,
				extractionStatus: "COMPLETED",
				type: { notIn: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
			},
			select: { content: true },
		}),
		db.projectDocument.findMany({
			where: { projectId, organizationId, embeddedAt: { not: null } },
			select: { content: true },
		}),
	]);
	const characters = [...contexts, ...documents].reduce(
		(sum, row) => sum + row.content.length,
		0,
	);
	return {
		contexts: contexts.length,
		documents: documents.length,
		characters,
		estimatedTokens: Math.ceil(characters / 4),
	};
}
