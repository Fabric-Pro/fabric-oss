import { createHash } from "node:crypto";

/**
 * A short, stable identity of a document body: the SHA-256 of the stored
 * text, in hex. A coordinated Proposal run records it when it takes the
 * document over, so its save can tell that the body changed in between even
 * when the version did not (a rejected regeneration rewinds the version, and
 * its fallback rewrites the body without one), without carrying the whole
 * body through workflow history.
 *
 * Activities only: it reads `node:crypto`, which a workflow bundle cannot.
 */
export function contentIdentity(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}
