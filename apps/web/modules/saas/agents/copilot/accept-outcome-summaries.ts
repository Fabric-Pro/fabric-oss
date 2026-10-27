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
} as const;
