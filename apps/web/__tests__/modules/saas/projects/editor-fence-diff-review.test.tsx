/**
 * Reviewing an AI edit that rewrites several lines of a fenced block.
 *
 * `editor-fence-diff-accept.test.ts` covers a change to ONE token on ONE line
 * of a fence, fed to the editor as hand-written HTML. This file drives the path
 * the review surfaces actually take — the editor's saved markdown is the
 * baseline, `diffPartialText(baseline, proposed, true)` → `fromMarkdown` →
 * `setContent` puts the review in the editor, and Accept all saves it with
 * `getEditorMarkdownForSave` — for edits that change several CONSECUTIVE lines
 * of a mermaid diagram or a code fence, the shape a regenerated diagram has.
 *
 * Every line break between two changed lines has to reach the saved markdown.
 * A line break that ends up as its own text node between two diff elements is
 * dropped by TipTap's HTML parser, and one between `</ins>` / `</del>` and the
 * next `<ins>` / `<del>` is rewritten to a space before the parser sees it;
 * either way two lines of the diagram are joined on accept and mermaid can no
 * longer parse it.
 *
 * Reject all restores the baseline in every surface, so it never meets the
 * diff; rejecting change by change from the review bar does, and is covered
 * separately. The per-change cases render the real `DiffReviewBar` against a
 * real editor and press its own buttons.
 */

