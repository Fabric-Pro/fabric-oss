/**
 * The refinement review surface shared by all seven Publishing Suite panels.
 *
 * What it owes its callers is narrow and all of it is load-bearing:
 *
 *   1. The diff it shows is the SAVED draft against the refined one, compared
 *      as two complete documents. The streaming comparison truncates the
 *      baseline to the proposal's length and skips markdown normalization, so
 *      passing it here would both hide changes and invent them.
 *   2. Confirming hands back what the editor holds AT THE MOMENT OF THE PRESS,
 *      because every per-change accept and reject has mutated that document in
 *      place since it was seeded.
 *   3. A failed serialization arrives as `null`, never `""` — Fizzy #1987: a
 *      caller that wrote `""` as a body would destroy the draft it was trying
 *      to save.
 *   4. Rejecting hands back nothing at all.
 *
 * `@tiptap/react` and the advanced extension set are stubbed the way the
 * sibling `planning-analysis-editor.test.tsx` stubs them — mounting the real
 * Mermaid/Excalidraw/lowlight stack in jsdom is neither needed nor reliable for
 * a wiring test. `diff-utils` is deliberately NOT stubbed: the markers it emits
 * and the `<ins>` / `<del>` they become are the whole mechanism, and a stub
 * there would leave the pipeline untested. `DiffReviewBar` is real too, driven
 * by a fake editor document in the shape its own suite uses, so "Accept All"
 * really is the bar's own button.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useRecordDocumentAssistantDiffOutcome: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@saas/projects/lib/tiptap-extensions-advanced", () => ({
	advancedExtensions: [],
}));

const { getEditorMarkdownForSaveMock } = vi.hoisted(() => ({
	getEditorMarkdownForSaveMock: vi.fn(),
}));
vi.mock("@saas/projects/lib/editor-markdown-save", () => ({
	getEditorMarkdownForSave: getEditorMarkdownForSaveMock,
}));

/**
 * A document holding one insertion and one deletion.
 *
 * `DiffReviewBar` scans marks rather than HTML, so this is what makes it report
 * "2 changes" and render its bulk actions — the same fake shape its own suite
 * uses.
 */
const { capturedEditorOptions, fakeEditor } = vi.hoisted(() => {
	const insertNode = {
		isText: true,
		nodeSize: 5,
		marks: [{ type: { name: "diffInsert" } }],
	};
	const deleteNode = {
		isText: true,
		nodeSize: 4,
		marks: [{ type: { name: "diffDelete" } }],
	};
	return {
		capturedEditorOptions: {
			current: null as { content?: string } | null,
		},
		fakeEditor: {
			state: {
				doc: {
					descendants: (cb: (node: unknown, pos: number) => void) => {
						cb(insertNode, 0);
						cb(deleteNode, 10);
					},
				},
			},
			view: { dom: document.createElement("div") },
			getHTML: () => "<p>diffed</p>",
			setEditable: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		},
	};
});

vi.mock("@tiptap/react", () => ({
	useEditor: (options: { content?: string }) => {
		capturedEditorOptions.current = options;
		return fakeEditor;
	},
	EditorContent: ({ className }: { className?: string }) => (
		<div className={className} data-testid="editor-content" />
	),
}));

import { readCandidateRefinement } from "@saas/projects/components/publishing-suite/DraftComparison";
import { RefinedDraftReview } from "@saas/projects/components/publishing-suite/RefinedDraftReview";

const baseProps = {
	draftId: "draft-1",
	baseline: "Builds used to start cold every morning.",
	proposed: "Builds used to start warm every morning.",
	version: 2,
	instruction: "Make it shorter.",
	label: "blog post",
	onConfirm: vi.fn(),
	onReject: vi.fn(),
	isSaving: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	capturedEditorOptions.current = null;
	getEditorMarkdownForSaveMock.mockReturnValue("Builds used to start warm.");
});

describe("RefinedDraftReview — what reaches the editor", () => {
	it("seeds the editor with the saved draft marked up against the refined one", () => {
		render(<RefinedDraftReview {...baseProps} />);

		const content = capturedEditorOptions.current?.content ?? "";
		// The whole mechanism in one assertion: `diffPartialText` emitted
		// markers, `fromMarkdown` turned them into the tags the editor schema
		// binds as diffInsert / diffDelete marks.
		expect(content).toContain("<ins");
		expect(content).toContain("<del");
		expect(content).toContain("warm");
		expect(content).toContain("cold");
	});

	it("compares the two documents whole rather than as a stream", () => {
		// The streaming branch truncates the baseline to the proposal's length.
		// A refinement that shortens a draft would then silently lose the tail
		// of the original — the deletion nobody sees.
		render(
			<RefinedDraftReview
				{...baseProps}
				baseline="One. Two. Three. Four. Five."
				proposed="One."
			/>,
		);

		const content = capturedEditorOptions.current?.content ?? "";
		expect(content).toContain("Five");
	});

	it("carries the class every diff rule is scoped under", () => {
		// Without it the marks are in the document and render as unstyled
		// <ins>/<del> — a review nobody can see.
		const { container } = render(<RefinedDraftReview {...baseProps} />);

		expect(
			container.querySelector(".streaming-diff-active"),
		).toBeInTheDocument();
	});

	it("names what the author asked for, when the run recorded it", () => {
		render(<RefinedDraftReview {...baseProps} />);

		expect(screen.getByText(/Make it shorter/)).toBeInTheDocument();
	});
});

