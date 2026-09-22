/**
 * The content hash of a project context row (Fizzy #2616).
 *
 * sha256 hex over the UTF-8 bytes of the content, exactly as stored — the
 * same digest `upsertUrlPageActivity` keys crawled pages on. Nothing is
 * canonicalised first (no line-ending or whitespace folding): the hash is the
 * compare-and-swap token a synced-file replace must present, and a token that
 * forgave some differences would let one version overwrite another it was
 * never compared against.
 *
 * Pure (no Prisma), so every writer of `content` can stamp the matching hash
 * from anywhere (Fizzy #2619).
 */

import { createHash } from "node:crypto";

export function hashContextContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The `contentHash` to store alongside a write of `content` (Fizzy #2619).
 *
 * Every write of `ProjectContext.content` has to write this with it. A hash
 * left behind by an earlier version would pair the new content with the old
 * version's identity: the Context tab would flag the row as a duplicate of
 * content it no longer holds, and the re-embed race check (which compares
 * hashes) would miss the change.
 *
 * Empty content gets `null`, not the hash of "": a row still waiting for its
 * extraction holds no content yet, and every such row sharing one hash would
 * read as copies of each other.
 */
export function contextContentHashOrNull(content: string): string | null {
	return content.length > 0 ? hashContextContent(content) : null;
}
