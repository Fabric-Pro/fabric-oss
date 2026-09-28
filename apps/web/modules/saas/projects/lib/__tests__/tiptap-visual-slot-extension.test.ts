/**
 * Tests for the Glossy visual slot TipTap node (Fizzy #2589, KTD17, KTD18).
 *
 * Pins the schema-level contract — what the editor parses as a slot, the HTML
 * it renders back, where the insert command puts a new slot — and the helpers
 * an assistant application runs before it writes to the editor: slot
 * preservation, and the review diff that keeps a slot tag whole. The chip
 * itself is covered by `EditorToolbar.visual-slot.test.tsx`; the markdown
 * round trip by `save-load-flow.test.ts`.
 */

import {
	preserveVisualSlots,
	serializeVisualSlot,
} from "@repo/utils/glossy/visual-slots";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diffPartialText, fromMarkdown } from "../diff-utils";

// The React node view needs a mounted `EditorContent`; the schema does not.
vi.mock("@tiptap/react", () => ({
	NodeViewWrapper: () => null,
	ReactNodeViewRenderer: () => () => null,
}));

const {
	VisualSlot,
	diffKeepingVisualSlotsWhole,
	preserveEditorVisualSlots,
	VISUAL_SLOT_NODE_NAME,
} = await import("../tiptap-visual-slot-extension");

const SLOT_A = serializeVisualSlot({
	id: "slot-a",
	kind: "timeline",
	hint: "Show the phases",
});

let editors: Editor[] = [];

function makeEditor(content = "") {
	const editor = new Editor({
		extensions: [StarterKit, VisualSlot],
		content,
	});
	editors.push(editor);
	return editor;
}

afterEach(() => {
	for (const editor of editors) {
		editor.destroy();
	}
	editors = [];
});

function topLevelTypes(editor: Editor): string[] {
	const types: string[] = [];
	editor.state.doc.forEach((node) => {
		types.push(node.type.name);
	});
	return types;
}

function slotNodes(editor: Editor) {
	const found: Array<Record<string, unknown>> = [];
	editor.state.doc.descendants((node) => {
		if (node.type.name === VISUAL_SLOT_NODE_NAME) {
			found.push(node.attrs);
		}
	});
	return found;
}

/** Position just inside the first text node that contains `text`. */
function positionOf(editor: Editor, text: string): number {
	let at = -1;
	editor.state.doc.descendants((node, pos) => {
		if (at === -1 && node.isText && node.text?.includes(text)) {
			at = pos + 1;
		}
	});
	if (at === -1) {
		throw new Error(`text not found: ${text}`);
	}
	return at;
}

describe("VisualSlot — parsing and rendering (KTD18)", () => {
	it("parses the tag into a slot node with its id, kind, and hint", () => {
		const editor = makeEditor(SLOT_A);

		expect(slotNodes(editor)).toEqual([
			{
				slotId: "slot-a",
				kind: "timeline",
				hint: "Show the phases",
				orphanedFrom: null,
			},
		]);
	});

	it("reads a missing data-kind as best fit", () => {
		const editor = makeEditor(
			'<visual-slot data-slot-id="slot-b"></visual-slot>',
		);

		expect(slotNodes(editor)[0]).toMatchObject({
			slotId: "slot-b",
			kind: null,
			hint: null,
		});
	});

	it("renders the same tag serializeVisualSlot writes, attributes in its order", () => {
		const orphan = serializeVisualSlot({
			id: "slot-c",
			kind: "flow",
			hint: "Approval steps",
			orphanedFrom: "Implementation Phases",
		});
		const editor = makeEditor(`${SLOT_A}${orphan}`);

		const html = editor.getHTML();
		expect(html).toContain(SLOT_A);
		expect(html).toContain(orphan);
	});

	it("keeps a hint on one line when the stored tag encodes a line break", () => {
		const editor = makeEditor(
			'<visual-slot data-slot-id="slot-x" data-hint="Cost by quarter&#10;then totals"></visual-slot>',
		);

		expect(slotNodes(editor)[0]?.hint).toBe("Cost by quarter then totals");
	});

	it("drops the copy of a slot that sits inside a diff deletion, keeping the inserted one", () => {
		const moved = serializeVisualSlot({
			id: "slot-a",
			kind: "timeline",
			orphanedFrom: "Scope",
		});
		const editor = makeEditor(
			`<p><del class="diff-del">${SLOT_A}</del></p><p>Body</p><p><ins class="diff-ins">${moved}</ins></p>`,
		);

		expect(slotNodes(editor)).toEqual([
			{
				slotId: "slot-a",
				kind: "timeline",
				hint: null,
				orphanedFrom: "Scope",
			},
		]);
	});
});

