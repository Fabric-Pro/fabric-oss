/**
 * Re-chunk one project document under the project's current chunking
 * settings (spec 2026-10-28 §8a), from its stored content.
 *
 * Unlike `reembedProjectDocument` this never skips an unchanged body — the
 * content is the same, the chunking is not — and it never deletes first: the
 * new points are written (an unchanged point id is replaced in place), and
 * only then are the old points the new embed did not overwrite removed. A
 * failed embed removes nothing, so the document stays searchable on its
 * previous chunks.
 */

import { logger } from "@repo/logs";
import {
	deleteProjectContextPoints,
	listProjectContextPointIds,
} from "../project-contexts/store";
import { generatePointId } from "../utils/point-id";
import {
	type DocumentEmbedResult,
	type EmbedDocumentOptions,
	embedProjectDocument,
} from "./embed";

/** Point ids `embedProjectDocument` writes for `chunkCount` chunks. */
export function documentPointIds(
	documentId: string,
	expectedVersion: number | undefined,
	chunkCount: number,
): string[] {
	const base = `doc-${documentId}${expectedVersion != null ? `-v${expectedVersion}` : ""}`;
	const ids = [generatePointId(base)];
	for (let i = 0; i < chunkCount; i++) {
		ids.push(generatePointId(`${base}-chunk-${i}`));
	}
	return ids;
}

export async function rechunkProjectDocument(
	options: EmbedDocumentOptions,
): Promise<DocumentEmbedResult & { removedPoints?: number }> {
	const { documentId, organizationId } = options;
	const previous = await listProjectContextPointIds(
		`doc-${documentId}`,
		organizationId,
	);

	const result = await embedProjectDocument(options);
	if (!result.success) {
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
	await deleteProjectContextPoints(stale, organizationId);
	logger.info(
		`[DocumentEmbed] Re-chunked document ${documentId}: ${result.chunksCreated ?? 0} chunk(s), ${stale.length} old point(s) removed`,
	);
	return { ...result, removedPoints: stale.length };
}