import { DiffReviewBar } from "@saas/projects/components/DiffReviewBar";
import { diffPartialText, fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { advancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import type { Editor as ReactEditor } from "@tiptap/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The translation mock echoes keys, so buttons are found by their i18n key.
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useRecordDocumentAssistantDiffOutcome: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// Radix Tooltip reaches for pointer capture on mount; jsdom lacks it.
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

const FENCE = "```";

const editors: Editor[] = [];
afterEach(() => {
	cleanup();
	for (const editor of editors.splice(0)) {
		editor.destroy();
	}
});

function createEditor(html: string): Editor {
	const editor = new Editor({
		extensions: advancedExtensions,
		content: html,
	});
	editors.push(editor);
	return editor;
}

function save(editor: Editor): string {
	const saved = getEditorMarkdownForSave(editor);
	if (saved === null) {
		throw new Error("serialization failed");
	}
	return saved;
}

/** The stored document as the editor saves it: the baseline a review diffs against. */
function loadStored(markdown: string): string {
	return save(
		createEditor(fromMarkdown(markdown, { repairLegacyBullets: false })),
	);
}

/** The editor showing the review of `proposed` against `baseline`. */
function openReview(baseline: string, proposed: string): Editor {
	const editor = createEditor(
		fromMarkdown(baseline, { repairLegacyBullets: false }),
	);
	editor.commands.setContent(
		fromMarkdown(diffPartialText(baseline, proposed, true)),
	);
	return editor;
}

/** Accept all: every surface saves the review editor with the diff tags stripped. */
function acceptAll(baseline: string, proposed: string): string {
	return save(openReview(baseline, proposed));
}

/** Reject all: every surface puts the baseline back into the editor. */
function rejectAll(baseline: string, proposed: string): string {
	const editor = openReview(baseline, proposed);
	editor.commands.setContent(fromMarkdown(baseline));
	return save(editor);
}

/**
 * Resolve the review change by change with the review bar's own buttons. The
 * bar acts on the change at its current position, which stays on the first
 * remaining change after each accept or reject, so `decide(index)` is asked
 * about the changes in document order.
 */
function resolveEachChange(
	editor: Editor,
	decide: (index: number) => "approve" | "reject",
): string {
	render(
		<DiffReviewBar
			editor={editor as unknown as ReactEditor}
			onAcceptAll={vi.fn()}
			onRejectAll={vi.fn()}
		/>,
	);
	for (let index = 0; index < 500; index++) {
		const approve = screen.queryByRole("button", { name: "approve" });
		if (!approve) {
			return save(editor);
		}
		const action = decide(index);
		fireEvent.click(
			action === "approve"
				? approve
				: screen.getByRole("button", { name: "reject" }),
		);
	}
	throw new Error("the review bar never ran out of changes");
}

function fence(language: string, lines: string[]): string {
	return [`${FENCE}${language}`, ...lines, FENCE].join("\n");
}

/** The first fence of `language` in a saved document, delimiters included. */
function fenceIn(markdown: string, language: string): string | undefined {
	const match = markdown.match(
		new RegExp(`^${FENCE}${language}\\n[\\s\\S]*?\\n${FENCE}$`, "m"),
	);
	return match?.[0];
}

function document(block: string): string {
	return [
		"## Request flow",
		"",
		"Intake runs before review.",
		"",
		block,
		"",
		"Closing note for the reviewers.",
	].join("\n");
}

// A diagram as the visuals step writes it: the marker line first, nodes at
// column zero, a blank line, then styling.
const OLD_DIAGRAM = [
	"%% fabric-visual: abc123def456ghi7",
	"flowchart TB",
	"A[Request intake] --> B[Triage queue]",
	"B --> C{Needs review?}",
	"C -->|yes| D[Reviewer]",
	"C -->|no| E",
	"",
	"style A fill:#e8f1f8,stroke:#172b36",
	"classDef core fill:#172b36,color:#ffffff",
	"class B,C core",
];

// A new direction, new node ids, one more edge, a new classDef and class
// line: consecutive lines change, and the two sides differ in length.
const NEW_DIAGRAM = [
	"%% fabric-visual: abc123def456ghi7",
	"flowchart LR",
	"A[Request intake] --> T[Triage service]",
	"T --> R{Needs review?}",
	"R -->|yes| V[Reviewer pool]",
	"R -->|no| E",
	"E -.-> F[Follow-on task]",
	"",
	"style A fill:#e8f1f8,stroke:#172b36",
	"classDef core fill:#172b36,color:#ffffff",
	"classDef followon fill:#f6efe3,stroke:#8a6d3b",
	"class T,R core",
	"class F followon",
];

// The same diagram with its statements indented, as models often write it.
const indent = (lines: string[]) =>
	lines.map((line, index) => (index < 2 || !line ? line : `    ${line}`));

// A rename that runs across consecutive lines: one line ends on a changed
// token and the next starts with one.
const OLD_TS = [
	"export function retryDelay(attempt: number): number {",
	"  let delay = 250",
	"  delay = Math.min(4000, delay * 2 ** attempt)",
	"  return delay",
	"}",
	"",
	"export const MAX_ATTEMPTS = 5",
];

const NEW_TS = [
	"export function retryDelay(attempt: number, jitter = 0): number {",
	"  let wait = 500",
	"  wait = Math.min(8000, wait * 2 ** attempt)",
	"  return wait + jitter",
	"}",
	"",
	"export const MAX_ATTEMPTS = 7",
];

describe.each([
	{
		name: "a mermaid diagram from the visuals step",
		language: "mermaid",
		before: OLD_DIAGRAM,
		after: NEW_DIAGRAM,
	},
	{
		name: "an indented mermaid diagram",
		language: "mermaid",
		before: indent(OLD_DIAGRAM),
		after: indent(NEW_DIAGRAM),
	},
	{ name: "a ts code fence", language: "ts", before: OLD_TS, after: NEW_TS },
	{
		// A removed `2.` line after a paragraph line gets a blank line of its
		// own in prose; inside code that blank line would be content.
		name: "a ts fence that loses a numbered line",
		language: "ts",
		before: ["const intro = 1", "2. legacy step"],
		after: ["const intro = 1"],
	},
])(
	"an AI edit that rewrites several lines of $name",
	({ language, before, after }) => {
		const oldFence = fence(language, before);
		const newFence = fence(language, after);

		it("keeps the stored fence byte for byte through load and save", () => {
			// The precondition: without a diff the fence already round-trips, so
			// any difference below comes from the review.
			expect(fenceIn(loadStored(document(oldFence)), language)).toBe(
				oldFence,
			);
			expect(fenceIn(loadStored(document(newFence)), language)).toBe(
				newFence,
			);
		});

		it("Accept all saves the new fence byte for byte", () => {
			const baseline = loadStored(document(oldFence));

			const saved = acceptAll(baseline, document(newFence));

			expect(fenceIn(saved, language)).toBe(newFence);
		});

		it("Reject all saves the old fence byte for byte", () => {
			const baseline = loadStored(document(oldFence));

			const saved = rejectAll(baseline, document(newFence));

			expect(fenceIn(saved, language)).toBe(oldFence);
		});

		it("accepting every change one by one saves the new fence byte for byte", () => {
			const baseline = loadStored(document(oldFence));
			const editor = openReview(baseline, document(newFence));

			const saved = resolveEachChange(editor, () => "approve");

			expect(fenceIn(saved, language)).toBe(newFence);
		});

		it("rejecting every change one by one saves the old fence byte for byte", () => {
			const baseline = loadStored(document(oldFence));
			const editor = openReview(baseline, document(newFence));

			const saved = resolveEachChange(editor, () => "reject");

			expect(fenceIn(saved, language)).toBe(oldFence);
		});
	},
);

describe("the fabric-visual marker line of a rewritten diagram", () => {
	it("stays its own line when the line under it changes", () => {
		const before = [
			"%% fabric-visual: abc123def456ghi7",
			"flowchart TB",
			"A[Start] --> B[Review]",
		];
		const after = [
			"%% fabric-visual: abc123def456ghi7",
			"flowchart LR",
			"S[Start] --> R[Review]",
		];
		const baseline = loadStored(document(fence("mermaid", before)));

		const saved = acceptAll(baseline, document(fence("mermaid", after)));

		expect(fenceIn(saved, "mermaid")).toBe(fence("mermaid", after));
	});

	it("stays its own line when the visual id and every line under it change", () => {
		// Same line count on both sides, so each line is paired with its old
		// version. Joined onto the marker, the whole diagram would become one
		// `%%` comment line and render nothing.
		const before = [
			"%% fabric-visual: abc123def456ghi7",
			"flowchart TB",
			"A[Client] --> B[Gateway]",
			"B --> C[Service]",
		];
		const after = [
			"%% fabric-visual: zyx987wvu654tsr3",
			"sequenceDiagram",
			"User->>App: Open",
			"App-->>User: Show",
		];
		const baseline = loadStored(document(fence("mermaid", before)));

		const saved = acceptAll(baseline, document(fence("mermaid", after)));

		expect(fenceIn(saved, "mermaid")).toBe(fence("mermaid", after));
	});
});

describe("an unequal-line-count replacement inside a fence", () => {
	// Unchanged lines above and below the change, so the replaced run is
	// aligned between them and not paired line for line with its old version.
	const head = ["flowchart TB", "A[Client] --> B[Gateway]"];
	const tail = [
		"",
		"classDef core fill:#172b36,color:#ffffff",
		"class B core",
	];

	it.each([
		{
			name: "one line replaced by three",
			before: [...head, "B --> C[Service]", ...tail],
			after: [
				...head,
				"B --> Q[Queue]",
				"Q --> W[Worker]",
				"W --> C[Service]",
				...tail,
			],
		},
		{
			name: "three lines replaced by one",
			before: [
				...head,
				"B --> Q[Queue]",
				"Q --> W[Worker]",
				"W --> C[Service]",
				...tail,
			],
			after: [...head, "B --> C[Service]", ...tail],
		},
	])(
		"$name: Accept all saves the new fence, Reject all the old one",
		({ before, after }) => {
			const oldFence = fence("mermaid", before);
			const newFence = fence("mermaid", after);
			const baseline = loadStored(document(oldFence));

			expect(
				fenceIn(acceptAll(baseline, document(newFence)), "mermaid"),
			).toBe(newFence);
			expect(
				fenceIn(rejectAll(baseline, document(newFence)), "mermaid"),
			).toBe(oldFence);
		},
	);
});

describe("an AI edit with CRLF line endings", () => {
	// A model or a pasted reply can end lines with CRLF; the review still
	// keeps every line of the fence its own line.
	const crlf = (markdown: string) => markdown.replace(/\n/g, "\r\n");
	const oldFence = fence("mermaid", OLD_DIAGRAM);
	const newFence = fence("mermaid", NEW_DIAGRAM);

	it("Accept all saves the new fence with its line breaks", () => {
		const baseline = loadStored(document(oldFence));

		const saved = acceptAll(baseline, crlf(document(newFence)));

		expect(fenceIn(saved, "mermaid")).toBe(newFence);
	});

	it("Reject all saves the old fence byte for byte", () => {
		const baseline = loadStored(document(oldFence));

		const saved = rejectAll(baseline, crlf(document(newFence)));

		expect(fenceIn(saved, "mermaid")).toBe(oldFence);
	});
});

describe("resolving one change inside a fence from the review bar", () => {
	// Two consecutive column-zero lines change; the review bar lists each
	// line's deletion and insertion as separate changes, in document order:
	// 0 = `TB` removed, 1 = `LR` added, 2 = `A` removed, 3 = `S` added, …
	const before = [
		"%% fabric-visual: abc123def456ghi7",
		"flowchart TB",
		"A[Start] --> B[Review]",
		"B --> C[Done]",
	];
	const after = [
		"%% fabric-visual: abc123def456ghi7",
		"flowchart LR",
		"S[Start] --> B[Review]",
		"B --> C[Done]",
	];

	it("accepting the first line's change and rejecting the next keeps every line break", () => {
		const baseline = loadStored(document(fence("mermaid", before)));
		const editor = openReview(baseline, document(fence("mermaid", after)));

		const saved = resolveEachChange(editor, (index) =>
			index < 2 ? "approve" : "reject",
		);

		expect(fenceIn(saved, "mermaid")).toBe(
			fence("mermaid", [
				"%% fabric-visual: abc123def456ghi7",
				"flowchart LR",
				"A[Start] --> B[Review]",
				"B --> C[Done]",
			]),
		);
	});

	it("rejecting the first line's change and accepting the next keeps every line break", () => {
		const baseline = loadStored(document(fence("mermaid", before)));
		const editor = openReview(baseline, document(fence("mermaid", after)));

		const saved = resolveEachChange(editor, (index) =>
			index < 2 ? "reject" : "approve",
		);

		expect(fenceIn(saved, "mermaid")).toBe(
			fence("mermaid", [
				"%% fabric-visual: abc123def456ghi7",
				"flowchart TB",
				"S[Start] --> B[Review]",
				"B --> C[Done]",
			]),
		);
	});
});

describe("a diagram the AI removes or moves", () => {
	// A removed fence is reviewed as a code block under one deletion mark and
	// an added fence as one under an insertion mark. Shown as one struck-through
	// paragraph per line instead, a per-change reject had no fence to give
	// back: the old source stayed as plain paragraphs next to the new diagram.
	const diagram = fence("mermaid", OLD_DIAGRAM);

	const codeBlocksIn = (editor: Editor): number => {
		let count = 0;
		editor.state.doc.descendants((node) => {
			if (node.type.spec.code || node.type.name === "mermaidBlock") {
				count += 1;
			}
		});
		return count;
	};

	it("accepting the removal change by change leaves no diagram behind", () => {
		const baseline = loadStored(document(diagram));
		const proposed = document("").replace(/\n\n\n\n/, "\n\n");
		const editor = openReview(baseline, proposed);

		const saved = resolveEachChange(editor, () => "approve");

		expect(saved).not.toContain(FENCE);
		expect(saved).not.toContain("fabric-visual");
		expect(codeBlocksIn(editor)).toBe(0);
	});

	it("rejecting the removal change by change puts the diagram back as a fence", () => {
		const baseline = loadStored(document(diagram));
		const proposed = document("").replace(/\n\n\n\n/, "\n\n");
		const editor = openReview(baseline, proposed);

		const saved = resolveEachChange(editor, () => "reject");

		expect(fenceIn(saved, "mermaid")).toBe(diagram);
	});

	it("rejecting a move change by change keeps the old document", () => {
		// The AI moves a short diagram below the prose and edits it. The line
		// alignment keeps the prose, so the old diagram is reviewed as a
		// removed block and the new one as an added block.
		const before = [
			"%% fabric-visual: abc123def456ghi7",
			"flowchart TB",
			"A[Client] --> B[Gateway]",
			"B --> C[Service]",
		];
		const after = [
			"%% fabric-visual: abc123def456ghi7",
			"flowchart LR",
			"A[Client] --> G[Edge]",
			"G --> E[Service v2]",
			"E -.-> X[Bus]",
		];
		const prose = ["First point.", "", "Second point.", "", "Third point."];
		const baseline = loadStored(
			["Intro.", "", fence("mermaid", before), "", ...prose].join("\n"),
		);
		const proposed = [
			"Intro.",
			"",
			...prose,
			"",
			fence("mermaid", after),
		].join("\n");
		const editor = openReview(baseline, proposed);

		const saved = resolveEachChange(editor, () => "reject");

		expect(saved).toBe(baseline);
		// The rejected copy leaves no empty diagram in the editor either.
		expect(codeBlocksIn(editor)).toBe(1);
	});

	it("Accept all of removing the first of two diagrams keeps the second byte for byte", () => {
		const second = fence("mermaid", NEW_DIAGRAM);
		const baseline = loadStored(document(`${diagram}\n\n${second}`));

		const saved = acceptAll(baseline, document(second));

		expect(saved).not.toContain("DIFF_FENCE");
		expect(fenceIn(saved, "mermaid")).toBe(second);
	});
});

describe("a prose rewrite (control)", () => {
	const before = document(
		"The timeout is 30 seconds.\nRetries stop after five attempts.",
	);
	const after = document(
		"The timeout is 90 seconds.\nRetries stop after seven attempts.",
	);

	it("Accept all saves the AI's paragraph", () => {
		const baseline = loadStored(before);

		const saved = acceptAll(baseline, after);

		expect(saved).toBe(loadStored(after));
	});

	it("accepting every change one by one saves the AI's paragraph", () => {
		const baseline = loadStored(before);
		const editor = openReview(baseline, after);

		const saved = resolveEachChange(editor, () => "approve");

		expect(saved).toBe(loadStored(after));
	});

	it("rejecting every change one by one keeps the old paragraph", () => {
		const baseline = loadStored(before);
		const editor = openReview(baseline, after);

		const saved = resolveEachChange(editor, () => "reject");

		expect(saved).toBe(baseline);
	});
});
