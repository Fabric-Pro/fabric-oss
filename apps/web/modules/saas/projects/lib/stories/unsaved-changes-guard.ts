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
