/**
 * Utility for handling chunked context IDs
 *
 * When storing large content in Qdrant, we split it into chunks with IDs like
 * "contextId-chunk-0", "contextId-chunk-1", etc. When retrieving from Postgres,
 * we need to map these back to the base contextId.
 */

/**
 * Extract the base context ID from a potentially chunked context ID
 *
 * Chunks are stored with IDs like "contextId-chunk-0" in Qdrant, but the
 * actual ProjectContext row in Postgres uses the base "contextId".
 *
 * @param chunkId - The context ID from Qdrant (may include -chunk-N suffix)
 * @returns The base context ID without the chunk suffix
 *
 * @example
 * extractBaseContextId("abc123-chunk-0") // returns "abc123"
 * extractBaseContextId("abc123-chunk-15") // returns "abc123"
 * extractBaseContextId("abc123") // returns "abc123" (no change)
 */
export function extractBaseContextId(chunkId: string): string {
	const chunkMatch = chunkId.match(/^(.+)-chunk-\d+$/);
	return chunkMatch ? chunkMatch[1] : chunkId;
}

/**
 * Extract unique base context IDs from an array of potentially chunked IDs
 *
 * @param chunkIds - Array of context IDs from Qdrant results
 * @returns Array of unique base context IDs
 */
export function extractUniqueBaseContextIds(chunkIds: string[]): string[] {
	return [...new Set(chunkIds.map(extractBaseContextId))];
}
