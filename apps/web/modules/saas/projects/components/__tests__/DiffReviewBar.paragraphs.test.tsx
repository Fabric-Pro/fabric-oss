/**
 * A paragraph the AI added whole is one change: rejecting it in the bar
 * takes the paragraph out with its text, as accepting the deletion of a
 * whole paragraph does (Fizzy #2946). Deleting only the
 * text left an empty paragraph in the editor, and in a collaborative room
 * in everyone's copy of the document, though the saved Markdown hid it.
 */
import en from "@repo/i18n/translations/en.json";
import { fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { diffPartialText, fromMarkdown } from "../../lib/diff-utils";
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

function editorWith(html: string): Editor {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: advancedExtensions,
		content: html,
	});
	editors.push(editor);
	return editor;
}

const BASELINE = "## Scope\n\nPhase one, then two.\n\nClosing line.";
const PROPOSED =
	"## Scope\n\nPhase one, then two.\n\nA paragraph the assistant proposes.\n\nClosing line.";

describe("DiffReviewBar — a paragraph the AI added", () => {
	it("Reject takes the paragraph out with its text, leaving the body as it was", () => {
		// Arrange
		const before = editorWith(fromMarkdown(BASELINE)).getJSON();
		const editor = editorWith(
			fromMarkdown(diffPartialText(BASELINE, PROPOSED, true)),
		);
		render(
			<DiffReviewBar
				editor={editor}
				onAcceptAll={() => {}}
				onRejectAll={() => {}}
			/>,
		);
		expect(screen.getByText(/1 change/)).toBeInTheDocument();
		const paragraphs = () =>
			Array.from(editor.view.dom.querySelectorAll("p")).map(
				(paragraph) => paragraph.textContent,
			);
		expect(paragraphs()).toContain("A paragraph the assistant proposes.");

		// Act
		fireEvent.click(screen.getByRole("button", { name: docEditor.reject }));

		// Assert
		expect(paragraphs()).toEqual(["Phase one, then two.", "Closing line."]);
		expect(editor.getJSON()).toEqual(before);
	});

	it("Accept on a paragraph the AI deleted takes the paragraph out, leaving the body it proposed", () => {
		// Arrange: a paragraph right below the heading, which the diff marks
		// as a paragraph of its own.
		const before = "## Scope\n\nA paragraph to drop.\n\nClosing line.";
		const proposed = "## Scope\n\nClosing line.";
		const after = editorWith(fromMarkdown(proposed)).getJSON();
		const editor = editorWith(
			fromMarkdown(diffPartialText(before, proposed, true)),
		);
		render(
			<DiffReviewBar
				editor={editor}
				onAcceptAll={() => {}}
				onRejectAll={() => {}}
			/>,
		);
		expect(screen.getByText(/1 change/)).toBeInTheDocument();

		// Act
		fireEvent.click(
			screen.getByRole("button", { name: docEditor.approve }),
		);

		// Assert
		expect(editor.getJSON()).toEqual(after);
	});
});
