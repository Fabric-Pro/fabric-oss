/**
 * Whether outside writers must refuse to write a document's body or status
 * while a generation run holds it (status QUEUED or GENERATING), and must pass
 * `refuseWhileGenerating` so the write itself refuses a run queued after their
 * read. A Proposal's run saves its body at the old version, so the version
 * guard alone cannot see it (Fizzy #2946).
 *
 * Decided by type alone, never by the PROPOSAL_ARTIFACT rollout gate: a run
 * already in progress keeps writing when the gate is turned off, and a
 * rollback must not let an outside write overwrite the body it is producing.
 * Every guarded writer (the editor's procedures, the v1 API, the MCP gateway,
 * the scheduled refresh) calls this so they cannot drift apart.
 *
 * Pure: no database, no organization, so the API, the web and the Temporal
 * worker all share it.
 */
export function isRunGuardedDocumentType(documentType: string): boolean {
	return documentType === "PROPOSAL";
}

/** Error code for a caller that sent a status only a generation run may set. */
export const DOCUMENT_STATUS_GENERATION_OWNED =
	"DOCUMENT_STATUS_GENERATION_OWNED";

/**
 * QUEUED and GENERATING are set by generation dispatch, together with the
 * run's workflow id and start time. A row a caller puts in either status has
 * neither: the run guard above then refuses every later write to it, and the
 * stale-generation watchdog, which needs those fields, can never move it on.
 * So no outside caller (oRPC, the v1 API, the MCP gateway) may send them on a
 * create or an update, for any document type; server code that starts a run
 * writes them itself.
 */
export function isGenerationOwnedStatus(
	status: unknown,
): status is "QUEUED" | "GENERATING" {
	return status === "QUEUED" || status === "GENERATING";
}

export function generationOwnedStatusMessage(
	status: "QUEUED" | "GENERATING",
): string {
	return `Status ${status} is set by generation runs and cannot be written directly`;
}