describe("VisualSlot — insertVisualSlot", () => {
	it("inserts after the top-level block holding the selection, never inside it", () => {
		const editor = makeEditor(
			"<p>First</p><ul><li><p>Item</p></li></ul><p>Last</p>",
		);
		editor.commands.setTextSelection(positionOf(editor, "Item"));

		editor.commands.insertVisualSlot({
			kind: "timeline",
			hint: "Show the phases",
		});

		expect(topLevelTypes(editor)).toEqual([
			"paragraph",
			"bulletList",
			VISUAL_SLOT_NODE_NAME,
			"paragraph",
		]);
		const [slot] = slotNodes(editor);
		expect(slot).toMatchObject({
			kind: "timeline",
			hint: "Show the phases",
			orphanedFrom: null,
		});
		expect(slot?.slotId).toMatch(/^slot-[0-9a-f]{12}$/);
	});

	it("inserts best fit with no hint as a tag without data-kind or data-hint", () => {
		const editor = makeEditor("<h2>Scope</h2><p>Body</p>");
		editor.commands.setTextSelection(positionOf(editor, "Scope"));

		editor.commands.insertVisualSlot({ kind: null, hint: null });

		expect(topLevelTypes(editor)).toEqual([
			"heading",
			VISUAL_SLOT_NODE_NAME,
			"paragraph",
		]);
		const slotId = slotNodes(editor)[0]?.slotId as string;
		expect(editor.getHTML()).toContain(
			serializeVisualSlot({ id: slotId, kind: null, hint: null }),
		);
	});

	it("gives every inserted slot its own id", () => {
		const editor = makeEditor("<p>Body</p>");
		editor.commands.setTextSelection(positionOf(editor, "Body"));

		editor.commands.insertVisualSlot({ kind: null, hint: null });
		editor.commands.insertVisualSlot({ kind: null, hint: null });

		const ids = slotNodes(editor).map((slot) => slot.slotId);
		expect(new Set(ids).size).toBe(2);
	});
});

describe("preserveEditorVisualSlots (KTD17)", () => {
	const HTML_WITH_SLOT = `<h2>Implementation Phases</h2><p>Phase one, then two.</p>${SLOT_A}<h2>Risks</h2><p>Few.</p>`;

	it("puts back a slot the incoming markdown lacks, under the same heading", () => {
		const editor = makeEditor(HTML_WITH_SLOT);
		const incoming =
			"## Implementation Phases\n\nPhase one, then two, then three.\n\n## Risks\n\nFew.";

		expect(preserveEditorVisualSlots(editor, incoming)).toBe(
			`## Implementation Phases\n\nPhase one, then two, then three.\n\n${SLOT_A}\n\n## Risks\n\nFew.`,
		);
	});

	it("moves a slot whose section is gone to the end, naming the section", () => {
		const editor = makeEditor(HTML_WITH_SLOT);

		const result = preserveEditorVisualSlots(editor, "## Risks\n\nFew.");

		expect(result).toBe(
			`## Risks\n\nFew.\n\n${serializeVisualSlot({
				id: "slot-a",
				kind: "timeline",
				hint: "Show the phases",
				orphanedFrom: "Implementation Phases",
			})}`,
		);
	});

	it("strips a slot the model invented when the editor holds none", () => {
		const editor = makeEditor("<h2>Risks</h2><p>Few.</p>");

		expect(
			preserveEditorVisualSlots(editor, `## Risks\n\n${SLOT_A}\n\nFew.`),
		).toBe("## Risks\n\nFew.");
	});

	it("returns the incoming markdown untouched when neither side holds a slot", () => {
		const editor = makeEditor("<h2>Risks</h2><p>Few.</p>");
		const incoming = "## Risks\n\nMany,  in fact.\n";

		expect(preserveEditorVisualSlots(editor, incoming)).toBe(incoming);
	});
});

describe("diffKeepingVisualSlotsWhole", () => {
	const PHASES_SLOT = serializeVisualSlot({
		id: "slot-a",
		kind: "timeline",
		hint: "Phases",
	});

	// A rewrite that deletes the section holding the slot re-anchors it at the
	// end with `data-orphaned-from`. Word-diffed, that attribute lands between
	// diff markers inside the tag and the tag renders as escaped text.
	it.each([
		[
			"the last section",
			`## Risks\n\nFew.\n\n## Phases\n\nOne, two.\n\n${PHASES_SLOT}`,
		],
		[
			"a middle section",
			`## Phases\n\nOne, two.\n\n${PHASES_SLOT}\n\n## Risks\n\nFew.`,
		],
	])("renders one parseable slot when a rewrite drops %s", (_, baseline) => {
		const proposed = preserveVisualSlots(
			baseline,
			"## Risks\n\nFew, revised.",
		);

		const html = fromMarkdown(
			diffKeepingVisualSlotsWhole(baseline, proposed, true),
		);

		expect(html).not.toContain("&lt;visual-slot");
		expect(slotNodes(makeEditor(html))).toEqual([
			{
				slotId: "slot-a",
				kind: "timeline",
				hint: "Phases",
				orphanedFrom: "Phases",
			},
		]);
	});

	it("leaves a slot that did not move out of the diff markers", () => {
		const baseline = `## Phases\n\nOne, two.\n\n${PHASES_SLOT}\n\n## Risks\n\nFew.`;
		const proposed = preserveVisualSlots(
			baseline,
			"## Phases\n\nOne, two, three.\n\n## Risks\n\nFew.",
		);

		const diff = diffKeepingVisualSlotsWhole(baseline, proposed, true);

		expect(diff.split("\n")).toContain(PHASES_SLOT);
	});

	it("is diffPartialText itself when neither side holds a slot", () => {
		const before = "## Risks\n\nFew.";
		const after = "## Risks\n\nMany, in fact.";

		expect(diffKeepingVisualSlotsWhole(before, after, true)).toBe(
			diffPartialText(before, after, true),
		);
		expect(diffKeepingVisualSlotsWhole(before, after)).toBe(
			diffPartialText(before, after),
		);
	});
});
