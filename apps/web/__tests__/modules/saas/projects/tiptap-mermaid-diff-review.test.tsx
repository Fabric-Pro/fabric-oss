/**
 * Reviewing an AI edit of a diagram (Fizzy #2946).
 *
 * A diagram's source lives in its node's text, out of sight behind the drawn
 * diagram. An AI edit marks the lines it removes and adds inside that text,
 * so drawn as usual the review showed a diagram made of both versions at
 * once — or a parse error over a box of unmarked lines — and no change.
 * While its text is marked the diagram shows the marked source under a
 * label, with the proposed diagram drawn below it; once no mark is left it
 * is drawn again with its source out of sight.
 *
 * The review is built the way the review surfaces build it: the stored
 * document as the editor saves it is the baseline, and
 * `diffPartialText(baseline, proposed, true)` → `fromMarkdown` is what the
 * editor loads, here with the document editor's own extensions and React
 * node views. The renderers are the real ones except for a source marked
 * BROKEN, which neither draws.
 */

import en from "@repo/i18n/translations/en.json";
import { DiffReviewBar } from "@saas/projects/components/DiffReviewBar";
import { diffPartialText, fromMarkdown } from "@saas/projects/lib/diff-utils";
import { deriveDiffViews } from "@saas/projects/lib/diff-view-modes";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { createAdvancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import {
	EditorContent,
	type Editor as ReactEditor,
	useEditor,
} from "@tiptap/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagramHarness, fence, MARKER } from "./tiptap-mermaid-visual-harness";

const drawn = vi.hoisted(() => ({ sources: [] as string[] }));

vi.mock("beautiful-mermaid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("beautiful-mermaid")>();
	return {
		...actual,
		renderMermaidSVG: (
			code: string,
			options: Parameters<typeof actual.renderMermaidSVG>[1],
		) => {
			drawn.sources.push(code);
			if (code.includes("BROKEN")) {
				throw new Error("Parse error on line 3");
			}
			return actual.renderMermaidSVG(code, options);
		},
	};
});

// mermaid.js, the fallback, needs layout jsdom lacks.
const native = vi.hoisted(() => ({ sources: [] as string[] }));

vi.mock("mermaid", () => {
	const api = {
		initialize: () => {},
		mermaidAPI: { getSiteConfig: () => ({}) },
		render: async (_id: string, code: string) => {
			native.sources.push(code);
			if (code.includes("BROKEN")) {
				throw new Error("Parse error on line 3");
			}
			return {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>Fallback</text></svg>',
			};
		},
	};
	return { default: api };
});

vi.mock("next-intl", async () => {
	const { createTranslator } =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const messages = (await import("@repo/i18n/translations/en.json")).default;
	return {
		useTranslations: (namespace: string) =>
			createTranslator({
				locale: "en",
				messages,
				namespace: namespace as never,
				onError: () => {},
			}),
		useLocale: () => "en",
	};
});

vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useRecordDocumentAssistantDiffOutcome: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				listVisualSpecs: vi.fn().mockResolvedValue({ specs: [] }),
				editVisual: vi.fn(),
			},
		},
	},
}));

// Radix Tooltip, in the review bar, reaches for pointer capture on mount.
beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.setPointerCapture ??= () => undefined;
	Element.prototype.releasePointerCapture ??= () => undefined;
});

const LABEL = en.tooltips.editor.diagramReview.label;
const PREVIEW = en.tooltips.editor.diagramReview.preview;
const APPROVE = en.tooltips.documentEditor.approve;

const editors: Editor[] = [];
afterEach(() => {
	drawn.sources = [];
	native.sources = [];
	for (const editor of editors.splice(0)) {
		editor.destroy();
	}
});

const extensions = () =>
	createAdvancedExtensions({
		projectId: null,
		documentId: null,
		statTiles: true,
	});

function save(editor: Editor): string {
	const saved = getEditorMarkdownForSave(editor);
	if (saved === null) {
		throw new Error("serialization failed");
	}
	return saved;
}

/** The stored document as the editor saves it: the baseline a review diffs against. */
function loadStored(markdown: string): string {
	const editor = new Editor({
		extensions: extensions(),
		content: fromMarkdown(markdown, { repairLegacyBullets: false }),
	});
	editors.push(editor);
	return save(editor);
}

function doc(block: string): string {
	return `## Delivery\n\nWe start with discovery.\n\n${block}\n\nNext steps follow.`;
}

/** The first mermaid fence of a saved document, delimiters included. */
function fenceIn(markdown: string): string | undefined {
	return markdown.match(/^```mermaid\n[\s\S]*?\n```$/m)?.[0];
}

