/**
 * PlanningAnalysisEditor — the editor for a topic's Planning & Analysis prose
 * (Fizzy #1851, Task 9).
 *
 * The two guards under test are both load-bearing, both paid for by a past
 * incident:
 *
 *   1. `getEditorMarkdownForSave` returns `null` — not `""` — when Turndown
 *      serialization throws. Saving `null` would persist `body: null` and
 *      destroy the document, so the save must be refused.
 *   2. Raw (markdown) mode saves the textarea verbatim on Save — it must
 *      never run `repairMarkdownDocument`, which belongs only to the
 *      raw→rich view transition.
 *
 * The remaining tests pin the version bookkeeping the API depends on:
 * `expectedVersion` is the version this editor was seeded from (not
 * whatever the newest version happens to be by the time Save is clicked),
 * and Save is disabled entirely when there is no READY analysis to have been
 * seeded from at all.
 *
 * Heavy dependencies are mocked the way the sibling `DiffPreviewPanes.test.tsx`
 * mocks them: `@tiptap/react` (useEditor/EditorContent) and
 * `tiptap-extensions-advanced` are replaced with light stand-ins, since
 * mounting the real Mermaid/Excalidraw/lowlight extension set in jsdom is
 * neither needed nor reliable for a wiring test — this file is testing the
 * component's save/version logic, not TipTap's own rendering.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getEditorMarkdownForSaveMock } = vi.hoisted(() => ({
	getEditorMarkdownForSaveMock: vi.fn(),
}));
vi.mock("@saas/projects/lib/editor-markdown-save", () => ({
	getEditorMarkdownForSave: getEditorMarkdownForSaveMock,
}));

const { repairMarkdownDocumentMock, fromMarkdownMock } = vi.hoisted(() => ({
	repairMarkdownDocumentMock: vi.fn((text: string) => text),
	fromMarkdownMock: vi.fn((text: string) => `<p>${text}</p>`),
}));
vi.mock("@saas/projects/lib/diff-utils", () => ({
	repairMarkdownDocument: repairMarkdownDocumentMock,
	fromMarkdown: fromMarkdownMock,
}));

vi.mock("@saas/projects/lib/tiptap-extensions-advanced", () => ({
	advancedExtensions: [],
}));

// `on`/`off` complete the stub rather than loosen it: the editor region now
// docks `DocumentTocRail`, whose `useDocumentToc` subscribes to the editor's
// `update` event. A stand-in without them throws out of the effect and takes
// the whole tree down. Heading extraction itself finds no `state` here and
// falls into the hook's own catch, so the rail renders nothing — which is
// correct for this file: the ToC's own behaviour is pinned in
// `modules/saas/projects/components/__tests__/DocumentTocRail.test.tsx`, and
// what is under test here is save/version logic.
const { fakeEditor, capturedEditorOptionsRef } = vi.hoisted(() => ({
	fakeEditor: {
		commands: { setContent: vi.fn() },
		setEditable: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		isEditable: true,
	},
	capturedEditorOptionsRef: {
		current: null as {
			editorProps?: { attributes?: { class?: string } };
		} | null,
	},
}));
// `EditorContent` renders the div it is given a className on, because the
// height chain that keeps the contenteditable clickable runs THROUGH that
// element — a stand-in returning `null` would let the middle link of the
// chain be deleted with every test still green.
vi.mock("@tiptap/react", () => ({
	useEditor: (options: { editorProps?: unknown }) => {
		capturedEditorOptionsRef.current = options;
		return fakeEditor;
	},
	EditorContent: ({ className }: { className?: string }) => (
		<div className={className} />
	),
}));

// `EditorToolbar` is an existing, separately-tested component the brief
// forbids touching. Its own button-level behavior is out of scope here — it
// is stubbed so this file only exercises PlanningAnalysisEditor's own logic.
vi.mock("@saas/projects/components/EditorToolbar", () => ({
	EditorToolbar: () => <div data-testid="editor-toolbar-stub" />,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const { saveMutationMock, mutationState, capturedMutationOptionsRef } =
	vi.hoisted(() => ({
		saveMutationMock: vi.fn(),
		mutationState: { isPending: false },
		capturedMutationOptionsRef: {
			current: null as {
				onSuccess?: (result: unknown) => void;
				onError?: (error: unknown) => void;
			} | null,
		},
	}));

vi.mock("@tanstack/react-query", () => ({
	useMutation: (opts: {
		onSuccess?: (result: unknown) => void;
		onError?: (error: unknown) => void;
	}) => {
		capturedMutationOptionsRef.current = opts;
		return {
			mutate: (vars: unknown) => {
				saveMutationMock(vars);
			},
			isPending: mutationState.isPending,
		};
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			publishingSuite: {
				saveAnalysisRevision: {
					mutationOptions: (o: Record<string, unknown>) => ({
						mutationKey: ["saveAnalysisRevision"],
						...o,
					}),
				},
			},
		},
	},
}));

import { PlanningAnalysisEditor } from "@saas/projects/components/publishing-suite/PlanningAnalysisEditor";

const baseProps = {
	projectId: "proj-1",
	topicId: "topic-1",
	organizationId: null as string | null,
	prose: "Original prose.",
	revisionVersion: 1 as number | null,
	sourceAnalysisVersion: 2 as number | null,
	canEdit: true,
	onSaved: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	mutationState.isPending = false;
	capturedMutationOptionsRef.current = null;
	getEditorMarkdownForSaveMock.mockReturnValue("Edited prose.");
});

describe("PlanningAnalysisEditor — the null-serializer guard", () => {
	it("refuses to save when the serializer returns null and keeps the text on screen", async () => {
		getEditorMarkdownForSaveMock.mockReturnValue(null);
		render(<PlanningAnalysisEditor {...baseProps} />);

		await userEvent.click(screen.getByRole("button", { name: /save/i }));

		expect(saveMutationMock).not.toHaveBeenCalled();
		expect(screen.getByText(/copy/i)).toBeInTheDocument();
	});

	it("saves normally once the editor content can be read again", async () => {
		// Negative control for the test above: proves the disabled-looking
		// state there was caused by the null return, not by some other
		// reason Save can never fire (e.g. a stray `disabled` prop).
		getEditorMarkdownForSaveMock.mockReturnValue("Recovered prose.");
		render(<PlanningAnalysisEditor {...baseProps} />);

		await userEvent.click(screen.getByRole("button", { name: /save/i }));

		expect(saveMutationMock).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Recovered prose." }),
		);
	});
});

describe("PlanningAnalysisEditor — version bookkeeping", () => {
	it("sends the version it was seeded from, not the newest", async () => {
		render(
			<PlanningAnalysisEditor
				{...baseProps}
				revisionVersion={3}
				sourceAnalysisVersion={1}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: /save/i }));

		expect(saveMutationMock).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedVersion: 3,
				sourceAnalysisVersion: 1,
				body: "Edited prose.",
			}),
		);
	});

	it("saves the FIRST edit with expectedVersion null and the current AI version", async () => {
		render(
			<PlanningAnalysisEditor
				{...baseProps}
				revisionVersion={null}
				sourceAnalysisVersion={2}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: /save/i }));

		expect(saveMutationMock).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedVersion: null,
				sourceAnalysisVersion: 2,
				body: "Edited prose.",
			}),
		);
	});

	it("cannot save when there is no analysis to have been seeded from", () => {
		render(
			<PlanningAnalysisEditor
				{...baseProps}
				revisionVersion={null}
				sourceAnalysisVersion={null}
			/>,
		);

		expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
	});
});

describe("PlanningAnalysisEditor — raw mode never repairs on save", () => {
	it("does not repair markdown in raw mode", async () => {
		render(<PlanningAnalysisEditor {...baseProps} />);

		await userEvent.click(
			screen.getByRole("button", { name: /markdown/i }),
		);
		await userEvent.click(screen.getByRole("button", { name: /save/i }));

		expect(repairMarkdownDocumentMock).not.toHaveBeenCalled();
	});

	it("saves the raw textarea content verbatim, not a re-serialized rich value", async () => {
		// This is the assertion that would actually catch a regression where
		// Save ignores view mode and always reads the rich editor: the
		// serializer mock is primed with a value that must NOT appear in the
		// saved body once the user has hand-edited the raw textarea.
		getEditorMarkdownForSaveMock.mockReturnValue(
			"SHOULD NOT BE SAVED — this is the rich editor's serialization",
		);
		render(<PlanningAnalysisEditor {...baseProps} />);

		await userEvent.click(
			screen.getByRole("button", { name: /markdown/i }),
		);
		const textarea = screen.getByRole("textbox");
		await userEvent.clear(textarea);
		await userEvent.type(textarea, "Hand-edited markdown.");
		await userEvent.click(screen.getByRole("button", { name: /save/i }));

		expect(saveMutationMock).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Hand-edited markdown." }),
		);
	});
});

describe("PlanningAnalysisEditor — the editor region owns its height", () => {
	const region = (container: HTMLElement) =>
		container.querySelector<HTMLElement>(
			'[data-testid="planning-analysis-editor-region"]',
		);

	it("keeps the same height rule in both view modes", async () => {
		// The defect: one wrapper, two structurally different children. Rich
		// was an unbounded, content-driven `EditorContent`; raw a `Textarea`
		// with a 300px floor that does not grow. A short analysis grew on
		// toggle and a long one collapsed into an internal scroller.
		const { container } = render(<PlanningAnalysisEditor {...baseProps} />);

		const richClass = region(container)?.className;
		expect(richClass).toMatch(/\bh-\[clamp\(/);

		await userEvent.click(
			screen.getByRole("button", { name: /markdown/i }),
		);

		expect(region(container)?.className).toBe(richClass);
	});

	// The floor exists for two reasons and a viewer has neither: no rich/raw
	// toggle and no toolbar, so no jump to prevent — only a tall, mostly-empty
	// box for a problem they cannot trigger.
	it("drops the height floor for a read-only viewer", () => {
		const { container } = render(
			<PlanningAnalysisEditor {...baseProps} canEdit={false} />,
		);

		expect(region(container)?.className).not.toMatch(/\bh-\[clamp\(/);
	});

	// NEGATIVE CONTROL for the gate: proves the case above is the viewer's
	// doing, not a class that stopped being applied to anyone. Same assertion
	// the toggle-stability test makes, from the other side of `canEdit`.
	it("keeps the height floor for someone who can edit", () => {
		const { container } = render(<PlanningAnalysisEditor {...baseProps} />);

		expect(region(container)?.className).toMatch(/\bh-\[clamp\(/);
	});

	// The floor was also what gave `DocumentTocRail` a definite height to dock
	// against, so removing it must not cost a viewer their table of contents.
	// It does not: the rail is a stretch-aligned flex item and takes the row's
	// height, and it renders nothing at all when the document has no headings
	// — so the "rail with nothing to stick to" case cannot arise. With no
	// headings here, its polite live region is the proof it still mounted.
	it("still docks the table of contents for a viewer", () => {
		render(<PlanningAnalysisEditor {...baseProps} canEdit={false} />);

		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("keeps the toolbar inside that region, so losing it cannot move the box", () => {
		// The third contributor to the jump: the toolbar unmounts in raw mode.
		// While it sat ABOVE the box, its disappearance moved everything below
		// it. Inside, it only changes how a fixed height is divided.
		const { container } = render(<PlanningAnalysisEditor {...baseProps} />);

		expect(
			region(container)?.contains(
				screen.getByTestId("editor-toolbar-stub"),
			),
		).toBe(true);
	});

	it("docks the table of contents in rich mode and drops it in raw", async () => {
		// The rail is mounted for real here rather than stubbed: with no
		// headings it renders only its polite live region, and that is enough
		// to prove it mounted against this editor without throwing. Raw mode
		// must hide it — the Textarea has no heading DOM to navigate.
		render(<PlanningAnalysisEditor {...baseProps} />);

		expect(screen.getByRole("status")).toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("button", { name: /markdown/i }),
		);

		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("keeps the contenteditable as tall as the region it now sits in", () => {
		// Once the region stopped hugging its content, a short analysis left
		// most of the box as dead space: a click below the text landed on the
		// scroll container, not the editor, so no caret appeared. Measured in
		// a browser against this exact class chain — 82px of editable inside a
		// 488px box without it, the full 488px with it.
		//
		// All three links are asserted because the percentage only resolves
		// while every one of them holds: `min-h-full` on the ProseMirror
		// element needs a definite height on `EditorContent`, which needs one
		// on the measure wrapper, which takes it from the region. Dropping any
		// single link silently restores the dead zone.
		const { container } = render(<PlanningAnalysisEditor {...baseProps} />);

		expect(
			capturedEditorOptionsRef.current?.editorProps?.attributes?.class,
		).toMatch(/\bmin-h-full\b/);

		const measure = region(container)?.querySelector(".max-w-3xl");
		expect(measure?.className).toMatch(/\bh-full\b/);
		expect(measure?.firstElementChild?.className).toMatch(/\bh-full\b/);
	});

	it("caps the reading measure in both view modes", async () => {
		// Asserted on the class list because jsdom has no layout engine: there
		// is no width to measure, only the rule that produces one. The
		// analysis rendered full-bleed before this.
		const { container } = render(<PlanningAnalysisEditor {...baseProps} />);

		expect(region(container)?.querySelector(".max-w-3xl")).not.toBeNull();

		await userEvent.click(
			screen.getByRole("button", { name: /markdown/i }),
		);

		expect(screen.getByRole("textbox").parentElement?.className).toMatch(
			/\bmax-w-3xl\b/,
		);
	});
});

describe("PlanningAnalysisEditor — save failures are recoverable, not crashes", () => {
	it("surfaces a lost-race CONFLICT with a refresh-and-retry message", async () => {
		render(<PlanningAnalysisEditor {...baseProps} />);

		await userEvent.click(screen.getByRole("button", { name: /save/i }));
		expect(saveMutationMock).toHaveBeenCalled();

		await act(async () => {
			capturedMutationOptionsRef.current?.onError?.({ code: "CONFLICT" });
		});

		// Asserts the CONFLICT-specific wording, not just the word "refresh"
		// shared by every branch's message — a generic fallback that never
		// distinguished CONFLICT from any other error would still contain
		// "refresh" and wrongly pass a looser assertion here.
		await waitFor(() => {
			expect(
				screen.getByText(/changed while you were editing/i),
			).toBeInTheDocument();
		});
	});

	it("surfaces a stale sourceAnalysisVersion BAD_REQUEST with its own message, not the CONFLICT one", async () => {
		render(<PlanningAnalysisEditor {...baseProps} />);

		await userEvent.click(screen.getByRole("button", { name: /save/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onError?.({
				code: "BAD_REQUEST",
			});
		});

		await waitFor(() => {
			expect(
				screen.getByText(/no longer available/i),
			).toBeInTheDocument();
		});
		expect(
			screen.queryByText(/changed while you were editing/i),
		).not.toBeInTheDocument();
	});
});
