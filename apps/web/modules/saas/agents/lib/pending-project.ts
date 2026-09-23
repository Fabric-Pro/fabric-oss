/**
 * The full page's `pendingProjectId` is the project the next turn carries.
 * It has two sources: the user's own pick (or the launch / agent default),
 * and a restore from the conversation that was opened (Fizzy #2040). A
 * restored project belongs to that conversation only, so it must not follow
 * the user into the next one — while a project they picked themselves keeps
 * its long-standing behaviour of staying selected.
 *
 * `restored` is the project id the last restore wrote, or `null`.
 */
interface PendingProjectState {
	pending: string | null;
	restored: string | null;
}

/** A conversation opened whose stored project is `conversationProjectId`. */
export function pendingProjectOnOpen(
	state: PendingProjectState,
	conversationProjectId: string | null,
): PendingProjectState {
	if (conversationProjectId) {
		if (conversationProjectId === state.pending) {
			return state;
		}
		return {
			pending: conversationProjectId,
			restored: conversationProjectId,
		};
	}
	if (state.pending !== null && state.pending === state.restored) {
		return { pending: null, restored: null };
	}
	return state;
}

/** New chat: a restored project gives way to the page's own default. */
export function pendingProjectOnNewChat(
	state: PendingProjectState,
	fallback: string | null,
): PendingProjectState {
	if (state.pending !== null && state.pending === state.restored) {
		return { pending: fallback, restored: null };
	}
	return state;
}
