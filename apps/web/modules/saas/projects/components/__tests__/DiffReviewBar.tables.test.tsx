/**
 * A table the AI edits is reviewed as a whole: the old table carries
 * `diff: "deleted"` and the new one `diff: "added"`. Both must be visibly
 * marked in the live editor and count as changes the reviewer can step
 * through and accept or reject one at a time.
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

const TABLE =
	"| Field | Type | Notes |\n| --- | --- | --- |\n| id | string | primary key |\n| name | string | display name |";
const BASELINE = `Intro.\n\n${TABLE}\n\nOutro.`;
const NEXT = `Intro.\n\n${TABLE.replace("display name", "human readable name")}\n\nOutro.`;

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

describe("DiffReviewBar — tables the AI replaced", () => {
	it("marks the new and the old table in the live editor", () => {
		// Arrange
		const editor = reviewEditor(BASELINE, NEXT);

		// Act
		const marked = Array.from(
			editor.view.dom.querySelectorAll("table[data-diff]"),
			(table) => [
				table.getAttribute("data-diff"),
				table.textContent?.includes("human readable name"),
			],
		);

		// Assert
		expect(marked).toEqual([
			["added", true],
			["deleted", false],
		]);
	});

	it("counts each table as a change", () => {
		// Arrange
		const editor = reviewEditor(BASELINE, NEXT);

		// Act
		render(
			<DiffReviewBar
				editor={editor}
				onAcceptAll={() => {}}
				onRejectAll={() => {}}
			/>,
		);

		// Assert
		expect(screen.getByText(/2 changes/)).toBeInTheDocument();
	});

	it("accepting both table changes one by one saves the AI's table", () => {
		// Arrange
		const editor = reviewEditor(BASELINE, NEXT);
		render(
			<DiffReviewBar
				editor={editor}
				onAcceptAll={() => {}}
				onRejectAll={() => {}}
			/>,
		);

		// Act
		fireEvent.click(
			screen.getByRole("button", { name: docEditor.approve }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: docEditor.approve }),
		);

		// Assert
		expect(editor.view.dom.querySelectorAll("table")).toHaveLength(1);
		expect(editor.view.dom.querySelector("table[data-diff]")).toBeNull();
		expect(getEditorMarkdownForSave(editor)).toBe(loadDirect(NEXT));
	});

	it("rejecting both table changes one by one keeps the original table", () => {
		// Arrange
		const editor = reviewEditor(BASELINE, NEXT);
		render(
			<DiffReviewBar
				editor={editor}
				onAcceptAll={() => {}}
				onRejectAll={() => {}}
			/>,
		);

		// Act
		fireEvent.click(screen.getByRole("button", { name: docEditor.reject }));
		fireEvent.click(screen.getByRole("button", { name: docEditor.reject }));

		// Assert
		expect(editor.view.dom.querySelectorAll("table")).toHaveLength(1);
		expect(getEditorMarkdownForSave(editor)).toBe(loadDirect(BASELINE));
	});
});
