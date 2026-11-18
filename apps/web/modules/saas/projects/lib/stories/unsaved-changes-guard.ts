/**
 * Is the editor holding content that has not reached the server?
 *
 * `hasUnsavedChanges` used to be a blind boolean, set on keystroke and cleared
 * whenever any save resolved. That conflates "a save completed" with "the
 * editor matches the server", which is false whenever the user kept typing
 * while a save was in flight — the editor stays editable during a save, so this
 * is easy to hit. Deriving the flag from the content itself removes the whole
 * class of "marked clean, never sent".
 */

/** Trailing whitespace is a serializer artifact, not a user edit. */
function normalize(markdown: string | null): string | null {
	return markdown === null ? null : markdown.replace(/\s+$/, "");
}

/**
 * Returns true when `current` differs from what was last persisted.
 *
 * `current === null` means the editor could not be serialized. We cannot prove
 * the content is saved, so we report dirty — the flag must never be cleared on
 * a guess.
 */
export function isEditorDirty(
	current: string | null,
	lastSaved: string | null,
): boolean {
	if (current === null) {
		return true;
	}
	const normalizedCurrent = normalize(current) ?? "";
	const normalizedLastSaved = normalize(lastSaved);
	if (normalizedLastSaved === null) {
		// Never saved: dirty unless the document is empty.
		return normalizedCurrent !== "";
	}
	return normalizedCurrent !== normalizedLastSaved;
}

/**
 * The last-saved snapshot to hold once an AI run starts.
 *
 * A clean editor with no save in flight holds what the server has, so its
 * serialization at run start (`baseline`) is the saved text in the editor's
 * own shape. The snapshot is otherwise seeded from the stored markdown, which
 * the editor does not always reproduce byte for byte; comparing a Reject's
 * restored text against that read an untouched story as dirty and saved it.
 * A dirty editor or a save in flight keeps `lastSaved`: that save confirms
 * what it sent.
 */
export function lastSavedAtRunStart({
	baseline,
	lastSaved,
	hasUnsavedChanges,
	saveInFlight,
}: {
	baseline: string;
	lastSaved: string | null;
	hasUnsavedChanges: boolean;
	saveInFlight: boolean;
}): string | null {
	return hasUnsavedChanges || saveInFlight ? lastSaved : baseline;
}

/**
 * Does the editor hold an AI draft that no review will resolve?
 *
 * A run streams its draft into the editor as diff marks, and its
 * `confirm_changes` review accepts or rejects them. A run that fails or is
 * stopped before that review leaves the marks with no Accept or Reject, and
 * the next save keeps the AI's partial insertions, because saving strips the
 * marks by keeping added text. Anything still deciding those marks (a run, a
 * pending or resolving review, a context-update review) owns them.
 */
export function hasUnreviewedDraft(state: {
	hasDiffMarks: boolean;
	isAiLoading: boolean;
	isAwaitingConfirmation: boolean;
	hasPendingReview: boolean;
	isResolvingReview: boolean;
	isContextUpdateActive: boolean;
}): boolean {
	return (
		state.hasDiffMarks &&
		!state.isAiLoading &&
		!state.isAwaitingConfirmation &&
		!state.hasPendingReview &&
		!state.isResolvingReview &&
		!state.isContextUpdateActive
	);
}

/**
 * Should we raise the browser's "leave site?" prompt?
 *
 * The Feature/Bug description editor auto-saves on a 10 second debounce
 * (`StoryWorkspace.tsx:1382`). Closing the tab or client-side navigating inside
 * that window dropped the edit with no warning. The debounce itself stays at
 * 10s — shortening it multiplies `FeatureVersion` row churn, since every
 * description change writes a snapshot — so this guard closes the window
 * instead.
 */
export interface UnsavedChangesGuardState {
	/** The editor holds edits that have not been persisted. */
	hasUnsavedChanges: boolean;
	/** A save mutation is already in flight. */
	isSaving: boolean;
}

/**
 * Returns true when leaving the page right now would lose user work.
 *
 * Deliberately false while `isSaving` — the edit is already on its way to the
 * server, and prompting there would fire on every manual save-and-close.
 */
export function shouldWarnBeforeUnload(
	state: UnsavedChangesGuardState,
): boolean {
	return state.hasUnsavedChanges && !state.isSaving;
}
