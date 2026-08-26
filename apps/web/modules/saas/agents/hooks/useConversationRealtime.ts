"use client";

/**
 * useConversationRealtime — Fizzy #1412 PR1.
 *
 * Opens an authenticated SSE connection to
 * `/api/conversations/{conversationId}/realtime` and invalidates the
 * relevant TanStack Query cache slots when a `message_appended` event
 * arrives. The most common trigger is an operation-result system
 * message being appended by the Temporal post-operation activity, but
 * the channel is also used by the (PR3) Sidekick / Backlog / CopilotKit
 * paths.
 *
 * Also mounts a single global `aria-live="polite"` region so screen
 * readers announce newly-arrived completion messages. Mounting this on
 * the hook rather than on `<SystemMessage>` itself avoids the
 * historical-load problem: re-rendering 30 historical system messages
 * on SSR/hydration would otherwise blast them all into the assistive-
 * tech buffer.
 *
 * # Reliability semantics
 *
 *   - SSE is best-effort. The cache is the source of truth; the
 *     realtime push just shortens the gap between "row written" and
 *     "user sees row". A network blip or Redis outage degrades to the
 *     next refetch (TanStack's standard staleTime/refetch cycle).
 *   - If the route returns 404 (ownership check failed) or 503
 *     (Realtime not configured), the hook silently disables itself.
 *     We never surface auth errors to the user via this surface — the
 *     surface that owns the conversation already handles them.
 *   - Reconnects use exponential backoff with random jitter and a hard
 *     ceiling of 5 attempts (I6 fix — the original implementation used
 *     a linear delay but its docstring promised exponential; the linear
 *     algorithm reconnected too aggressively under transient outages
 *     and the 3-attempt ceiling gave up before most blip recoveries).
 *     Delay formula: `base * 2^(attempt-1) + random(0..1000)ms` —
 *     produces (~3s, ~6s, ~12s, ~24s, ~48s) before disabling, with
 *     up to a 1s jitter to avoid thundering-herd reconnect storms
 *     when many tabs reload after a global Redis blip.
 *
 * # Why query-key invalidation, not optimistic patching
 *
 * The persisted message contains formatter output, server-assigned UUID
 * and timestamp — none of which the client can predict. A refetch is
 * the simplest correct path; the latency cost is acceptable because
 * (a) most users don't have the chat open during a 30s+ workflow, and
 * (b) the realtime push exists precisely so the refetch happens at the
 * right moment rather than on the next user interaction.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

const RECONNECT_BASE_DELAY_MS = 3000;
const RECONNECT_JITTER_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Exponential backoff with jitter. `attempt` is 1-indexed (1 = first
 * reconnect attempt). Pure function, exported for test access.
 *
 * @internal
 */
export function computeReconnectDelayMs(attempt: number): number {
	const exponential = RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.random() * RECONNECT_JITTER_MS;
	return exponential + jitter;
}

interface MessageAppendedEvent {
	readonly conversationId: string;
	readonly messageId: string;
	readonly appendedAt: string;
}

type ConversationRealtimeStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "disabled";

interface UseConversationRealtimeOptions {
	readonly conversationId: string | undefined | null;
	readonly enabled?: boolean;
	readonly onMessageAppended?: (event: MessageAppendedEvent) => void;
}

interface UseConversationRealtimeReturn {
	readonly status: ConversationRealtimeStatus;
	/**
	 * The most recent announcement text written to the global aria-live
	 * region by this hook instance. Exposed for testing.
	 */
	readonly liveRegionMessage: string;
}

