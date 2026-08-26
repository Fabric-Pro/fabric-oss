/**
 * Utility for generating Qdrant point IDs
 *
 * Qdrant requires point IDs to be either unsigned integers or UUIDs.
 * This module provides a consistent way to generate deterministic UUID-formatted
 * point IDs from arbitrary strings using SHA256 hashing.
 */

import { createHash } from "node:crypto";

/**
 * Generate a deterministic UUID-formatted point ID from a string
 *
 * @param input - The input string to hash (e.g., contextId, chunkId)
 * @returns A UUID-formatted string (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 */
export function generatePointId(input: string): string {
	const hash = createHash("sha256").update(input).digest("hex");
	// Format as UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
	return [
		hash.slice(0, 8),
		hash.slice(8, 12),
		hash.slice(12, 16),
		hash.slice(16, 20),
		hash.slice(20, 32),
	].join("-");
}
