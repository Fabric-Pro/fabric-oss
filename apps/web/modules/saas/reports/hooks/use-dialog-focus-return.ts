"use client";

import { type RefObject, useRef } from "react";

/**
 * Sends focus back to where it was when a dialog with no trigger element closes;
 * Radix would otherwise drop it to the document body. Spread the result on the
 * `DialogContent`. A dialog that opens while nothing has focus, such as one
 * opened on page load, returns focus to `fallbackRef` instead.
 */
export function useDialogFocusReturn(
	fallbackRef?: RefObject<HTMLElement | null>,
) {
	const openerRef = useRef<HTMLElement | null>(null);
	return {
		onOpenAutoFocus: () => {
			const opener = document.activeElement;
			openerRef.current =
				opener instanceof HTMLElement && opener !== document.body
					? opener
					: null;
		},
		onCloseAutoFocus: (event: Event) => {
			event.preventDefault();
			const opener = openerRef.current?.isConnected
				? openerRef.current
				: fallbackRef?.current;
			opener?.focus();
			openerRef.current = null;
		},
	};
}
