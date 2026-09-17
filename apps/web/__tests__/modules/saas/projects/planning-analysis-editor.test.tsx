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
		/**
		 * A REAL element, because the change-digest's section matcher reads
		 * `editor.view.dom` and queries headings out of it. Tests populate it
		 * with the heading markup the diff actually produces.
		 */
		view: { dom: document.createElement("div") },
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
// The change-digest card is a shared component and translates its chrome.
// Keys through, because what is under test is which bullet was clicked, not
// how the heading above them reads.
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

// `DiffReviewBar` is separately tested and drags the whole document-assistant
// history stack in with it (its outcome-recording hook reads an org-scoped
// feature flag). Stubbed so this file exercises the digest card that sits
// ABOVE it, not the bar.
vi.mock("@saas/projects/components/DiffReviewBar", () => ({
	DiffReviewBar: () => <div data-testid="diff-review-bar-stub" />,
}));

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

		const measure = region(container)?.querySelector(
			'[data-testid="planning-analysis-prose-measure"]',
		);
		expect(measure?.className).toMatch(/\bh-full\b/);
		expect(measure?.firstElementChild?.className).toMatch(/\bh-full\b/);
	});

	it("gives the prose the region's full width, in both view modes", async () => {
		// Asserted on the class list because jsdom has no layout engine: there
		// is no width to measure, only the rule that produces one.
		//
		// This used to assert a `max-w-3xl` reading measure. The cap was
		// dropped deliberately, for parity with the Full Specification editor,
		// which caps nothing — the contents rail on one side and the assistant
		// rail on the other are what bound this column now. Asserting the
		// ABSENCE of a cap is what stops one drifting back in on either mode,
		// which is the failure this test now exists to catch.
		const { container } = render(<PlanningAnalysisEditor {...baseProps} />);

		const rich = region(container)?.querySelector(
			'[data-testid="planning-analysis-prose-measure"]',
		);
		expect(rich).not.toBeNull();
		expect(rich?.className).toMatch(/\bw-full\b/);
		expect(rich?.className).not.toMatch(/\bmax-w-(?!none\b)\S+/);

		await userEvent.click(
			screen.getByRole("button", { name: /markdown/i }),
		);

		const raw = screen.getByRole("textbox").parentElement;
		expect(raw?.className).toMatch(/\bw-full\b/);
		expect(raw?.className).not.toMatch(/\bmax-w-(?!none\b)\S+/);
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

describe("PlanningAnalysisEditor — locked while a run is in flight", () => {
	it("pauses the keyboard and Save, and says why", () => {
		// Feature Maturation locks its editor on `isAiLoading`, and that is WHY
		// it can replace a refreshed spec outright: nothing can have been typed
		// into the document being superseded. Publishing left the editor live,
		// so a regeneration could land on words a person was still writing.
		render(<PlanningAnalysisEditor {...baseProps} isLocked />);

		expect(
			screen.getByTestId("planning-analysis-locked"),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
		expect(fakeEditor.setEditable).toHaveBeenLastCalledWith(false);
	});

	it("is a separate concern from permission, so an editor keeps the rest", () => {
		// `canEdit` also drives the toolbar, the raw/rich toggle and the editor
		// region's height clamp. Folding the lock into it would drop the clamp
		// mid-run and make the page jump under the reader.
		const { rerender } = render(
			<PlanningAnalysisEditor {...baseProps} isLocked />,
		);
		rerender(<PlanningAnalysisEditor {...baseProps} isLocked={false} />);

		expect(
			screen.queryByTestId("planning-analysis-locked"),
		).not.toBeInTheDocument();
		expect(fakeEditor.setEditable).toHaveBeenLastCalledWith(true);
	});
});

/**
 * The surface that must NOT autosave is the surface most able to lose work.
 *
 * Accepting the assistant's rewrite re-seeds this editor and saves nothing —
 * deliberately, because Fizzy #1929's worst defect was an autosave racing an
 * in-flight agent. That decision is only safe if the editor says the work has
 * not reached the server yet, which it did not.
 */
describe("PlanningAnalysisEditor — unsaved work is visible", () => {
	it("marks the editor dirty once its content differs from what was loaded", () => {
		getEditorMarkdownForSaveMock.mockReturnValue("Edited prose.");
		render(<PlanningAnalysisEditor {...baseProps} />);

		expect(
			screen.getByTestId("planning-analysis-unsaved"),
		).toBeInTheDocument();
	});

	it("says nothing while the editor still matches what was loaded", () => {
		// The negative control: proves the marker above tracks the content and
		// is not simply always rendered.
		getEditorMarkdownForSaveMock.mockReturnValue(baseProps.prose);
		render(<PlanningAnalysisEditor {...baseProps} />);

		expect(
			screen.queryByTestId("planning-analysis-unsaved"),
		).not.toBeInTheDocument();
	});

	it("clears the marker once the server confirms that exact body", async () => {
		getEditorMarkdownForSaveMock.mockReturnValue("Edited prose.");
		render(<PlanningAnalysisEditor {...baseProps} />);

		await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({
				saved: true,
				version: 2,
			});
		});

		expect(
			screen.queryByTestId("planning-analysis-unsaved"),
		).not.toBeInTheDocument();
	});

	it("stays dirty when the author kept typing through an in-flight save", async () => {
		// The reason the flag is DERIVED rather than a boolean cleared on any
		// resolved save: the editor stays editable during one, so "a save
		// completed" and "the editor matches the server" are different facts.
		getEditorMarkdownForSaveMock.mockReturnValue("First edit.");
		render(<PlanningAnalysisEditor {...baseProps} />);

		await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
		getEditorMarkdownForSaveMock.mockReturnValue(
			"Second edit, mid-flight.",
		);
		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({
				saved: true,
				version: 2,
			});
		});

		expect(
			screen.getByTestId("planning-analysis-unsaved"),
		).toBeInTheDocument();
	});

	it("warns before a tab close that would discard the edit", () => {
		getEditorMarkdownForSaveMock.mockReturnValue("Edited prose.");
		render(<PlanningAnalysisEditor {...baseProps} />);

		const event = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
	});

	it("does not warn when nothing has been edited", () => {
		getEditorMarkdownForSaveMock.mockReturnValue(baseProps.prose);
		render(<PlanningAnalysisEditor {...baseProps} />);

		const event = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
	});
});

