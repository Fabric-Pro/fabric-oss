import { toast } from "sonner";

/**
 * Centralised AI-assistant error toasts.
 *
 * Two independent code paths surface assistant errors as sonner toasts:
 *   - `CopilotFetchErrorInterceptor` — patches `window.fetch` and maps HTTP
 *     status codes (429 / 4xx / 5xx) to toasts.
 *   - `useCopilotErrorHandler` — CopilotKit's `onError` callback, for errors
 *     CopilotKit raises internally (agent_state, action, network, …).
 *
 * Both must behave identically, so the toast logic lives here instead of being
 * duplicated. Genuine errors PERSIST until the user dismisses them; only
 * intentionally-transient notices (e.g. a 429 "Retrying in Ns…" countdown) keep
 * a finite duration.
 */

/**
 * A button on the toast. Only one failure warrants one today — an exhausted
 * provider balance, whose copy asks someone to go and top it up. Telling a user
 * to act and then not saying where is most of the way to telling them nothing.
 */
export interface AiErrorToastAction {
	label: string;
	onClick: () => void;
}

/** Dedup window in ms — identical errors within this window are suppressed. */
const DEDUP_WINDOW_MS = 3_000;

/**
 * Persistent error toasts stay on screen until the user dismisses them — no
 * auto-timeout. Paired with `closeButton: true` so there is an explicit
 * click-to-dismiss affordance (sonner exposes no whole-body onClick).
 */
const PERSIST_UNTIL_DISMISSED = Number.POSITIVE_INFINITY;

/**
 * Last-shown timestamp per `title\0description` key. Module-global so dedup
 * holds across BOTH call paths and across component remounts — the same error
 * arriving via fetch interception and CopilotKit's `onError` within the window
 * shows once, not twice. Bounded by the small set of distinct error copy.
 */
const recentToasts = new Map<string, number>();

function dedupeKey(title: string, description: string): string {
	return `${title}\0${description}`;
}

/** Returns true (and records the timestamp) if this key may toast right now. */
function shouldShow(key: string, now: number): boolean {
	const last = recentToasts.get(key);
	if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
		return false;
	}
	recentToasts.set(key, now);
	return true;
}

/**
 * Show a PERSISTENT error toast: it never auto-dismisses
 * (`duration: Infinity`), carries a close button, and reuses a stable id (the
 * dedup key) so a repeated identical error REPLACES the existing toast instead
 * of stacking unbounded copies the user would have to clear one by one.
 */
export function showPersistentAiErrorToast(
	title: string,
	description: string,
	now: number = Date.now(),
	action?: AiErrorToastAction,
): void {
	const key = dedupeKey(title, description);
	if (!shouldShow(key, now)) {
		return;
	}
	toast.error(title, {
		description,
		duration: PERSIST_UNTIL_DISMISSED,
		closeButton: true,
		// Stable id → a repeated identical error replaces the existing toast.
		id: key,
		...(action ? { action } : {}),
	});
}

/**
 * Show a TRANSIENT error toast that auto-dismisses after `durationMs`. Used for
 * self-resolving notices such as the 429 rate-limit "Retrying in Ns…" countdown,
 * where a persistent toast would linger after the wait window had elapsed.
 */
export function showTransientAiErrorToast(
	title: string,
	description: string,
	durationMs: number,
	now: number = Date.now(),
): void {
	const key = dedupeKey(title, description);
	if (!shouldShow(key, now)) {
		return;
	}
	toast.error(title, { description, duration: durationMs });
}

/**
 * Retract a persistent toast whose condition has resolved itself.
 *
 * Only one notice here is provisional: the stream-silence warning, raised when
 * a run has sent nothing for long enough to look wedged. If the run then
 * resumes, leaving that toast on screen would be the same false alarm this
 * module exists to avoid — the user would be told the assistant had stopped
 * while it was visibly answering.
 *
 * Clears the dedup entry as well as the toast, so a second genuine stall in the
 * same conversation is not swallowed by the window.
 */
export function dismissAiErrorToast(title: string, description: string): void {
	const key = dedupeKey(title, description);
	recentToasts.delete(key);
	toast.dismiss(key);
}

/**
 * Retract a notice AND say so, for the one case where the condition resolved
 * itself rather than being superseded by something more specific.
 *
 * A bare `dismiss` is invisible to assistive technology: sonner's container is
 * `aria-live="polite" aria-relevant="additions text"`, so a toast leaving the
 * DOM is never announced. A sighted user reads the disappearance as "resolved";
 * a screen-reader user is simply left holding the last thing they were told,
 * which was that the assistant had stopped. The short replacement is an
 * addition, so it is announced, and it expires on its own rather than adding
 * another thing to dismiss.
 */
export function resolveAiErrorToast(
	staleTitle: string,
	staleDescription: string,
	resolved: { title: string; description: string },
	durationMs = 4_000,
): void {
	dismissAiErrorToast(staleTitle, staleDescription);
	toast.success(resolved.title, {
		description: resolved.description,
		duration: durationMs,
	});
}

/** Test-only: clear the dedup window so each test starts from a clean slate. */
export function resetAiErrorToastDedupForTests(): void {
	recentToasts.clear();
}
