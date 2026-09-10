/**
 * The machine-readable cause of a refusal raised because the organization the
 * request names has been deleted and is sitting in its retention window
 * (Fizzy #2462).
 *
 * DISTINCT FROM `MISSING_ORGANIZATION_CONTEXT` on purpose, even though both are
 * a FORBIDDEN raised at the same boundary. They ask the client for opposite
 * things: a missing workspace means "your session lost its pointer, reload";
 * a deleted one means "this workspace is gone, and if you are its owner you can
 * bring it back". Collapsing them would make the second unofferable, because a
 * client cannot tell which situation it is in without matching on message text.
 *
 * Following the same asymmetry as `./missing-organization-context.ts`: the CODE
 * is declared once, here, so a second emitter cannot invent its own spelling of
 * it — but the SENTENCE is deliberately spelled out at each emit site rather
 * than shared from this module, so a source-scanning test can find the emitters
 * instead of finding this file.
 */
export const DELETED_ORGANIZATION_ERROR_CODE = "ORGANIZATION_DELETED";