/**
 * The lock has to say WHY, and the two reasons make different promises.
 */
describe("PlanningAnalysisEditor — the lock explains itself", () => {
	it("promises replacement for a regeneration, which is what happens", () => {
		render(<PlanningAnalysisEditor {...baseProps} isLocked />);

		expect(
			screen.getByTestId("planning-analysis-locked"),
		).toHaveTextContent(/new analysis is being written/i);
	});

	it("does NOT promise replacement for an assistant rewrite, which may be rejected", () => {
		render(
			<PlanningAnalysisEditor
				{...baseProps}
				isLocked
				lockReason="assistant"
			/>,
		);

		const notice = screen.getByTestId("planning-analysis-locked");
		expect(notice).toHaveTextContent(/assistant is rewriting/i);
		expect(notice).toHaveTextContent(/accept or discard/i);
		// The regeneration sentence claims the text is about to be replaced.
		// Saying that about a proposal the reader can still reject would be
		// untrue half the time.
		expect(notice).not.toHaveTextContent(/replaces this one/i);
	});
});

/**
 * The confirm-time change digest, and the click that takes you to a section.
 *
 * The heading markup below is not invented — it is what
 * `fromMarkdown(diffPartialText(before, after, true))` actually emits, measured
 * before this was written. That matters for the renamed-section case: the
 * concatenated `textContent` is `"RisksRisk register"`, which starts with
 * neither heading, so matching on `textContent` alone (what
 * `StoryWorkspace.tsx`'s `scrollDiffToSection` does) silently finds nothing.
 */
