/**
 * The refusal code `projects.documents.update` answers with when a save that
 * must name the body it was based on arrives without that base (Fizzy #2946).
 *
 * A save from a collaborative editor room sends the room's base, the version
 * and body identity of the saved body the room's content descends from, so
 * the server can refuse a save based on an older body. While the
 * collaborative room flag is on for the owning organization, a content-bearing
 * save of a client-document Proposal without that base is refused with
 * PRECONDITION_FAILED and `data.code` set to this value: it comes from an
 * editor bundle older than the base, and the person has to reload to keep
 * editing.
 *
 * Client-safe: a constant only, so the web can map the code to its copy.
 */
export const DOCUMENT_SAVE_BASE_REQUIRED =
	"DOCUMENT_SAVE_BASE_REQUIRED" as const;
