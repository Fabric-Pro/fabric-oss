/**
 * Cancellation telemetry helper for the four AI surfaces (Nexus, the Fabric
 * Agent launcher, Loom Direct, Loom Orchestrator).
 *
 * Single named export `emitCancelEvent`. All three streaming hooks
 * (`useDirectStream`, `useOrchestratorStream`, `useMultiAgentStream`) call
 * this once per cancelled message / agent at the end of their synchronous
 * stop flip.
 *
 * Implements section 10.1 of the `2026-05-09-stop-ai-generation` spec
 * (decision 15).
 *
 * `partial_token_count` should be estimated by callers from the rendered
 * partial body using `Math.ceil(messageBody.length / 4)`. See spec section
 * 10.1.
 */

/**
 * Surfaces that can emit a cancel event. The strings match the spec's
 * `surface` taxonomy and are also used as PostHog property values, so do not
 * rename them without updating downstream dashboards.
 */
type CancelEventSurface =
	| "nexus"
	| "fabric-agent-launcher"
	| "loom-direct"
	| "loom-orchestrator";

/**
 * What initiated the cancel — a button click on the morphed Send -> Stop
 * control, or the Esc keybinding handled by `useEscToStopOrClose`.
 */
type CancelEventTrigger = "button" | "esc";

/**
 * Payload shape for `ai_generation_cancelled`.
 *
 * - `agentId` / `executionId` are optional: single-agent surfaces don't have
 *   an `agentId` (callers pass `null`), and direct-chat turns may emit before
 *   an executionId is known. Both accept `string | null | undefined` so
 *   callers can pass `value ?? null` without an extra coercion step — the
 *   helper normalises absent-vs-null at the analytics boundary.
 * - `partial_token_count` is the estimated count from
 *   `Math.ceil(messageBody.length / 4)`.
 * - `latency_to_cancel_ms` is `Date.now() - streamStartedAt`, where
 *   `streamStartedAt` is recorded by the hook when streaming begins.
 */
export interface CancelEventPayload {
	surface: CancelEventSurface;
	agentId?: string | null;
	executionId?: string | null;
	partial_token_count: number;
	latency_to_cancel_ms: number;
	triggered_by: CancelEventTrigger;
}

/**
 * Name of the analytics event. Exported so consumers (and tests) can listen
 * without re-declaring the literal.
 */
const CANCEL_EVENT_NAME = "ai_generation_cancelled";

/**
 * Name of the DOM `CustomEvent` we dispatch on `window` so the application's
 * `useAnalytics()` consumer (and tests) can observe the cancel without us
 * coupling this helper to a specific provider. The event detail is the full
 * `CancelEventPayload` plus the analytics event name.
 */
const CANCEL_DOM_EVENT_NAME = "fabric:ai-generation-cancelled";

interface PosthogLike {
	capture?: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * Emit `ai_generation_cancelled` for telemetry / observability.
 *
 * Behaviour:
 *   1. Forwards to `window.posthog.capture(...)` when PostHog is loaded
 *      (matches the existing `apps/web/modules/analytics/provider/posthog`
 *      wrapper, which initialises PostHog onto the global).
 *   2. Always dispatches a `CustomEvent` on `window` so a `useAnalytics()`
 *      bridge or a test spy can observe the call without coupling this
 *      module to React.
 *
 * Failures inside any branch are swallowed — analytics MUST NOT throw out of
 * the user's cancel path.
 */
export function emitCancelEvent(payload: CancelEventPayload): void {
	try {
		if (typeof window === "undefined") {
			return;
		}

		try {
			const posthog = (window as unknown as { posthog?: PosthogLike })
				.posthog;
			posthog?.capture?.(CANCEL_EVENT_NAME, {
				...payload,
			});
		} catch {
			// Swallow — analytics failures must never break the cancel UX.
		}

		try {
			const detail = {
				event: CANCEL_EVENT_NAME,
				payload,
			};
			window.dispatchEvent(
				new CustomEvent(CANCEL_DOM_EVENT_NAME, { detail }),
			);
		} catch {
			// Swallow — older runtimes may not support CustomEvent.
		}
	} catch {
		// Final safety net — never throw out of telemetry.
	}
}
