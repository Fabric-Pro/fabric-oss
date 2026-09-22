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
 * Pure (no Prisma), so the manual-upload dedup that follows (Fizzy #2619) can
 * reuse it from anywhere.
 */

import { createHash } from "node:crypto";

export function hashContextContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}
