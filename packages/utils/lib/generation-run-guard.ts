/**
 * Whether outside writers must refuse to write a document's body or status
 * while a generation run holds it (status QUEUED or GENERATING). The database
 * write (`updateDocument`, and the restore and reject-regeneration queries)
 * refuses such a write by default, a run queued after the caller's read
 * included; callers check it at their own read to answer before any work. A
 * Proposal's run saves its body at the old version, so the version guard alone
 * cannot see it (Fizzy #2946).
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

/**
 * Error code for a content or status write refused because a generation run
 * holds the document (oRPC `CONFLICT`, v1 and MCP 409).
 */
export const DOCUMENT_GENERATION_IN_PROGRESS =
	"DOCUMENT_GENERATION_IN_PROGRESS";

/**
 * How long a GENERATING run may go without a server write before it no longer
 * counts as writing (Fizzy #2946). Ten minutes: the editor stops polling such
 * a run, and the editor's own content save may then write over it.
 */
export const GENERATION_RUN_SILENCE_CEILING_MS = 10 * 60 * 1000;

/** The row fields {@link isGenerationRunStillWriting} judges a run by. */
type GenerationRunClock = {
	status: string;
	generationStartedAt?: Date | string | null;
	updatedAt?: Date | string | null;
};

/**
 * Whether a document's generation run still holds it as a writer: QUEUED at
 * any age, since that run waits on the project's own context work, which can
 * legitimately take an hour; or GENERATING with a server write within
 * {@link GENERATION_RUN_SILENCE_CEILING_MS} of `now`. A GENERATING run that
 * has been silent for longer has stalled, and any other status holds no run.
 *
 * A GENERATING run is judged from its last server write (`updatedAt`), not
 * from when its request was accepted (`generationStartedAt`, the attempt's
 * identity, which a long context wait has already aged), falling back to the
 * accepted-at stamp and then to `now` when there is nothing to read.
 *
 * The one rule for both sides: the editor stops treating a run as writing by
 * it, and `updateDocument` honours the editor's content-save exemption only
 * when it answers false, so a save the editor sends over a stalled run is not
 * refused, and a save over a live run is refused for every caller.
 */
export function isGenerationRunStillWriting(
	document: GenerationRunClock,
	now: number = Date.now(),
): boolean {
	if (document.status === "QUEUED") {
		return true;
	}
	if (document.status !== "GENERATING") {
		return false;
	}
	const lastWrite = document.updatedAt || document.generationStartedAt;
	if (!lastWrite) {
		return true;
	}
	// Negated rather than `<=`, so an unreadable stamp counts as a recent
	// write, as the editor's poll has always counted it.
	return !(
		now - new Date(lastWrite).getTime() >
		GENERATION_RUN_SILENCE_CEILING_MS
	);
}
