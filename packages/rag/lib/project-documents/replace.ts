import { logger } from "@repo/logs";
import {
	deleteProjectContextPoints,
	listProjectContextPointIds,
} from "../project-contexts/store";
import { generatePointId } from "../utils/point-id";
import type { DocumentEmbedResult, EmbedDocumentOptions } from "./embed";
/** Point ids `embedProjectDocument` writes for `chunkCount` chunks. */
export function documentPointIds(
	documentId: string,
	expectedVersion: number | undefined,
	chunkCount: number,
): string[] {
	const base = `doc-${documentId}${expectedVersion != null ? `-v${expectedVersion}` : ""}`;
	if (chunkCount === 1) {
		return [generatePointId(base)];
	}
	const ids: string[] = [];
	for (let i = 0; i < chunkCount; i++) {
		ids.push(generatePointId(`${base}-chunk-${i}`));
	}
	return ids;
}

export async function replaceDocumentEmbedding(
	options: EmbedDocumentOptions,
	embed: (options: EmbedDocumentOptions) => Promise<DocumentEmbedResult>,
): Promise<DocumentEmbedResult & { removedPoints?: number }> {
	const { documentId, organizationId } = options;
	const previous = await listProjectContextPointIds(
		`doc-${documentId}`,
		organizationId,
	);

	const result = await embed(options);
	if (!result.success || result.superseded) {
		return result;
	}

	const written = new Set(
		documentPointIds(
			documentId,
			options.expectedVersion,
			result.chunksCreated ?? 0,
		),
	);
	const stale = previous.filter((id) => !written.has(id));
	try {
		await deleteProjectContextPoints(stale, organizationId);
	} catch (error) {
		logger.warn("[DocumentEmbed] Failed to remove stale points", { error });
		return result;
	}
	logger.info(
		`[DocumentEmbed] Replaced embedding for document ${documentId}: ${result.chunksCreated ?? 0} chunk(s), ${stale.length} old point(s) removed`,
	);
	return { ...result, removedPoints: stale.length };
}
