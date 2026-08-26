/**
 * Component tests for DiffPreviewPanes — the read-only Side-by-side / Full
 * preview renderings of a derived document diff.
 *
 * The panes render through read-only Tiptap editors (same `advancedExtensions`
 * as the live editor) so NodeView content — Mermaid/Excalidraw diagrams,
 * images, code — renders faithfully (verified live on staging + mirrors the
 * shipped VersionDiffViewer). Here we mock `@tiptap/react` so we exercise the
 * component CONTRACT in jsdom without mounting the heavy real editor:
 *  1. mode="sideBySide" → two labeled regions ("Original" left/before,
 *     "Proposed" right/after), each fed its derived HTML as read-only content.
 *  2. mode="fullPreview" → a single "Proposed" pane fed the clean proposed HTML.
 *  3. Read-only: editors are `editable: false`; no buttons / inputs / writable
 *     contenteditable inside any pane.
 *  4. Rendering fidelity: each pane content sits inside a `prose` container
 *     under a `streaming-diff-active` ancestor, so the editor's diff CSS applies.
 */

import en from "@repo/i18n/translations/en.json";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DerivedDiffViews } from "../../lib/diff-view-modes";

// Mock the heavy editor lib: capture each pane's config (content + editable)
// and render a light stand-in carrying the `tiptap` class the component relies
// on. (Mounting advancedExtensions — Mermaid/Excalidraw/lowlight — in jsdom is
// neither needed nor reliable for a wiring test.)
vi.mock("@tiptap/react", () => ({
	useEditor: (config: { content?: string; editable?: boolean }) => ({
		__content: config?.content ?? "",
		__editable: config?.editable,
	}),
	EditorContent: ({
		editor,
	}: {
		editor: { __content: string; __editable?: boolean };
	}) => (
		<div
			className="tiptap"
			data-testid="pane-content"
			data-content={editor?.__content ?? ""}
			data-editable={String(editor?.__editable)}
		/>
	),
}));
// Replace the extensions module so its heavy NodeView imports don't execute.
vi.mock("../../lib/tiptap-extensions-advanced", () => ({
	advancedExtensions: [],
}));
// Resolve pane labels to the real shipped strings.
const docEditor = en.tooltips.documentEditor as Record<string, string>;
vi.mock("next-intl", () => ({
	useTranslations: (_namespace?: string) => (key: string) =>
		docEditor[key] ?? key,
}));

import { DiffPreviewPanes } from "../DiffPreviewPanes";

const ORIGINAL = docEditor.diffPaneOriginal;
const PROPOSED = docEditor.diffPaneProposed;

const derived: DerivedDiffViews = {
	originalHtml:
		'<p>Shared intro.</p><p><del class="diff-del">old removed line</del></p>',
	proposedHtml:
		'<p>Shared intro.</p><p><ins class="diff-ins">brand new line</ins></p>',
	cleanProposedHtml: "<p>Shared intro.</p><p>brand new line</p>",
};

function paneContent(region: HTMLElement): HTMLElement {
	const el = within(region).getByTestId("pane-content");
	return el;
}

describe("DiffPreviewPanes", () => {
	describe("sideBySide", () => {
		it("renders two labeled regions, each fed its derived HTML as read-only content", () => {
			render(<DiffPreviewPanes mode="sideBySide" derived={derived} />);

			const original = screen.getByRole("region", { name: ORIGINAL });
			const proposed = screen.getByRole("region", { name: PROPOSED });

			// Left pane gets the original (deletion kept); right gets the proposed
			// (addition kept). This is the load-bearing wiring contract.
			expect(paneContent(original)).toHaveAttribute(
				"data-content",
				derived.originalHtml,
			);
			expect(paneContent(proposed)).toHaveAttribute(
				"data-content",
				derived.proposedHtml,
			);
			// Both editors are read-only.
			expect(paneContent(original)).toHaveAttribute(
				"data-editable",
				"false",
			);
			expect(paneContent(proposed)).toHaveAttribute(
				"data-editable",
				"false",
			);
		});

		it("orders Original before Proposed (left/before, right/after)", () => {
			render(<DiffPreviewPanes mode="sideBySide" derived={derived} />);
			const names = screen
				.getAllByRole("region")
				.map((r) => r.getAttribute("aria-label"));
			expect(names).toEqual([ORIGINAL, PROPOSED]);
		});

		it("each pane content sits in a prose container under a streaming-diff-active ancestor", () => {
			const { container } = render(
				<DiffPreviewPanes mode="sideBySide" derived={derived} />,
			);
			assertProseAncestry(container, 2);
		});

		it("is read-only (no buttons, inputs, or writable contenteditable)", () => {
			const { container } = render(
				<DiffPreviewPanes mode="sideBySide" derived={derived} />,
			);
			assertReadOnly(container);
		});
	});

	describe("fullPreview", () => {
		it("renders a single Proposed pane fed the clean proposed HTML", () => {
			render(<DiffPreviewPanes mode="fullPreview" derived={derived} />);
			const regions = screen.getAllByRole("region");
			expect(regions).toHaveLength(1);
			expect(paneContent(regions[0])).toHaveAttribute(
				"data-content",
				derived.cleanProposedHtml,
			);
			expect(paneContent(regions[0])).toHaveAttribute(
				"data-editable",
				"false",
			);
		});

		it("pane content sits in a prose container under a streaming-diff-active ancestor", () => {
			const { container } = render(
				<DiffPreviewPanes mode="fullPreview" derived={derived} />,
			);
			assertProseAncestry(container, 1);
		});

		it("is read-only (no buttons, inputs, or writable contenteditable)", () => {
			const { container } = render(
				<DiffPreviewPanes mode="fullPreview" derived={derived} />,
			);
			assertReadOnly(container);
		});
	});
});

// ── Shared assertions ──────────────────────────────────────────────────────

function assertProseAncestry(container: HTMLElement, expectedCount: number) {
	const contentNodes = container.querySelectorAll(
		'[data-testid="pane-content"]',
	);
	expect(contentNodes).toHaveLength(expectedCount);
	for (const node of Array.from(contentNodes)) {
		// Editor-parity prose wrapper so the preview matches the editor visually.
		const prose = node.closest(".prose");
		expect(prose).not.toBeNull();
		expect(prose).toHaveClass("prose-sm");
		expect(prose).toHaveClass("max-w-none");
		expect(prose).toHaveClass("dark:prose-invert");
		// Sits under a `streaming-diff-active` ancestor so the diff CSS applies.
		expect(node.closest(".streaming-diff-active")).not.toBeNull();
	}
}

function assertReadOnly(container: HTMLElement) {
	expect(container.querySelector("[contenteditable='true']")).toBeNull();
	expect(container.querySelector("button")).toBeNull();
	expect(container.querySelector("input")).toBeNull();
	expect(container.querySelector("textarea")).toBeNull();
}
