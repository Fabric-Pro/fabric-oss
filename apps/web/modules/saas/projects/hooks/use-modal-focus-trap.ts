"use client";

import {
	type KeyboardEvent as ReactKeyboardEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
} from "react";

/** The elements inside `container` that Tab can reach, in document order. */
function keyboardFocusablesIn(container: HTMLElement | null): HTMLElement[] {
	return Array.from(
		container?.querySelectorAll<HTMLElement>(
			'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
		) ?? [],
	);
}

/**
 * Focuses `element` when it can take focus — still on the page and not a
 * disabled control — and says whether focus landed on it. A control hidden
 * with `display:none` refuses focus too, which only the landing shows.
 */
function focusIfAble(element: HTMLElement | null | undefined): boolean {
	if (!element?.isConnected || element.matches(":disabled")) {
		return false;
	}
	element.focus();
	return element.ownerDocument.activeElement === element;
}

type ModalFocusTrapOptions = {
	/** Whether the panel is showing. */
	open: boolean;
	/** The panel, which takes focus itself when nothing in it can. */
	panelRef: RefObject<HTMLElement | null>;
	/** Escape inside the panel: close it. */
	onEscape: () => void;
	/**
	 * Where focus goes on close when what opened the panel can no longer
	 * take it: gone from the page, disabled, or hidden.
	 */
	fallbackFocus?: () => HTMLElement | null;
	/**
	 * The control inside the panel that takes focus when it opens, and when
	 * focus is brought back in, e.g. the least destructive one. Without it,
	 * or when it is not in the panel or cannot take focus, the panel's first
	 * control does.
	 */
	initialFocus?: () => HTMLElement | null;
};

/**
 * Keeps keyboard focus in a modal panel: focus moves into it when it opens
 * (onto `initialFocus` when given), stays in it while open, Tab and
 * Shift+Tab wrap around inside it, Escape closes it, and focus goes back to
 * what opened it when it closes.
 *
 * `rememberOpener` records what has focus as the opener; call it in the
 * handler that opens the panel, before the panel renders. `onKeyDown` goes
 * on the panel.
 */
export function useModalFocusTrap({
	open,
	panelRef,
	onEscape,
	fallbackFocus,
	initialFocus,
}: ModalFocusTrapOptions) {
	// What had focus when the panel opened, to give it back on close.
	const openerRef = useRef<HTMLElement | null>(null);
	const fallbackFocusRef = useRef(fallbackFocus);
	fallbackFocusRef.current = fallbackFocus;
	// Read through a ref, like the fallback, so a caller's new function on
	// each render never re-runs the effect below.
	const initialFocusRef = useRef(initialFocus);
	initialFocusRef.current = initialFocus;

	const rememberOpener = useCallback(() => {
		const opener = window.document.activeElement;
		openerRef.current = opener instanceof HTMLElement ? opener : null;
	}, []);

	useEffect(() => {
		if (!open) {
			return;
		}
		const focusInitial = () => {
			const panel = panelRef.current;
			const initial = initialFocusRef.current?.();
			if (initial && panel?.contains(initial) && focusIfAble(initial)) {
				return;
			}
			(keyboardFocusablesIn(panel)[0] ?? panel)?.focus();
		};
		focusInitial();
		// Something outside took focus, e.g. the overflow menu handing it back
		// to its trigger as it closes: bring it back in, to where it went on
		// open. If what opened the panel is gone by then, that outside element
		// is where focus returns on close.
		const onFocusIn = (event: FocusEvent) => {
			const panel = panelRef.current;
			const target = event.target;
			if (!panel || !(target instanceof HTMLElement)) {
				return;
			}
			if (panel.contains(target)) {
				return;
			}
			if (!openerRef.current?.isConnected) {
				openerRef.current = target;
			}
			focusInitial();
		};
		window.document.addEventListener("focusin", onFocusIn);
		return () => {
			window.document.removeEventListener("focusin", onFocusIn);
			const opener = openerRef.current;
			openerRef.current = null;
			// An opener disabled by what the panel started, or one gone from
			// the page, cannot take focus back; without the fallback it would
			// land on the page body.
			if (!focusIfAble(opener)) {
				focusIfAble(fallbackFocusRef.current?.());
			}
		};
	}, [open, panelRef]);

	const onKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLElement>) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onEscape();
				return;
			}
			if (event.key !== "Tab") {
				return;
			}
			// Tab and Shift+Tab wrap around inside the panel.
			const panel = panelRef.current;
			const items = keyboardFocusablesIn(panel);
			const first = items[0];
			const last = items[items.length - 1];
			if (!first || !last) {
				return;
			}
			const active = window.document.activeElement;
			if (event.shiftKey && (active === first || active === panel)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && active === last) {
				event.preventDefault();
				first.focus();
			}
		},
		[onEscape, panelRef],
	);

	return { onKeyDown, rememberOpener };
}
