"use client";

import { useCallback, useState } from "react";

/**
 * Focuses a text field on request: scrolls it into view and puts the caret at
 * the end. The field may not exist yet when the request is made (a tab switch
 * mounts it a render later), so the focus runs from the field's ref when it
 * mounts, or at once when it is already on screen. Pass `ref` to the field.
 */
export function useRequestedFieldFocus() {
	const [requested, setRequested] = useState(false);
	const ref = useCallback(
		(field: HTMLInputElement | null) => {
			if (!field || !requested) {
				return;
			}
			field.scrollIntoView({ block: "center" });
			field.focus();
			field.setSelectionRange(field.value.length, field.value.length);
			setRequested(false);
		},
		[requested],
	);
	const request = useCallback(() => setRequested(true), []);
	return { ref, request };
}
