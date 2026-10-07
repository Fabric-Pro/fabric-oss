import { type RefObject, useEffect } from "react";

/**
 * Grows a textarea with its text up to `maxHeight` pixels and only scrolls
 * past that. Without it, a chat composer keeps its default rows and a long
 * prompt scrolls inside a sliver of a box.
 *
 * `maxHeight` should match the textarea's `max-h-*` class. Pass anything that
 * changes what is measured without changing the text — rows, typography, a
 * layout variant — as `layoutKey`, so the textarea is re-measured then too.
 */
export function useAutoResizeTextarea(
	ref: RefObject<HTMLTextAreaElement | null>,
	value: string,
	maxHeight: number,
	layoutKey?: unknown,
) {
	// `value` and `layoutKey` are triggers only: the effect measures the DOM.
	useEffect(() => {
		const el = ref.current;
		if (!el) {
			return;
		}
		el.style.height = "auto";
		const overflows = el.scrollHeight > maxHeight;
		el.style.height = `${overflows ? maxHeight : el.scrollHeight}px`;
		el.style.overflowY = overflows ? "auto" : "hidden";
	}, [ref, value, maxHeight, layoutKey]);
}
