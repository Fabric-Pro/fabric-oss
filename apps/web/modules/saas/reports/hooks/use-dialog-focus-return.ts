"use client";

import { useRef } from "react";

/**
 * Sends focus back to where it was when a dialog with no trigger element closes;
 * Radix would otherwise drop it to the document body. Spread the result on the
 * `DialogContent`.
 */
export function useDialogFocusReturn() {
	const openerRef = useRef<HTMLElement | null>(null);
	return {
		onOpenAutoFocus: () => {
			openerRef.current =
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: null;
		},
		onCloseAutoFocus: (event: Event) => {
			event.preventDefault();
			openerRef.current?.focus();
			openerRef.current = null;
		},
	};
}
