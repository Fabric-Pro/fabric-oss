"use client";

import { useEffect, useRef } from "react";

/**
 * Options consumed by `useEscToStopOrClose`.
 *
 * - `isInFlight` — `true` when an AI turn is currently streaming. While `true`
 *   the Esc key stops the turn instead of closing the surface.
 * - `onStop` — invoked when Esc is pressed while a turn is in-flight. Should
 *   call the same `stop()` / `stopAll()` exposed by the streaming hook.
 * - `onClose` — optional. Invoked when Esc is pressed while idle. Omit on
 *   surfaces where Esc-while-idle is a no-op (e.g. the standalone Loom pages
 *   per AC-7).
 * - `enabled` — defaults to `true`. Set `false` to detach the listener (e.g.
 *   on unmount-equivalent flag flips, or while a modal owns Esc).
 */
export interface UseEscToStopOrCloseOptions {
	isInFlight: boolean;
	onStop: () => void;
	onClose?: () => void;
	enabled?: boolean;
}

/**
 * Document-level Esc binding shared across the four AI surfaces (Nexus, the
 * Fabric Agent launcher, Loom Direct, and Loom Orchestrator).
 *
 * - When a turn is in-flight, Esc stops the turn (calls `onStop`) and
 *   `preventDefault` + `stopPropagation` so no enclosing component (Sheet,
 *   Dialog, etc.) reacts.
 * - Otherwise, if `onClose` was provided, Esc closes the surface.
 * - The listener registers on the capture phase to mirror the existing
 *   launcher binding in `FabricAgentLauncher.tsx` (which intentionally runs
 *   before Sheet's internal Esc handling).
 *
 * The handler reads `isInFlight` / `onStop` / `onClose` through refs so that
 * the listener captures the latest values without re-binding on every render
 * — keeping it impossible for the keydown handler to call a stale `onStop`.
 *
 * Implements decision 9 / AC-7 of the
 * `2026-05-09-stop-ai-generation` spec.
 */
export function useEscToStopOrClose({
	isInFlight,
	onStop,
	onClose,
	enabled = true,
}: UseEscToStopOrCloseOptions): void {
	// Mirror the latest values into refs so the document-level listener,
	// which we register only when `enabled` toggles, always sees fresh data
	// without us having to tear it down on every render.
	const isInFlightRef = useRef(isInFlight);
	isInFlightRef.current = isInFlight;

	const onStopRef = useRef(onStop);
	onStopRef.current = onStop;

	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!enabled) {
			return;
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") {
				return;
			}

			if (isInFlightRef.current) {
				event.preventDefault();
				event.stopPropagation();
				onStopRef.current();
				return;
			}

			const close = onCloseRef.current;
			if (close) {
				close();
			}
		};

		// Capture phase mirrors the existing launcher binding so we run before
		// Sheet / Dialog / popover internals consume the Esc.
		document.addEventListener("keydown", handleKeyDown, true);
		return () => {
			document.removeEventListener("keydown", handleKeyDown, true);
		};
	}, [enabled]);
}
