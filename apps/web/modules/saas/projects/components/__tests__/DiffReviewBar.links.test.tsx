/**
 * A link the AI edits is reviewed as a whole (Fizzy #2946): the old link is
 * one deletion and the new one an insertion, so rejecting each change in the
 * bar keeps the old link. A word diff used to put the markers inside the
 * link's `(…)`, where they became part of the href: the bar then had no
 * change to reject, and the save kept the AI's version.
 *
 * A hard break inside the link text is a node of its own carrying the same
 * mark as the text around it. The bar used to see only the text, so it split
 * such a link into several changes and left the marked breaks behind.
 */
import en from "@repo/i18n/translations/en.json";
import { fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { diffPartialText, fromMarkdown } from "../../lib/diff-utils";
import { getEditorMarkdownForSave } from "../../lib/editor-markdown-save";
import { advancedExtensions } from "../../lib/tiptap-extensions-advanced";

beforeAll(() => {
	if (typeof Element.prototype.hasPointerCapture !== "function") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.setPointerCapture !== "function") {
		Element.prototype.setPointerCapture = () => undefined;
	}
	if (typeof Element.prototype.releasePointerCapture !== "function") {
		Element.prototype.releasePointerCapture = () => undefined;
	}
	if (typeof Element.prototype.scrollIntoView !== "function") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

const docEditor = en.tooltips.documentEditor as Record<string, string>;
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => docEditor[key] ?? key,
}));
vi.mock("../../hooks/useDocumentAssistantHistory", () => ({
	useRecordDocumentAssistantDiffOutcome: () => ({ mutateAsync: vi.fn() }),
}));

import { DiffReviewBar } from "../DiffReviewBar";

const editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors.splice(0)) {
		editor.destroy();
	}
});

function reviewEditor(baseline: string, next: string): Editor {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: advancedExtensions,
		content: fromMarkdown(diffPartialText(baseline, next, true), {
			repairLegacyBullets: false,
		}),
	});
	editors.push(editor);
	return editor;
}

function loadDirect(markdown: string): string {
	const editor = new Editor({
		extensions: advancedExtensions,
		content: fromMarkdown(markdown, { repairLegacyBullets: false }),
	});
	editors.push(editor);
	return getEditorMarkdownForSave(editor) ?? "";
}

/** How many nodes still carry a diff mark: none once every change is answered. */
function markedNodes(editor: Editor): number {
	let count = 0;
	editor.state.doc.descendants((node) => {
		if (
			node.marks.some(
				(mark) =>
					mark.type.name === "diffInsert" ||
					mark.type.name === "diffDelete",
			)
		) {
			count++;
		}
	});
	return count;
}

const inProse = (link: string) =>
	`Intro.\n\nSee ${link} for details.\n\nOutro.`;

const HARD_BREAK_LINK = {
	name: "a URL change to a link holding a hard break",
	baseline: inProse("[first line  \nsecond line](https://example.com/a)"),
	next: inProse("[first line  \nsecond line](https://example.com/b)"),
	keeps: "See [first line  \nsecond line](https://example.com/a) for details.",
	takes: "See [first line  \nsecond line](https://example.com/b) for details.",
};

describe("DiffReviewBar — links the AI changed", () => {
	it.each([
		{
			name: "a URL-only change",
			baseline: inProse("[the docs](https://example.com/old)"),
			next: inProse("[the docs](https://example.com/new)"),
			keeps: "See [the docs](https://example.com/old) for details.",
		},
		{
			name: "an unlink",
			baseline: inProse("[the docs](https://example.com/a)"),
			next: inProse("the docs"),
			keeps: "See [the docs](https://example.com/a) for details.",
		},
		{
			name: "a title change",
			baseline: inProse('[the docs](https://example.com/a "Old")'),
			next: inProse('[the docs](https://example.com/a "New")'),
			keeps: 'See [the docs](https://example.com/a "Old") for details.',
		},
		HARD_BREAK_LINK,
	])(
		"$name: rejecting each change one by one saves the old link",
		({ baseline, next, keeps }) => {
			// Arrange
			const editor = reviewEditor(baseline, next);
			render(
				<DiffReviewBar
					editor={editor}
					onAcceptAll={() => {}}
					onRejectAll={() => {}}
				/>,
			);
			expect(screen.getByText(/2 changes/)).toBeInTheDocument();

			// Act
			fireEvent.click(
				screen.getByRole("button", { name: docEditor.reject }),
			);
			fireEvent.click(
				screen.getByRole("button", { name: docEditor.reject }),
			);

			// Assert
			expect(
				editor.view.dom.querySelector("ins.diff-ins, del.diff-del"),
			).toBeNull();
			expect(markedNodes(editor)).toBe(0);
			const saved = getEditorMarkdownForSave(editor);
			expect(saved).toBe(loadDirect(baseline));
			expect(saved).toContain(keeps);
		},
	);

	it("a URL change to a link holding a hard break: accepting each change one by one saves the new link", () => {
		// Arrange
		const { baseline, next, takes } = HARD_BREAK_LINK;
		const editor = reviewEditor(baseline, next);
		render(
			<DiffReviewBar
				editor={editor}
				onAcceptAll={() => {}}
				onRejectAll={() => {}}
			/>,
		);
		expect(screen.getByText(/2 changes/)).toBeInTheDocument();

		// Act
		fireEvent.click(
			screen.getByRole("button", { name: docEditor.approve }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: docEditor.approve }),
		);

		// Assert
		expect(markedNodes(editor)).toBe(0);
		const saved = getEditorMarkdownForSave(editor);
		expect(saved).toBe(loadDirect(next));
		expect(saved).toContain(takes);
	});
});