// The direction, a node and an edge change: drawn together, the old and new
// lines make a diagram with both Gateway and Edge, and a node named after
// the second `flowchart` line.
const OLD_DIAGRAM = [
	MARKER,
	"flowchart TB",
	'A["Client"] --> B["Gateway"]',
	"B --> C[Service]",
];
const NEW_DIAGRAM = [
	MARKER,
	"flowchart LR",
	'A["Client"] --> G["Edge"]',
	"G --> C[Service]",
];

function svgText(node: Element): string | null {
	const svg = node.querySelector(".mermaid-diagram-area svg");
	return svg ? (svg.textContent ?? "") : null;
}

/** The node's content element: the text ProseMirror edits. */
function sourceOf(node: Element): HTMLElement {
	const source = node.querySelector<HTMLElement>(
		"[data-node-view-content-react]",
	);
	if (!source) {
		throw new Error("no content element");
	}
	return source;
}

/** Whether `element`, or an ancestor inside the node, is out of sight. */
function hiddenWithin(element: Element, node: Element): boolean {
	for (
		let current: Element | null = element;
		current && current !== node;
		current = current.parentElement
	) {
		if (
			current.classList.contains("hidden") ||
			current.getAttribute("aria-hidden") === "true"
		) {
			return true;
		}
	}
	return false;
}

function expectSourceOutOfSight(node: Element) {
	// As the hidden-source test in `tiptap-mermaid-marker.test.tsx` has it.
	const holder = sourceOf(node).parentElement;
	expect(holder).not.toBe(node);
	expect(holder?.classList.contains("hidden")).toBe(true);
	expect(holder?.getAttribute("aria-hidden")).toBe("true");
}

/** Open the review of `newLines` against the stored `oldLines`. */
async function openReview(
	oldLines: string[],
	newLines: string[],
	options: Partial<Parameters<typeof DiagramHarness>[0]> = {},
) {
	const baseline = loadStored(doc(fence(oldLines)));
	let editor: Editor | null = null;
	const utils = render(
		<DiagramHarness
			markdown={diffPartialText(baseline, doc(fence(newLines)), true)}
			themeRoot={false}
			onEditor={(created) => {
				editor = created;
			}}
			{...options}
		/>,
	);
	const node = await waitFor(() => {
		const found = utils.container.querySelector(".node-mermaidBlock");
		if (!found || !editor) {
			throw new Error("no diagram yet");
		}
		return found;
	});
	return {
		...utils,
		baseline,
		node,
		editor: editor as unknown as Editor,
	};
}

