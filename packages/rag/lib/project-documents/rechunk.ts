/**
 * Re-chunk a project document from its stored content using the project's
 * current chunking settings. Unlike re-embed, this does not skip an unchanged
 * body: changing chunking settings can change the points for the same content.
 * New points are written before stale points are removed. Provider failures
 * preserve previous points; failed or superseded runs skip stale-point cleanup.
 */
import {
	type DocumentEmbedResult,
	type EmbedDocumentOptions,
	embedProjectDocument,
} from "./embed";
import { replaceDocumentEmbedding } from "./replace";

export { documentPointIds } from "./replace";
export async function rechunkProjectDocument(
	options: EmbedDocumentOptions,
): Promise<DocumentEmbedResult & { removedPoints?: number }> {
	return replaceDocumentEmbedding(options, embedProjectDocument);
}