describe("RefinedDraftReview — confirming and rejecting", () => {
	it("hands back the merged document when the review is saved", async () => {
		const onConfirm = vi.fn();
		render(<RefinedDraftReview {...baseProps} onConfirm={onConfirm} />);

		await userEvent.click(
			screen.getByRole("button", {
				name: /save as the working blog post/i,
			}),
		);

		expect(onConfirm).toHaveBeenCalledWith("Builds used to start warm.");
	});

	it("hands back null — never an empty string — when serialization fails", async () => {
		// Fizzy #1987. The caller refuses to write on `null`; an `""` here
		// would be written as the body and destroy the draft.
		getEditorMarkdownForSaveMock.mockReturnValue(null);
		const onConfirm = vi.fn();
		render(<RefinedDraftReview {...baseProps} onConfirm={onConfirm} />);

		await userEvent.click(
			screen.getByRole("button", {
				name: /save as the working blog post/i,
			}),
		);

		expect(onConfirm).toHaveBeenCalledWith(null);
	});

	it("discards without reading the editor at all", async () => {
		const onConfirm = vi.fn();
		const onReject = vi.fn();
		render(
			<RefinedDraftReview
				{...baseProps}
				onConfirm={onConfirm}
				onReject={onReject}
			/>,
		);

		await userEvent.click(
			screen.getByRole("button", { name: /discard refinement/i }),
		);

		expect(onReject).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("routes the review bar's own bulk actions to the same two decisions", async () => {
		const onConfirm = vi.fn();
		const onReject = vi.fn();
		render(
			<RefinedDraftReview
				{...baseProps}
				onConfirm={onConfirm}
				onReject={onReject}
			/>,
		);

		// The bar found the marks in the document it was handed.
		expect(screen.getByText("2 changes")).toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("button", { name: "approveAll" }),
		);
		expect(onConfirm).toHaveBeenCalledWith("Builds used to start warm.");

		await userEvent.click(
			screen.getByRole("button", { name: "rejectAll" }),
		);
		expect(onReject).toHaveBeenCalledTimes(1);
	});

	it("closes the keyboard while the save it started is in flight", () => {
		render(<RefinedDraftReview {...baseProps} isSaving />);

		expect(fakeEditor.setEditable).toHaveBeenCalledWith(false);
		expect(
			screen.getByRole("button", {
				name: /save as the working blog post/i,
			}),
		).toBeDisabled();
	});
});

describe("readCandidateRefinement — telling a refinement from a regeneration", () => {
	it("recognises a refined candidate and carries its instruction", () => {
		expect(
			readCandidateRefinement({
				title: "A post",
				generation: {
					refinedFromWorkingDraft: true,
					guidance: "  Make it shorter.  ",
				},
			}),
		).toEqual({ instruction: "Make it shorter." });
	});

	it("reads an ordinary regeneration as not a refinement", () => {
		expect(
			readCandidateRefinement({
				title: "A post",
				generation: {
					refinedFromWorkingDraft: false,
					guidance: "Technical audience.",
				},
			}),
		).toBeNull();
	});

	it("reads a row written before the field existed as not a refinement", () => {
		// The right way to be wrong: a candidate shown plainly is exactly what
		// shipped before this review existed.
		expect(readCandidateRefinement({ title: "A post" })).toBeNull();
		expect(readCandidateRefinement(null)).toBeNull();
		expect(readCandidateRefinement("not an object")).toBeNull();
		expect(
			readCandidateRefinement({ generation: "not an object" }),
		).toBeNull();
	});

	it("reports no instruction when the run recorded none", () => {
		expect(
			readCandidateRefinement({
				generation: { refinedFromWorkingDraft: true, guidance: null },
			}),
		).toEqual({ instruction: null });
		expect(
			readCandidateRefinement({
				generation: { refinedFromWorkingDraft: true, guidance: "   " },
			}),
		).toEqual({ instruction: null });
	});
});
