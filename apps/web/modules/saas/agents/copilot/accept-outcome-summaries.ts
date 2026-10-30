import type { ScopedRevisionRefusalCode } from "@repo/utils/proposal-artifact/scoped-revision-codes";

/**
 * What the chat records of an accepted assistant proposal, once the save it
 * sent has been answered (Fizzy #2946). The document editor and the feature
 * workspace say the same things, so they are said here once; the workspace
 * alone moves a feature to a stage.
 *
 * Recorded through `useConfirmChangesOperationResult`: `saved`, `advanced`
 * and `stageRequested` as a success, `failed`, `failedOfferedToCopy` and
 * `failedEditorClosed` as a failure, `unsaved` as partial, `undone` and
 * `heldElsewhere` as cancelled.
 */
export const ACCEPT_OUTCOME_SUMMARIES = {
	saved: "Changes applied.",
	advanced: (stage: string) =>
		`Changes applied — advanced to stage ${stage}.`,
	stageRequested: (stage: string) =>
		`Changes applied — the move to stage ${stage} was sent for approval.`,
	/** Refused, and the accepted text is still in the editor. */
	failed: "The accepted changes could not be saved; they are still in the editor.",
	/**
	 * Refused, and the editor no longer holds the accepted text: the page
	 * was left, or the room was brought back to the saved document. The
	 * text was offered to copy instead.
	 */
	failedOfferedToCopy:
		"The accepted changes could not be saved; they were offered to copy.",
	/**
	 * Refused after the editor that held the accepted text was closed, with
	 * nothing offered to copy.
	 */
	failedEditorClosed: "The accepted changes could not be saved.",
	/** No save of its own was answered: the text waits in the editor. */
	unsaved: "The accepted changes are in the editor, not saved yet.",
	/**
	 * Taken back in the editor while its save still waited, so it was
	 * never sent: the editor's own text went instead.
	 */
	undone: "The accepted changes were undone before they were saved.",
	/**
	 * Never put in: another editor of the document reviewed an assistant
	 * proposal of its own while this one was made (the document editor).
	 */
	heldElsewhere:
		"Not applied: another tab was reviewing an assistant proposal.",
	/**
	 * Not saved, and taken back out of the editor: an AI accept on a
	 * client-document Proposal refused by the check its save runs, with no
	 * saved base to be checked against, or whose save failed (Fizzy #2946).
	 */
	notApplied: (reason: string) => `Not applied: ${reason}`,
} as const;

/**
 * Why an AI accept on a client-document Proposal was not applied, for
 * `ACCEPT_OUTCOME_SUMMARIES.notApplied` (Fizzy #2946), by the refusal code
 * of its save or the editor's own code; `unknown` for any other.
 */
const ACCEPT_NOT_APPLIED_REASONS: Record<
	ScopedRevisionRefusalCode | "NO_BASE" | "HELD_ELSEWHERE",
	string
> = {
	REVISION_OUTSIDE_TARGET:
		"it changed a section outside the one it targeted.",
	REVISION_CHANGED_DIAGRAM: "it changed an existing diagram.",
	RESPONSE_ECHOED: "it repeated wording from the Internal Analysis.",
	FINDING_RESPONSE_CHANGED: "the finding's answer changed in the meantime.",
	FINDING_SECTION_CHANGED:
		"the finding's section changed since the analysis raised it.",
	// The same code covers a revision past its expiry and accepted text that
	// is not the reviewed one; which of them is not known here.
	REVISION_TOKEN_INVALID:
		"the revision had expired, or the accepted text differed from what was reviewed. Request it again.",
	NO_BASE: "the editor was still syncing with the saved document.",
	HELD_ELSEWHERE: "another tab was reviewing an assistant proposal.",
};
const ACCEPT_NOT_APPLIED_UNKNOWN_REASON = "its save did not go through.";

/** The reason `ACCEPT_OUTCOME_SUMMARIES.notApplied` records for `code`. */
export function acceptNotAppliedReason(code: string | undefined): string {
	return (
		(code !== undefined &&
			(ACCEPT_NOT_APPLIED_REASONS as Partial<Record<string, string>>)[
				code
			]) ||
		ACCEPT_NOT_APPLIED_UNKNOWN_REASON
	);
}
