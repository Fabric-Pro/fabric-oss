/**
 * An image the AI changes is reviewed as a whole (Fizzy #2946): the old image
 * is one deletion and the new one an insertion. Images are inline nodes here,
 * on a line of their own or in a sentence, so the diff mark sits on the image
 * node and not on any text. The bar used to count only marked text: it did
 * not list such a change, and rejecting changes one by one kept the AI's
 * image.
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

/** The `src` of every image left in the document, in order. */
function imageSources(editor: Editor): string[] {
	const sources: string[] = [];
	editor.state.doc.descendants((node) => {
		if (node.type.name === "image") {
			sources.push(node.attrs.src);
		}
	});
	return sources;
}

const OLD_SRC = "https://example.com/old.png";
const NEW_SRC = "https://example.com/new.png";

const inProse = (image: string) =>
	`Intro.\n\nSee ${image} for details.\n\nOutro.`;
const onItsOwnLine = (image: string) => `Intro.\n\n${image}\n\nOutro.`;

const cases = [
	{
		name: "an image in a sentence",
		wrap: inProse,
		image: (src: string) => `![a diagram](${src})`,
	},
	{
		name: "an image on its own line",
		wrap: onItsOwnLine,
		image: (src: string) => `![a diagram](${src})`,
	},
	{
		name: "an image with a width",
		wrap: onItsOwnLine,
		image: (src: string) =>
			`<img src="${src}" alt="a diagram" width="50%" />`,
	},
	{
		name: "an image with a caption",
		wrap: onItsOwnLine,
		image: (src: string) =>
			`<img src="${src}" alt="a diagram" data-caption="The flow" />`,
	},
	{
		name: "a linked image",
		wrap: inProse,
		image: (src: string) => `[![a diagram](${src})](https://example.com/a)`,
	},
].map(({ name, wrap, image }) => ({
	name,
	baseline: wrap(image(OLD_SRC)),
	next: wrap(image(NEW_SRC)),
}));

function renderBar(editor: Editor) {
	render(
		<DiffReviewBar
			editor={editor}
			onAcceptAll={() => {}}
			onRejectAll={() => {}}
		/>,
	);
}

describe("DiffReviewBar — images the AI changed", () => {
	it.each(cases)(
		"$name: the bar lists the old and the new image",
		({ baseline, next }) => {
			// Arrange
			const editor = reviewEditor(baseline, next);

			// Act
			renderBar(editor);

			// Assert
			expect(screen.getByText(/2 changes/)).toBeInTheDocument();
			expect(screen.getByText(/\+1 added/)).toBeInTheDocument();
			expect(screen.getByText(/-1 removed/)).toBeInTheDocument();
		},
	);

	it.each(cases)(
		"$name: rejecting each change one by one saves the old image",
		({ baseline, next }) => {
			// Arrange
			const editor = reviewEditor(baseline, next);
			renderBar(editor);
			expect(screen.getByText(/2 changes/)).toBeInTheDocument();

			// Act
			fireEvent.click(
				screen.getByRole("button", { name: docEditor.reject }),
			);
			fireEvent.click(
				screen.getByRole("button", { name: docEditor.reject }),
			);

			// Assert
			expect(markedNodes(editor)).toBe(0);
			expect(imageSources(editor)).toEqual([OLD_SRC]);
			expect(getEditorMarkdownForSave(editor)).toBe(loadDirect(baseline));
		},
	);

	it.each(cases)(
		"$name: accepting each change one by one saves the new image",
		({ baseline, next }) => {
			// Arrange
			const editor = reviewEditor(baseline, next);
			renderBar(editor);
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
			expect(imageSources(editor)).toEqual([NEW_SRC]);
			expect(getEditorMarkdownForSave(editor)).toBe(loadDirect(next));
		},
	);
});
