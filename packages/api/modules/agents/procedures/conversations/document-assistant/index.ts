/**
 * Document-assistant procedure barrel.
 *
 * Public names live under `agents.conversations.*` so consumers call
 * `orpc.agents.conversations.listForDocument` etc. (matches the existing
 * nesting convention — spec §5.9).
 */

export { appendTurnForDocument } from "./append-turn-for-document";
export { archiveForDocument } from "./archive-for-document";
export { deleteForDocument } from "./delete-for-document";
export { forkForDocument } from "./fork-for-document";
export { getActiveForDocument } from "./get-active-for-document";
export { getByIdForDocument } from "./get-by-id-for-document";
export { listForDocument } from "./list-for-document";
export { recordDiffOutcome } from "./record-diff-outcome";
export { renameForDocument } from "./rename-for-document";
export { setVisibilityForDocument } from "./set-visibility-for-document";
