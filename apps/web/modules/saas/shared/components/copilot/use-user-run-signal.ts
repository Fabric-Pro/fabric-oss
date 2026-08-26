"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How long a mark can sit "pending" (set, but no run has started yet) before it self-expires. */
const PENDING_RUN_START_TIMEOUT_MS = 15_000;

/**
 * `isLoading` alone can't tell a real generation apart from the AG-UI
 * connect handshake: `connectAgent` (@ag-ui/client) sets `agent.isRunning`
 * true AND hydrates the agent thread's persisted message history into
 * `messages` on every mount, so a message-count heuristic false-positives
 * on every page load of a thread that already has history. This hook gates
 * the "AI is generating…" pill on an explicit mark supplied by the send
 * surfaces (chat input `onSend`, programmatic `appendMessage` triggers,
 * suggestion chips, and message regeneration) instead.
 *
 * The mark is cleared ONLY on the true→false transition of `isLoading`
 * (i.e. when a run actually completes), never on every `!isLoading` render.
 * The mark is always set before `isLoading` flips true (the caller marks
 * intent, then hands the message to CopilotKit, which starts the run), so
 * clearing on any idle render would wipe the flag during the send →
 * run-start gap and the pill would never show.
 *
 * A mark that is set but never turns into a run (`onBeforeSend` throws,
 * `onSend`/`appendMessage` rejects before streaming starts, or any other
 * unmarked failure between mark and run-start) would otherwise stay stuck
 * "on" and get surfaced as a false pill by a later, unrelated handshake.
 * Callers should clear deterministically at known failure points via
 * `clearUserRunMark` (see `CopilotSidebarInput`'s `onUserSendFailed` and
 * the `catch` blocks around programmatic `appendMessage` calls), but as a
 * self-healing backstop for paths that can't be wrapped in a try/catch
 * (e.g. CopilotKit-internal send failures on the suggestion/regenerate
 * entry points), a mark that never transitions `isLoading` to `true` within
 * `PENDING_RUN_START_TIMEOUT_MS` expires on its own.
 *
 * Accepted false negative: reloading mid-run reattaches to a live stream
 * without a mark (there was no send surface to fire `markUserRunInitiated`
 * on this mount), so the pill won't show for a run resumed after reload —
 * the chat transcript still streams visibly, so the user isn't left
 * without any generation feedback.
 */
export function useUserRunSignal(isLoading: boolean): {
	isUserGenerationActive: boolean;
	markUserRunInitiated: () => void;
	clearUserRunMark: () => void;
} {
	const [initiated, setInitiated] = useState(false);
	const prevLoadingRef = useRef(false);
	useEffect(() => {
		if (prevLoadingRef.current && !isLoading) {
			setInitiated(false);
		}
		prevLoadingRef.current = isLoading;
	}, [isLoading]);

	// Pending-mark expiry: only armed while `initiated` is true AND the run
	// hasn't started yet (`!isLoading`). Once `isLoading` flips true the
	// mark is consumed by an actual run and must NOT expire out from under
	// it — the true→false effect above is the only thing that clears an
	// active run's mark.
	useEffect(() => {
		if (!initiated || isLoading) {
			return;
		}
		const timer = setTimeout(
			() => setInitiated(false),
			PENDING_RUN_START_TIMEOUT_MS,
		);
		return () => clearTimeout(timer);
	}, [initiated, isLoading]);

	const markUserRunInitiated = useCallback(() => setInitiated(true), []);
	const clearUserRunMark = useCallback(() => setInitiated(false), []);
	return {
		isUserGenerationActive: isLoading && initiated,
		markUserRunInitiated,
		clearUserRunMark,
	};
}
