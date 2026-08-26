/**
 * Should the "story prop → editor" sync (StoryWorkspace Effect 5)
 * be deferred right now?
 *
 * The inline AI diff is DERIVED, not stored: `write_document_local`'s proposed
 * content is painted into the TipTap editor as diff marks (Effect 2), then the
 * user reviews it via the `confirm_changes` HITL card. Effect 5 rebuilds the
 * editor from the `story.description` prop whenever it changes — which is
 * correct after a normal save, but catastrophic mid-review: a background
 * `stories.get` refetch (e.g. `maturationAnswerMutation`'s invalidation, or
 * refetch-on-focus) landing while a diff is pending would rebuild the editor
 * over the diff, wiping it. Because `handleAccept` reads the editor, the wipe
 * turns Accept into a no-op that saves the un-refreshed base — so the pending-
 * decisions appendix survives and the "X decisions not added" banner never
 * clears.
 *
 * This predicate centralises the "a review is in flight, don't touch the
 * editor" decision. It mirrors Effect 4's existing `editorHasDiffMarks` guard
 * and adds the awaiting-confirmation flag so the whole review window is covered,
 * not just the frames where diff marks happen to be present.
 *
 * Fizzy #1987 adds `hasUnsavedChanges` to the same predicate. The AI-review
 * flags above only cover machine-driven edits; a plain background refetch
 * (refetchOnWindowFocus, or any `stories.get` invalidation) landing while the
 * user is mid-sentence hit the exact same destructive path.
 */
export interface StoryPropSyncGuardState {
	/** The copilot chat is streaming a response. */
	isAiLoading: boolean;
	/** The separate "Update using context" (useUpdateWithContext) diff is active. */
	isContextUpdateActive: boolean;
	/** A `write_document_local` confirm_changes review is awaiting accept/reject. */
	isAwaitingConfirmation: boolean;
	/** The editor currently carries diffInsert/diffDelete marks (a pending review). */
	hasPendingDiffMarks: boolean;
	/**
	 * The user has typed edits that have not yet been persisted. Fizzy #1987:
	 * rebuilding the editor here silently destroys their work — the sync must
	 * wait until the editor is clean.
	 */
	hasUnsavedChanges: boolean;
}

/**
 * Returns true when the story-prop → editor sync MUST be skipped because an AI
 * edit/diff review is in flight and rebuilding the editor would destroy it.
 */
export function shouldDeferStoryPropSync(
	state: StoryPropSyncGuardState,
): boolean {
	return (
		state.isAiLoading ||
		state.isContextUpdateActive ||
		state.isAwaitingConfirmation ||
		state.hasPendingDiffMarks ||
		state.hasUnsavedChanges
	);
}
