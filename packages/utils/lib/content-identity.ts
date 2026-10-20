/**
 * A short, stable identity of a document body: the SHA-256 of the stored
 * text, in hex.
 *
 * The version number alone does not name a body. A Proposal run's final save
 * writes the new body at the old version (the version moves at its next
 * step), a rejected regeneration rewinds the version, and its fallback
 * rewrites the body without one. So every writer that needs to know "is the
 * body still the one I started from" compares this as well (Fizzy #2946):
 *
 * - a coordinated Proposal run records it when it takes the document over,
 *   and its save refuses a body that changed in between, without carrying
 *   the whole body through workflow history;
 * - `projects.documents.get` and `projects.documents.update` return it, and
 *   a save from a collaborative editor room sends it back as half of its
 *   base, so `updateDocument` can refuse a save based on an older body.
 *
 * Always hash the body as the row stores it: the identity of anything else
 * (an unsanitized draft, a normalized copy) never matches.
 *
 * SERVER-ONLY: hashes with `node:crypto`. Browser code never computes it; it
 * stores and sends back the value the server returned. In Temporal, call it
 * from activities only: a workflow bundle cannot load `node:crypto`.
 */

import { createHash } from "node:crypto";

export function contentIdentity(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}