describe("a diagram under review of an AI edit", () => {
	it("shows its source with the edit's marks under a label, and draws the proposed diagram", async () => {
		const { node } = await openReview(OLD_DIAGRAM, NEW_DIAGRAM);

		await waitFor(() => {
			if (svgText(node) === null) {
				throw new Error("no preview yet");
			}
		});

		expect(
			within(node as HTMLElement).getByRole("group", { name: LABEL }),
		).toBeTruthy();

		// The marks are in sight and readable, one line each.
		const source = sourceOf(node);
		const removed = Array.from(source.querySelectorAll("del.diff-del"));
		const added = Array.from(source.querySelectorAll("ins.diff-ins"));
		expect(removed.map((mark) => mark.textContent).join("")).toContain(
			"flowchart TB",
		);
		expect(added.map((mark) => mark.textContent).join("")).toContain(
			"flowchart LR",
		);
		for (const mark of [...removed, ...added]) {
			expect(hiddenWithin(mark, node)).toBe(false);
		}
		expect(source.textContent).toContain("flowchart TB\nflowchart LR\n");
		expect(
			window.getComputedStyle(source.parentElement as Element).whiteSpace,
		).toBe("pre-wrap");

		// The preview is the proposed diagram, not both versions together.
		const figure = within(node as HTMLElement).getByRole("figure", {
			name: PREVIEW,
		});
		expect(
			figure.querySelector(".mermaid-diagram-area svg"),
		).not.toBeNull();
		const preview = svgText(node) ?? "";
		expect(preview).toContain("Client");
		expect(preview).toContain("Edge");
		expect(preview).toContain("Service");
		expect(preview).not.toContain("Gateway");
		expect(preview).not.toContain("flowchart");
		expect(
			drawn.sources.some(
				(code) =>
					code.includes("flowchart TB") &&
					code.includes("flowchart LR"),
			),
		).toBe(false);
		expect(node.textContent).not.toMatch(/error/i);
	});

	it("shows the marked source on its own, without an error, when the proposed diagram does not draw", async () => {
		const broken = [MARKER, "flowchart LR", 'A["Client"] --> G["BROKEN"]'];
		const { node } = await openReview(OLD_DIAGRAM, broken);

		await waitFor(() => {
			expect(native.sources.some((code) => code.includes("BROKEN"))).toBe(
				true,
			);
		});
		await act(async () => {});

		expect(
			within(node as HTMLElement).getByRole("group", { name: LABEL }),
		).toBeTruthy();
		const added = sourceOf(node).querySelector("ins.diff-ins");
		expect(added?.textContent).toContain("BROKEN");
		expect(added && hiddenWithin(added, node)).toBe(false);
		expect(svgText(node)).toBeNull();
		expect(screen.queryByText(PREVIEW)).toBeNull();
		expect(node.textContent).not.toMatch(/error/i);
	});

	it("is drawn again with its source out of sight on Accept all", async () => {
		const { node, editor } = await openReview(OLD_DIAGRAM, NEW_DIAGRAM);

		// Accept all saves the review with the diff tags stripped.
		act(() => {
			editor.commands.setContent(fromMarkdown(save(editor)));
		});

		await waitFor(() => {
			expect(svgText(node)).toContain("Edge");
		});
		expect(svgText(node)).not.toContain("Gateway");
		expect(screen.queryByText(LABEL)).toBeNull();
		expectSourceOutOfSight(node);
	});

	it("is drawn again with its source out of sight on Reject all", async () => {
		const { node, editor, baseline } = await openReview(
			OLD_DIAGRAM,
			NEW_DIAGRAM,
		);

		// Reject all puts the baseline back.
		act(() => {
			editor.commands.setContent(fromMarkdown(baseline));
		});

		await waitFor(() => {
			expect(svgText(node)).toContain("Gateway");
		});
		expect(svgText(node)).not.toContain("Edge");
		expect(screen.queryByText(LABEL)).toBeNull();
		expectSourceOutOfSight(node);
	});

	it("accepting each change from the review bar keeps the fence's lines and ends in the drawn diagram", async () => {
		const { node, editor } = await openReview(OLD_DIAGRAM, NEW_DIAGRAM);
		render(
			<DiffReviewBar
				editor={editor as unknown as ReactEditor}
				onAcceptAll={vi.fn()}
				onRejectAll={vi.fn()}
			/>,
		);

		for (let step = 0; step < 50; step++) {
			const approve = screen.queryByRole("button", { name: APPROVE });
			if (!approve) {
				break;
			}
			act(() => {
				fireEvent.click(approve);
			});
		}

		expect(fenceIn(save(editor))).toBe(fence(NEW_DIAGRAM));
		await waitFor(() => {
			expect(svgText(node)).toContain("Edge");
		});
		expect(screen.queryByText(LABEL)).toBeNull();
		expectSourceOutOfSight(node);
	});

	it("is reviewed the same way in a client-document Proposal's diagram", async () => {
		const { node } = await openReview(OLD_DIAGRAM, NEW_DIAGRAM, {
			visual: { isMember: true },
			themeRoot: true,
		});

		await waitFor(() => {
			expect(svgText(node)).toContain("Edge");
		});
		expect(
			within(node as HTMLElement).getByRole("group", { name: LABEL }),
		).toBeTruthy();
		const removed = sourceOf(node).querySelector("del.diff-del");
		expect(removed && hiddenWithin(removed, node)).toBe(false);
		expect(svgText(node)).not.toContain("Gateway");
	});
});

function Pane({ html }: { html: string }) {
	const editor = useEditor({
		extensions: extensions(),
		content: html,
		editable: false,
		immediatelyRender: true,
	});
	return <EditorContent editor={editor} />;
}

describe("the side-by-side panes of a diagram under review", () => {
	it("draw the old diagram on the left and the new one on the right, each with its source out of sight", async () => {
		const { editor, unmount } = await openReview(OLD_DIAGRAM, NEW_DIAGRAM);
		const { originalHtml, proposedHtml } = deriveDiffViews(
			editor.getHTML(),
		);
		unmount();

		const left = render(<Pane html={originalHtml} />);
		const right = render(<Pane html={proposedHtml} />);
		const leftNode = left.container.querySelector(".node-mermaidBlock");
		const rightNode = right.container.querySelector(".node-mermaidBlock");
		if (!leftNode || !rightNode) {
			throw new Error("a pane has no diagram");
		}

		await waitFor(() => {
			expect(svgText(leftNode)).toContain("Gateway");
			expect(svgText(rightNode)).toContain("Edge");
		});
		expect(svgText(leftNode)).not.toContain("Edge");
		expect(svgText(rightNode)).not.toContain("Gateway");
		expectSourceOutOfSight(leftNode);
		expectSourceOutOfSight(rightNode);
	});
});
