/**
 * Chat composers that use this hook grow with their text up to a cap and only
 * scroll past it, instead of keeping their default rows and scrolling a long
 * prompt inside a sliver of a text box.
 */

import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useAutoResizeTextarea } from "../use-auto-resize-textarea";

// jsdom does no layout, so scrollHeight is always 0. Model it the way a
// browser does once height is "auto": the larger of the text's line count and
// the textarea's rows (two when unset), so a layout change alters it too.
const LINE_HEIGHT = 24;
Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
	configurable: true,
	get(this: HTMLTextAreaElement) {
		const lines = this.value.split("\n").length;
		return (
			Math.max(lines, Number(this.getAttribute("rows") ?? 2)) *
			LINE_HEIGHT
		);
	},
});

const MAX_HEIGHT = 200;

function Composer({ value, rows }: { value: string; rows?: number }) {
	const ref = useRef<HTMLTextAreaElement>(null);
	useAutoResizeTextarea(ref, value, MAX_HEIGHT, rows);
	return <textarea ref={ref} value={value} rows={rows} readOnly />;
}

function renderComposer(value: string, rows?: number) {
	const { rerender } = render(<Composer value={value} rows={rows} />);
	return {
		textarea: screen.getByRole("textbox") as HTMLTextAreaElement,
		rerender: (next: string, nextRows = rows) =>
			rerender(<Composer value={next} rows={nextRows} />),
	};
}

const LONG_TEXT = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");

describe("useAutoResizeTextarea", () => {
	it("grows the textarea to fit its text without scrolling", () => {
		const { textarea } = renderComposer("one\ntwo\nthree\nfour");

		expect(textarea.style.height).toBe(`${4 * LINE_HEIGHT}px`);
		expect(textarea.style.overflowY).toBe("hidden");
	});

	it("caps the height and scrolls beyond it", () => {
		const { textarea } = renderComposer(LONG_TEXT);

		expect(textarea.style.height).toBe(`${MAX_HEIGHT}px`);
		expect(textarea.style.overflowY).toBe("auto");
	});

	it("grows as the text gets longer", () => {
		const { textarea, rerender } = renderComposer("one");
		rerender(LONG_TEXT);

		expect(textarea.style.height).toBe(`${MAX_HEIGHT}px`);
		expect(textarea.style.overflowY).toBe("auto");
	});

	it("shrinks back once the text is cleared after sending", () => {
		const { textarea, rerender } = renderComposer(LONG_TEXT);
		rerender("");

		expect(textarea.style.height).toBe(`${2 * LINE_HEIGHT}px`);
		expect(textarea.style.overflowY).toBe("hidden");
	});

	it("re-measures when only the layout key changes", () => {
		const { textarea, rerender } = renderComposer("", 1);
		expect(textarea.style.height).toBe(`${LINE_HEIGHT}px`);

		rerender("", 3);

		expect(textarea.style.height).toBe(`${3 * LINE_HEIGHT}px`);
	});
});