export function useConversationRealtime(
	options: UseConversationRealtimeOptions,
): UseConversationRealtimeReturn {
	const { conversationId, enabled = true, onMessageAppended } = options;
	const queryClient = useQueryClient();
	const [status, setStatus] =
		useState<ConversationRealtimeStatus>("disconnected");
	const [liveRegionMessage, setLiveRegionMessage] = useState<string>("");
	const eventSourceRef = useRef<EventSource | null>(null);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const attemptsRef = useRef<number>(0);

	useEffect(() => {
		if (!enabled || !conversationId) {
			setStatus("disabled");
			return;
		}

		let cancelled = false;

		const connect = () => {
			if (cancelled) {
				return;
			}
			setStatus("connecting");
			const url = `/api/conversations/${conversationId}/realtime`;
			const eventSource = new EventSource(url, {
				withCredentials: true,
			});

			eventSource.onopen = () => {
				if (cancelled) {
					return;
				}
				attemptsRef.current = 0;
				setStatus("connected");
			};

			eventSource.onmessage = (event) => {
				if (cancelled) {
					return;
				}
				try {
					const parsed = JSON.parse(event.data) as {
						event?: string;
						data?: unknown;
					};
					if (parsed.event !== "message_appended") {
						return;
					}
					const payload = parsed.data as MessageAppendedEvent;
					// Two query key shapes are in use:
					//   ["agents", "conversations", "detail", id] —
					//     useConversationHistory's single-conversation
					//     loader, the canonical shape introduced by the
					//     orchestrator chat history work.
					//   ["conversations", id] — older callers that may
					//     still scope by a flat key.
					// Invalidate both; TanStack's matcher is structural,
					// so an unmatched shape is a no-op.
					queryClient.invalidateQueries({
						queryKey: [
							"agents",
							"conversations",
							"detail",
							payload.conversationId,
						],
					});
					queryClient.invalidateQueries({
						queryKey: ["conversations", payload.conversationId],
					});
					// Live-region announcement (fresh arrival only —
					// historical loads do not pass through here).
					setLiveRegionMessage(
						`Operation result available in chat thread (${payload.appendedAt}).`,
					);
					onMessageAppended?.(payload);
				} catch (error) {
					console.error(
						"[useConversationRealtime] failed to parse event",
						error,
					);
				}
			};

			eventSource.onerror = () => {
				if (cancelled) {
					return;
				}
				eventSource.close();
				setStatus("disconnected");

				if (attemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
					setStatus("disabled");
					return;
				}
				attemptsRef.current += 1;
				if (reconnectTimeoutRef.current) {
					clearTimeout(reconnectTimeoutRef.current);
				}
				reconnectTimeoutRef.current = setTimeout(
					connect,
					computeReconnectDelayMs(attemptsRef.current),
				);
			};

			eventSourceRef.current = eventSource;
		};

		connect();

		return () => {
			cancelled = true;
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
				reconnectTimeoutRef.current = null;
			}
			if (eventSourceRef.current) {
				eventSourceRef.current.close();
				eventSourceRef.current = null;
			}
			attemptsRef.current = 0;
		};
	}, [conversationId, enabled, queryClient, onMessageAppended]);

	// Mount the global aria-live region. Browsers de-duplicate
	// identical-content updates, so writing the same string twice will
	// not double-announce; the timestamp suffix prevents accidental
	// dedup of two real events.
	useEffect(() => {
		if (typeof document === "undefined") {
			return;
		}
		const REGION_ID = "conversation-realtime-aria-live";
		const REFCOUNT_ATTR = "data-hook-refcount";
		let region = document.getElementById(REGION_ID);
		if (!region) {
			region = document.createElement("div");
			region.id = REGION_ID;
			region.setAttribute("aria-live", "polite");
			region.setAttribute("aria-atomic", "true");
			region.setAttribute(REFCOUNT_ATTR, "0");
			// Visually-hidden styles (sr-only equivalent). Inline because
			// this region is rendered outside any React-managed Tailwind
			// scope and must be safe to inject regardless of styling
			// setup. See WCAG 2.1 SC 4.1.3.
			region.style.position = "absolute";
			region.style.width = "1px";
			region.style.height = "1px";
			region.style.padding = "0";
			region.style.margin = "-1px";
			region.style.overflow = "hidden";
			region.style.clip = "rect(0,0,0,0)";
			region.style.whiteSpace = "nowrap";
			region.style.border = "0";
			document.body.appendChild(region);
		}
		// Ref-count subscribers so the region survives as long as ANY
		// hook instance is still using it. The "first instance owns
		// removal" model was racy: if hook A mounted before hook B,
		// then hook A unmounted first, the region would disappear while
		// hook B was still active. Tracked on a DOM data-attribute
		// (rather than module-level state) so the count survives HMR
		// boundaries.
		const currentCount = Number.parseInt(
			region.getAttribute(REFCOUNT_ATTR) ?? "0",
			10,
		);
		region.setAttribute(REFCOUNT_ATTR, String(currentCount + 1));
		if (liveRegionMessage) {
			region.textContent = liveRegionMessage;
		}
		return () => {
			if (!region?.parentNode) {
				return;
			}
			const nextCount =
				Number.parseInt(region.getAttribute(REFCOUNT_ATTR) ?? "1", 10) -
				1;
			if (nextCount <= 0) {
				region.parentNode.removeChild(region);
			} else {
				region.setAttribute(REFCOUNT_ATTR, String(nextCount));
			}
		};
	}, [liveRegionMessage]);

	return {
		status,
		liveRegionMessage,
	};
}