describe("PlanningAnalysisEditor — the change digest", () => {
	const reviewProps = {
		...baseProps,
		diffReview: { onAcceptAll: vi.fn(), onRejectAll: vi.fn() },
	};

	function seedDocument(html: string) {
		fakeEditor.view.dom.innerHTML = html;
	}

	beforeEach(() => {
		seedDocument("");
		Element.prototype.scrollIntoView = vi.fn();
	});

	it("lists the bullets while a review is open", () => {
		render(
			<PlanningAnalysisEditor
				{...reviewProps}
				changeSummary={{
					bullets: ["Risks — the retry window is now bounded."],
					isLoading: false,
				}}
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: /the retry window is now bounded/i,
			}),
		).toBeInTheDocument();
	});

	it("scrolls to the section a bullet names, and flashes it", async () => {
		seedDocument("<h2>Risks</h2><p>a</p><h2>Scope</h2><p>b</p>");
		render(
			<PlanningAnalysisEditor
				{...reviewProps}
				changeSummary={{
					bullets: ["Scope — one more service is covered."],
					isLoading: false,
				}}
			/>,
		);

		await userEvent.click(
			screen.getByRole("button", { name: /one more service/i }),
		);

		const headings = fakeEditor.view.dom.querySelectorAll("h2");
		const scope = headings[1] as HTMLElement;
		expect(scope.scrollIntoView).toHaveBeenCalled();
		// The keyframes are global and shared with Feature Maturation; what is
		// asserted here is that the class lands on the RIGHT heading.
		expect(scope.classList.contains("maturation-section-flash")).toBe(true);
		expect(
			(headings[0] as HTMLElement).classList.contains(
				"maturation-section-flash",
			),
		).toBe(false);
	});

	it("finds a section the rewrite RENAMED, which textContent alone cannot", async () => {
		// The divergence from Feature Maturation, and the reason for it. Under
		// review the document is the diff, so a renamed heading holds both the
		// old and the new text and reads as one concatenated string.
		seedDocument(
			'<h2><del class="diff-del">Risks</del><ins class="diff-ins">Risk register</ins></h2><p>a</p>',
		);
		render(
			<PlanningAnalysisEditor
				{...reviewProps}
				changeSummary={{
					bullets: ["Risk register — renamed from Risks."],
					isLoading: false,
				}}
			/>,
		);

		const heading = fakeEditor.view.dom.querySelector("h2") as HTMLElement;
		// Precondition: the naive match really would fail here.
		expect(heading.textContent).toBe("RisksRisk register");

		await userEvent.click(
			screen.getByRole("button", { name: /renamed from risks/i }),
		);

		expect(heading.scrollIntoView).toHaveBeenCalled();
	});

	it("does nothing when a bullet names no section in the document", async () => {
		// Best-effort by design: a summary is advisory, and a dead click is a
		// far better failure than a thrown error over a missing heading.
		seedDocument("<h2>Risks</h2><p>a</p>");
		render(
			<PlanningAnalysisEditor
				{...reviewProps}
				changeSummary={{
					bullets: ["Appendix — a section that is not here."],
					isLoading: false,
				}}
			/>,
		);

		await userEvent.click(
			screen.getByRole("button", { name: /a section that is not here/i }),
		);

		const heading = fakeEditor.view.dom.querySelector("h2") as HTMLElement;
		expect(heading.scrollIntoView).not.toHaveBeenCalled();
		expect(heading.classList.contains("maturation-section-flash")).toBe(
			false,
		);
	});

	it("shows nothing at all outside a review", () => {
		// No `diffReview`, so no digest: it describes a review and has no
		// meaning without one.
		render(
			<PlanningAnalysisEditor
				{...baseProps}
				changeSummary={{
					bullets: ["Risks — should never be seen."],
					isLoading: false,
				}}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: /should never be seen/i }),
		).not.toBeInTheDocument();
	});
});
