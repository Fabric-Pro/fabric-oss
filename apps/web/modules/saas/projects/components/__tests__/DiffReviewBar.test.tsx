/**
 * Control-matrix tests for DiffReviewBar's `mode` prop.
 *
 * Inline (or no prop — backward-compatible) shows the per-change Accept/Reject
 * cluster + prev/next navigation. Side-by-side / Full preview hide those (the
 * live editor is behind read-only panes) but KEEP the change summary and bulk
 * Accept All / Reject All, and surface a muted "use Inline for per-change" hint.
 */
import en from "@repo/i18n/translations/en.json";
import type { Editor } from "@tiptap/react";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Radix Tooltip reaches for pointer-capture on mount; jsdom lacks it.
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
});

// Resolve accessible names / hint copy to the REAL shipped strings.
const docEditor = en.tooltips.documentEditor as Record<string, string>;
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => docEditor[key] ?? key,
}));
// The diff-outcome audit hook uses TanStack Query (needs a QueryClient); stub it
// at the module boundary since these tests exercise rendering, not the audit.
vi.mock("../../hooks/useDocumentAssistantHistory", () => ({
	useRecordDocumentAssistantDiffOutcome: () => ({ mutateAsync: vi.fn() }),
}));

import { DiffReviewBar } from "../DiffReviewBar";

// A fake editor whose doc carries one diffInsert + one diffDelete mark, so
// `findDiffRanges` yields ranges and the bar renders (it returns null when none).
function fakeDiffEditor(): Editor {
	return {
		state: {
			doc: {
				descendants: (cb: (node: unknown, pos: number) => void) => {
					cb(
						{
							isText: true,
							nodeSize: 5,
							marks: [{ type: { name: "diffInsert" } }],
						},
						0,
					);
					cb(
						{
							isText: true,
							nodeSize: 4,
							marks: [{ type: { name: "diffDelete" } }],
						},
						5,
					);
				},
			},
		},
		view: { dom: document.createElement("div") },
	} as unknown as Editor;
}

const noop = () => {};

describe("DiffReviewBar — review-mode control matrix", () => {
	it("inline mode shows per-change + nav + bulk and no inline hint", () => {
		render(
			<DiffReviewBar
				editor={fakeDiffEditor()}
				mode="inline"
				onAcceptAll={noop}
				onRejectAll={noop}
			/>,
		);
		expect(
			screen.getByRole("button", { name: docEditor.approve }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: docEditor.reject }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: docEditor.diffNext }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: docEditor.approveAll }),
		).toBeInTheDocument();
		expect(
			screen.queryByText(docEditor.diffPerChangeInInlineHint),
		).not.toBeInTheDocument();
	});

	it("side-by-side mode hides per-change + nav, keeps bulk, shows the hint", () => {
		render(
			<DiffReviewBar
				editor={fakeDiffEditor()}
				mode="sideBySide"
				onAcceptAll={noop}
				onRejectAll={noop}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: docEditor.approve }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: docEditor.reject }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: docEditor.diffNext }),
		).not.toBeInTheDocument();
		// Bulk controls + the inline hint remain.
		expect(
			screen.getByRole("button", { name: docEditor.approveAll }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: docEditor.rejectAll }),
		).toBeInTheDocument();
		expect(
			screen.getByText(docEditor.diffPerChangeInInlineHint),
		).toBeInTheDocument();
	});

	it("defaults to inline behavior when mode is omitted (backward-compatible)", () => {
		render(
			<DiffReviewBar
				editor={fakeDiffEditor()}
				onAcceptAll={noop}
				onRejectAll={noop}
			/>,
		);
		expect(
			screen.getByRole("button", { name: docEditor.approve }),
		).toBeInTheDocument();
		expect(
			screen.queryByText(docEditor.diffPerChangeInInlineHint),
		).not.toBeInTheDocument();
	});
});
