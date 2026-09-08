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

const { fakeEditor } = vi.hoisted(() => ({
	fakeEditor: {
		commands: { setContent: vi.fn() },
		setEditable: vi.fn(),
		isEditable: true,
	},
}));
vi.mock("@tiptap/react", () => ({
	useEditor: () => fakeEditor,
	EditorContent: () => null,
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
