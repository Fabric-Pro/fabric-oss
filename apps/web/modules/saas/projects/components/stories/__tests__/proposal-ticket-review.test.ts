/**
 * A Proposal Inbox update reviewed line by line on its ticket: the hand-off
 * to the ticket page, which bodies the review can show as they are, and the
 * update approved from what the reviewer accepted.
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MOVED_TABLES_AFTER,
	MOVED_TABLES_BEFORE,
} from "../../../lib/__tests__/moved-list-block-fixtures";
import { diffPartialText, fromMarkdown } from "../../../lib/diff-utils";
import {
	acceptAllChanges,
	acceptChange,
	type DiffRange,
	documentWithoutUndecidedChanges,
	editorHoldsDiffMarks,
	findDiffRanges,
	rejectAllChanges,
	rejectChange,
} from "../../../lib/editor-diff-marks";
import { advancedExtensions } from "../../../lib/tiptap-extensions-advanced";
import type { ChangeItem } from "../BacklogChangeProposal";
import {
	acceptedTicketDocument,
	endProposalTicketReview,
	PROPOSAL_TICKET_REVIEW_STORAGE_KEY,
	PROPOSAL_TICKET_REVIEW_TTL_MS,
	type ProposalTicketReview,
	pendingProposalTicketReview,
	proposalItemStillOpen,
	proposedBodiesAsIs,
	reviewedTicketChange,
	startProposalTicketReview,
	type TicketBodies,
} from "../proposal-ticket-review";

const STORED: TicketBodies = {
	description: "Intro\nOld step",
	acceptanceCriteria: "- A",
};

const MERGED_UPDATE: ChangeItem = {
	type: "feature",
	action: "update",
	existingId: "story-7",
	existingIdentifier: "F-7",
	title: { from: "Bravo", to: "Bravo" },
	description: { from: "Intro\nOld step", to: "Intro\nNew step" },
	acceptanceCriteria: { from: "- A", to: "- A\n- B" },
	structurePreserved: true,
	reasoning: "Raised in planning",
	sourceContext: "teams_messages",
};

function review(storyId: string): Omit<ProposalTicketReview, "startedAt"> {
	return {
		projectId: "project_1",
		organizationId: null,
		storyId,
		proposalId: "proposal_1",
		source: "SLACK_CHANNEL",
		changeIndex: 1,
		change: MERGED_UPDATE,
		syncToPM: false,
		expectedProposalRevision: "rev-1",
	};
}

afterEach(() => {
	endProposalTicketReview();
	window.sessionStorage.clear();
	vi.useRealTimers();
});

describe("the hand-off to the ticket page", () => {
	it("is found only on the ticket it was handed to, until it ends", () => {
		startProposalTicketReview(review("story-7"));

		expect(pendingProposalTicketReview("story-8")).toBeNull();
		expect(pendingProposalTicketReview("story-7")?.changeIndex).toBe(1);

		endProposalTicketReview();
		expect(pendingProposalTicketReview("story-7")).toBeNull();
	});

	it("survives a reload of the tab, with the item as the reviewer left it", async () => {
		startProposalTicketReview(review("story-7"));

		// A reload starts the module afresh; only the tab's storage remains.
		vi.resetModules();
		const reloaded = await import("../proposal-ticket-review");

		expect(reloaded.pendingProposalTicketReview("story-7")).toMatchObject(
			review("story-7"),
		);

		reloaded.endProposalTicketReview();
		expect(
			window.sessionStorage.getItem(
				reloaded.PROPOSAL_TICKET_REVIEW_STORAGE_KEY,
			),
		).toBeNull();
	});

	it("drops a stored hand-off it cannot read", async () => {
		window.sessionStorage.setItem(
			PROPOSAL_TICKET_REVIEW_STORAGE_KEY,
			JSON.stringify({ storyId: "story-7" }),
		);

		vi.resetModules();
		const reloaded = await import("../proposal-ticket-review");

		expect(reloaded.pendingProposalTicketReview("story-7")).toBeNull();
	});

	it("is dropped once it waited longer than its time to live", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-05T10:00:00Z"));
		startProposalTicketReview(review("story-7"));

		vi.setSystemTime(Date.now() + PROPOSAL_TICKET_REVIEW_TTL_MS);
		expect(pendingProposalTicketReview("story-7")).not.toBeNull();

		vi.setSystemTime(Date.now() + 1);
		expect(pendingProposalTicketReview("story-7")).toBeNull();
		expect(
			window.sessionStorage.getItem(PROPOSAL_TICKET_REVIEW_STORAGE_KEY),
		).toBeNull();
	});
});

describe("proposalItemStillOpen", () => {
	const resolved = [{ changeIndex: 0 }];

	it("is open while the proposal is in review and the item undecided", () => {
		expect(
			proposalItemStillOpen(
				{ status: "PENDING", resolvedItems: resolved },
				1,
			),
		).toBe(true);
	});

	it("is closed once the item is decided or the proposal left review", () => {
		expect(
			proposalItemStillOpen(
				{ status: "PENDING", resolvedItems: resolved },
				0,
			),
		).toBe(false);
		expect(
			proposalItemStillOpen({ status: "APPROVED", resolvedItems: [] }, 1),
		).toBe(false);
		expect(proposalItemStillOpen(null, 1)).toBe(false);
	});
});

describe("acceptedTicketDocument", () => {
	const editors: Editor[] = [];
	afterEach(() => {
		for (const editor of editors.splice(0)) {
			editor.destroy();
		}
	});

	function loadedEditor(markdown: string): Editor {
		const editor = new Editor({
			element: document.createElement("div"),
			extensions: advancedExtensions,
			content: fromMarkdown(markdown, { repairLegacyBullets: false }),
		});
		editors.push(editor);
		return editor;
	}

	function reviewEditor(baseline: string, next: string): Editor {
		return loadedEditor(diffPartialText(baseline, next, true));
	}

	/** What the ticket saves when it holds `markdown` and no review. */
	function savedAs(markdown: string): string | null {
		return acceptedTicketDocument(loadedEditor(markdown));
	}

	// The update moves "Why it matters" up a level. The two lines after it
	// keep their indentation, so they become its children.
	const NESTED = [
		"- Which reviews are eligible?",
		"    - Why it matters: it decides the recipients.",
		"    - Owner: Product",
		"    - Needed by: Dev handoff",
		"- When are reminders sent?",
	].join("\n");
	const OUTDENTED = [
		"- Which reviews are eligible?",
		"- Why it matters: it decides the recipients.",
		"    - Owner: Product",
		"    - Needed by: Dev handoff",
		"- When are reminders sent?",
	].join("\n");

	/** A change still undecided in the editor's first paragraph. */
	function firstParagraphChange(editor: Editor): DiffRange | undefined {
		const end = editor.state.doc.child(0).nodeSize;
		return findDiffRanges(editor.state.doc).find(
			(range) => range.to <= end,
		);
	}

	it("writes the accepted changes and drops the undecided ones, leaving the editor as it was", () => {
		const editor = reviewEditor(
			"First old.\n\nSecond old.",
			"First new.\n\nSecond new.",
		);
		let change = firstParagraphChange(editor);
		while (change) {
			acceptChange(editor, change);
			change = firstParagraphChange(editor);
		}
		const before = editor.getJSON();
		const updates = vi.fn();
		editor.on("update", updates);

		const written = acceptedTicketDocument(editor);

		expect(written).toContain("First new.");
		expect(written).toContain("Second old.");
		expect(written).not.toContain("Second new.");
		// A refused Apply still finds the undecided change to review.
		expect(updates).not.toHaveBeenCalled();
		expect(editor.getJSON()).toEqual(before);
		expect(editorHoldsDiffMarks(editor.state.doc)).toBe(true);
	});

	it("marks a line moved to another list level, and writes none of it while it is undecided", () => {
		const editor = reviewEditor(NESTED, OUTDENTED);

		expect(findDiffRanges(editor.state.doc).length).toBeGreaterThan(0);
		expect(acceptedTicketDocument(editor)).toBe(savedAs(NESTED));
	});

	it("writes the move, with the lines it took as children, once it is accepted", () => {
		const editor = reviewEditor(NESTED, OUTDENTED);

		acceptAllChanges(editor);

		expect(acceptedTicketDocument(editor)).toBe(savedAs(OUTDENTED));
	});

	it("marks a line moved under the item before it, and writes it only once accepted", () => {
		const flat = "- Parent\n- Child\n  - Detail\n- Sibling";
		const indented = "- Parent\n  - Child\n  - Detail\n- Sibling";
		const editor = reviewEditor(flat, indented);

		expect(findDiffRanges(editor.state.doc).length).toBeGreaterThan(0);
		expect(acceptedTicketDocument(editor)).toBe(savedAs(flat));

		acceptAllChanges(editor);

		expect(acceptedTicketDocument(editor)).toBe(savedAs(indented));
	});

	/** The textblocks of `doc` with no content: an emptied bullet among them. */
	function emptyTextblocks(doc: ProseMirrorNode): number {
		let count = 0;
		doc.descendants((node) => {
			if (node.isTextblock && node.content.size === 0) {
				count += 1;
			}
		});
		return count;
	}

	/** The one moved list block of the review in `editor`. */
	function moveOf(editor: Editor): DiffRange {
		const moves = findDiffRanges(editor.state.doc).filter(
			(range) => range.moved,
		);
		expect(moves).toHaveLength(1);
		return moves[0];
	}

	// Each body ends on a paragraph: after any edit the editor adds an empty
	// one behind a body that does not.
	const CLOSING = "\n\nNotes follow.";
	describe.each([
		{
			label: "a line moved up a level, the lines after it its children",
			old: NESTED,
			next: OUTDENTED,
			moveOnly: OUTDENTED,
		},
		{
			label: "a line moved under the item before it",
			old: "- Parent\n- Child\n  - Detail\n- Sibling",
			next: "- Parent\n  - Child\n  - Detail\n- Sibling",
			moveOnly: "- Parent\n  - Child\n  - Detail\n- Sibling",
		},
		{
			label: "a line moved under its parent, next to an edited line",
			old: "- p\n  - a\n- b",
			next: "- p\n  - A\n  - b",
			moveOnly: "- p\n  - a\n  - b",
		},
		{
			label: "two lines moved to levels on either side",
			old: "- p\n  - q\n    - x\n- y",
			next: "- p\n  - q\n  - x\n  - y",
			moveOnly: "- p\n  - q\n  - x\n  - y",
		},
		{
			label: "two lines that swap levels, so neither side can go first",
			old: "- p\n  - a\n- b",
			next: "- p\n  - b\n- a",
			moveOnly: "- p\n  - b\n- a",
		},
		{
			label: "a line moved up a level from under an edited line",
			old: "- x\n  - m",
			next: "- X\n- m",
			moveOnly: "- X\n- m",
		},
		{
			label: "a heading edited with the list a line moves in",
			old: "## Steps\n\n- a\n- b",
			next: "## Next\n\n- A\n  - b",
			moveOnly: "## Next\n\n- A\n  - b",
		},
		{
			label: "a moved item that holds a quote",
			old: "- p\n- step\n  > Note: careful",
			next: "- p\n  - step\n    > Note: careful",
			moveOnly: "- p\n  - step\n    > Note: careful",
		},
		{
			label: "a table edited with the list a line moves in",
			old: "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- a\n- b",
			next: "| a | b |\n| --- | --- |\n| 1 | 3 |\n\n- A\n  - b",
			moveOnly: "| a | b |\n| --- | --- |\n| 1 | 3 |\n\n- A\n  - b",
		},
		{
			label: "an HTML table edited with the list a line moves in",
			old: "<table><tr><td>1</td></tr></table>\n\n- a\n- b",
			next: "<table><tr><td>2</td></tr></table>\n\n- A\n  - b",
			moveOnly: "<table><tr><td>2</td></tr></table>\n\n- A\n  - b",
		},
		{
			label: "two lines that swap levels with no line to close them after an edited line",
			old: "- p\n  - k\n  - a\n- b",
			next: "- P\n  - k\n  - b\n- a",
			moveOnly: "- P\n  - k\n  - b\n- a",
		},
	])("$label", ({ old, next, moveOnly }) => {
		const before = old + CLOSING;
		const after = next + CLOSING;

		it("is one moved block, which Accept all writes", () => {
			const editor = reviewEditor(before, after);
			moveOf(editor);

			acceptAllChanges(editor);

			expect(emptyTextblocks(editor.state.doc)).toBe(0);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(after));
		});

		it("is taken back whole by Reject all", () => {
			const editor = reviewEditor(before, after);

			rejectAllChanges(editor);

			expect(emptyTextblocks(editor.state.doc)).toBe(0);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(before));
		});

		it("writes the move alone when only it is accepted", () => {
			const editor = reviewEditor(before, after);

			acceptChange(editor, moveOf(editor));

			expect(emptyTextblocks(editor.state.doc)).toBe(0);
			expect(
				emptyTextblocks(documentWithoutUndecidedChanges(editor)),
			).toBe(0);
			expect(acceptedTicketDocument(editor)).toBe(
				savedAs(moveOnly + CLOSING),
			);
		});

		it("writes none of it when only it is rejected", () => {
			const editor = reviewEditor(before, after);

			rejectChange(editor, moveOf(editor));

			expect(emptyTextblocks(editor.state.doc)).toBe(0);
			expect(
				emptyTextblocks(documentWithoutUndecidedChanges(editor)),
			).toBe(0);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(before));
		});

		it("writes none of it when nothing is decided", () => {
			const editor = reviewEditor(before, after);

			expect(
				emptyTextblocks(documentWithoutUndecidedChanges(editor)),
			).toBe(0);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(before));
		});
	});

	describe("a moved list item that holds a fenced code block", () => {
		const fence = "```";
		const before = `- Setup\n- Run it\n  ${fence}\n  npm start\n  ${fence}\n- Done${CLOSING}`;
		const after = `- Setup\n  - Run it\n    ${fence}\n    npm start\n    ${fence}\n- Done${CLOSING}`;

		/** For each code block of `doc`, the line of the list item it is in. */
		function codeBlockItems(doc: ProseMirrorNode): (string | null)[] {
			const items: (string | null)[] = [];
			doc.descendants((node, pos) => {
				if (node.type.name === "codeBlock") {
					const parent = doc.resolve(pos).parent;
					items.push(
						parent.type.name === "listItem"
							? (parent.firstChild?.textContent ?? "")
							: null,
					);
				}
			});
			return items;
		}

		it("marks the code inside its item, on both sides of one moved block", () => {
			const editor = reviewEditor(before, after);
			const { doc } = editor.state;

			expect(codeBlockItems(doc)).toEqual(["Run it", "Run it"]);
			const lines = (moveOf(editor).moved ?? []).map((range) =>
				doc.textBetween(range.from, range.to),
			);
			expect(lines.filter((line) => line === "npm start")).toHaveLength(
				2,
			);
			expect(findDiffRanges(doc)).toHaveLength(1);
		});

		it("Accept all writes the item, its code inside it, at its new level", () => {
			const editor = reviewEditor(before, after);

			acceptAllChanges(editor);

			expect(emptyTextblocks(editor.state.doc)).toBe(0);
			expect(codeBlockItems(editor.state.doc)).toEqual(["Run it"]);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(after));
		});

		it("Reject all keeps the item where it was, its code inside it", () => {
			const editor = reviewEditor(before, after);

			rejectAllChanges(editor);

			expect(emptyTextblocks(editor.state.doc)).toBe(0);
			expect(codeBlockItems(editor.state.doc)).toEqual(["Run it"]);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(before));
		});

		it("Apply with nothing decided writes the item as it was, its code inside it", () => {
			const editor = reviewEditor(before, after);
			const applied = documentWithoutUndecidedChanges(editor);

			expect(emptyTextblocks(applied)).toBe(0);
			expect(codeBlockItems(applied)).toEqual(["Run it"]);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(before));
		});
	});

	// A live check: the Markdown table split into one change per cell, every
	// Apply left an emptied table behind, and both tables were written
	// outside their items.
	describe("moved list items that hold a Markdown and an HTML table", () => {
		const before = MOVED_TABLES_BEFORE + CLOSING;
		const after = MOVED_TABLES_AFTER + CLOSING;

		/** The tables of `doc`, each read as its text. */
		function tableTexts(doc: ProseMirrorNode): string[] {
			const texts: string[] = [];
			doc.descendants((node) => {
				if (node.type.name === "table") {
					texts.push(node.textContent);
				}
			});
			return texts;
		}

		it("shows each table's move as one change with its item", () => {
			const editor = reviewEditor(before, after);

			expect(findDiffRanges(editor.state.doc)).toHaveLength(2);
			expect(
				findDiffRanges(editor.state.doc).every((range) => range.moved),
			).toBe(true);
		});

		it("Apply with nothing decided writes the tables as they were, in their items", () => {
			const editor = reviewEditor(before, after);
			const applied = documentWithoutUndecidedChanges(editor);

			expect(emptyTextblocks(applied)).toBe(0);
			expect(tableTexts(applied)).toEqual(["PlanPriceBasic5", "Pro9"]);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(before));
		});

		it("Reject all writes the tables as they were, in their items", () => {
			const editor = reviewEditor(before, after);

			rejectAllChanges(editor);

			expect(emptyTextblocks(editor.state.doc)).toBe(0);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(before));
		});

		it("Accept all writes the tables at their items' new level, and no empty table", () => {
			const editor = reviewEditor(before, after);

			acceptAllChanges(editor);

			expect(emptyTextblocks(editor.state.doc)).toBe(0);
			expect(tableTexts(editor.state.doc)).toEqual([
				"PlanPriceBasic5",
				"Pro9",
			]);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(after));
		});
	});

	it("keeps word-level marks on an edited line next to a moved one", () => {
		const editor = reviewEditor(
			`- p\n  - a\n- b${CLOSING}`,
			`- p\n  - A\n  - b${CLOSING}`,
		);
		const { doc } = editor.state;

		moveOf(editor);
		expect(
			findDiffRanges(doc)
				.filter((range) => !range.moved)
				.map((range) => [
					range.type,
					doc.textBetween(range.from, range.to),
				]),
		).toEqual([
			["deletion", "a"],
			["addition", "A"],
		]);
	});

	it("takes the edited line a moved line leaves into its one change", () => {
		const editor = reviewEditor(
			`- x\n  - m${CLOSING}`,
			`- X\n- m${CLOSING}`,
		);
		const { doc } = editor.state;

		const lines = (moveOf(editor).moved ?? []).map((range) =>
			doc.textBetween(range.from, range.to),
		);

		expect(lines).toEqual(["x", "m", "X", "m"]);
		expect(findDiffRanges(doc)).toHaveLength(1);
	});

	it.each([
		{
			block: "heading",
			old: "## Steps\n\n- a\n- b",
			next: "## Next\n\n- A\n  - b",
		},
		{
			block: "blockquote",
			old: "- p\n- step\n  > Note: careful",
			next: "- p\n  - step\n    > Note: careful",
		},
	])(
		"keeps a $block in a moved block one on both sides",
		({ block, old, next }) => {
			const editor = reviewEditor(old + CLOSING, next + CLOSING);
			const blocks: string[] = [];
			const texts: string[] = [];
			editor.state.doc.descendants((node) => {
				if (node.type.name === block) {
					blocks.push(node.textContent);
				}
				if (node.isTextblock) {
					texts.push(node.textContent);
				}
			});

			expect(blocks).toHaveLength(2);
			expect(texts.some((text) => /^\s*[#>]/.test(text))).toBe(false);
			expect(findDiffRanges(editor.state.doc)).toHaveLength(1);
		},
	);

	it("groups no line with a changed link next to it when no line moved", () => {
		const editor = reviewEditor(
			`- [Report](https://example.com/a)\n- Owner: Product${CLOSING}`,
			`- [Report](https://example.com/b)\n- Due: Friday${CLOSING}`,
		);

		expect(
			findDiffRanges(editor.state.doc).filter((range) => range.moved),
		).toEqual([]);

		acceptChange(editor, changeOf(editor, "addition", "Due"));

		const written = acceptedTicketDocument(editor);
		expect(written).toContain("Due");
		expect(written).toContain("https://example.com/a");
		expect(written).not.toContain("https://example.com/b");
	});

	it("takes a moved line and the lines that change parent with it as one change", () => {
		const editor = reviewEditor(NESTED + CLOSING, OUTDENTED + CLOSING);
		const { doc } = editor.state;

		const lines = (moveOf(editor).moved ?? []).map((range) =>
			doc.textBetween(range.from, range.to),
		);

		// Each line once on each side; none of them is a change of its own.
		expect(lines.filter((line) => line.startsWith("Owner"))).toHaveLength(
			2,
		);
		expect(findDiffRanges(doc)).toHaveLength(1);
	});

	/** The change of `type` whose text starts with `text`. */
	function changeOf(
		editor: Editor,
		type: DiffRange["type"],
		text: string,
	): DiffRange {
		const range = findDiffRanges(editor.state.doc).find(
			(candidate) =>
				candidate.type === type &&
				editor.state.doc
					.textBetween(candidate.from, candidate.to)
					.startsWith(text),
		);
		if (!range) {
			throw new Error(`no ${type} of "${text}"`);
		}
		return range;
	}

	it("keeps the lines nested under a deleted line under the line before it, when only that deletion is accepted", () => {
		const editor = reviewEditor(
			`- Start\n- Parent step\n  - First detail\n  - Second detail\n- End${CLOSING}`,
			`- Start\n- End${CLOSING}`,
		);
		expect(findDiffRanges(editor.state.doc)).toHaveLength(3);

		acceptChange(editor, changeOf(editor, "deletion", "Parent step"));

		expect(emptyTextblocks(editor.state.doc)).toBe(0);
		expect(emptyTextblocks(documentWithoutUndecidedChanges(editor))).toBe(
			0,
		);
		expect(acceptedTicketDocument(editor)).toBe(
			savedAs(
				`- Start\n  - First detail\n  - Second detail\n- End${CLOSING}`,
			),
		);
	});

	it("writes an accepted nested line at its depth, and not the undecided line above it", () => {
		const editor = reviewEditor(
			`- Start${CLOSING}`,
			`- Start\n- Parent step\n  - Child step${CLOSING}`,
		);

		acceptChange(editor, changeOf(editor, "addition", "Child step"));

		expect(emptyTextblocks(documentWithoutUndecidedChanges(editor))).toBe(
			0,
		);
		expect(acceptedTicketDocument(editor)).toBe(
			savedAs(`- Start\n  - Child step${CLOSING}`),
		);
	});

	// The nested lines keep their depth on both sides, so the diff leaves them
	// unmarked: where the parent line is absent they sit under "Scope".
	const SCOPE = "- Scope\n  - Export CSV\n  - Export PDF";
	const FORMATS = "- Scope\n- Formats\n  - Export CSV\n  - Export PDF";
	describe.each([
		{
			label: "a parent bullet added over nested items",
			old: SCOPE,
			next: FORMATS,
		},
		{
			label: "a parent bullet deleted with its nested items kept",
			old: FORMATS,
			next: SCOPE,
		},
	])("$label", ({ old, next }) => {
		const before = old + CLOSING;
		const after = next + CLOSING;

		it("is one change, and none of the nested lines", () => {
			const editor = reviewEditor(before, after);

			expect(findDiffRanges(editor.state.doc)).toHaveLength(1);
		});

		it("writes nothing when nothing is decided", () => {
			const editor = reviewEditor(before, after);

			expect(
				emptyTextblocks(documentWithoutUndecidedChanges(editor)),
			).toBe(0);
			expect(acceptedTicketDocument(editor)).toBe(savedAs(before));
		});

		it("is taken back by Reject all, and by rejecting it alone", () => {
			const all = reviewEditor(before, after);
			rejectAllChanges(all);
			const one = reviewEditor(before, after);
			rejectChange(one, findDiffRanges(one.state.doc)[0]);

			expect(emptyTextblocks(all.state.doc)).toBe(0);
			expect(acceptedTicketDocument(all)).toBe(savedAs(before));
			expect(acceptedTicketDocument(one)).toBe(savedAs(before));
		});

		it("is written by Accept all, and by accepting it alone", () => {
			const all = reviewEditor(before, after);
			acceptAllChanges(all);
			const one = reviewEditor(before, after);
			acceptChange(one, findDiffRanges(one.state.doc)[0]);

			expect(emptyTextblocks(all.state.doc)).toBe(0);
			expect(acceptedTicketDocument(all)).toBe(savedAs(after));
			expect(acceptedTicketDocument(one)).toBe(savedAs(after));
		});
	});

	it("leaves a list the editor only re-indented unmarked", () => {
		const editor = reviewEditor(NESTED, NESTED.replace(/^ {4}/gm, "  "));

		expect(findDiffRanges(editor.state.doc)).toEqual([]);
	});
});

describe("proposedBodiesAsIs", () => {
	it("uses an update already merged against the ticket's current text", () => {
		expect(proposedBodiesAsIs(MERGED_UPDATE, STORED)).toEqual({
			description: "Intro\nNew step",
			acceptanceCriteria: "- A\n- B",
		});
	});

	it("asks for a merge when the ticket changed since the update was merged", () => {
		expect(
			proposedBodiesAsIs(MERGED_UPDATE, {
				...STORED,
				description: "Intro\nEdited since",
			}),
		).toBeNull();
	});

	it("asks for a merge when apply would merge the update itself", () => {
		expect(
			proposedBodiesAsIs(
				{ ...MERGED_UPDATE, structurePreserved: undefined },
				STORED,
			),
		).toBeNull();
		expect(
			proposedBodiesAsIs(
				{ ...MERGED_UPDATE, bodyMergeDeferred: true },
				STORED,
			),
		).toBeNull();
	});

	it("keeps the ticket's bodies when the update moves none", () => {
		expect(
			proposedBodiesAsIs(
				{
					...MERGED_UPDATE,
					structurePreserved: undefined,
					description: undefined,
					acceptanceCriteria: undefined,
					priority: { from: "P3", to: "P1" },
				},
				STORED,
			),
		).toEqual(STORED);
	});
});

describe("reviewedTicketChange", () => {
	const unchanged: TicketBodies = {
		description: "Intro\n\nOld step",
		acceptanceCriteria: "- A",
	};

	it("writes the bodies as reviewed, against the stored text, without a second merge", () => {
		const change = reviewedTicketChange({
			change: { ...MERGED_UPDATE, bodyMergeDeferred: true },
			stored: STORED,
			unchanged,
			reviewed: {
				description: "Intro\n\nNew step",
				acceptanceCriteria: "- A",
			},
			undecidedBodyChanges: false,
		});

		expect(change?.description).toEqual({
			from: "Intro\nOld step",
			to: "Intro\n\nNew step",
		});
		// The reviewer rejected the criterion: the field is not written.
		expect(change?.acceptanceCriteria).toBeUndefined();
		expect(change?.structurePreserved).toBe(true);
		expect(change?.bodyMergeDeferred).toBeUndefined();
		expect(change?.existingId).toBe("story-7");
	});

	it("applies the item's other fields with an accepted body change, others still undecided", () => {
		const change = reviewedTicketChange({
			change: { ...MERGED_UPDATE, priority: { from: "P3", to: "P1" } },
			stored: STORED,
			unchanged,
			reviewed: { ...unchanged, description: "Intro\n\nNew step" },
			undecidedBodyChanges: true,
		});

		expect(change?.priority).toEqual({ from: "P3", to: "P1" });
	});

	it("applies nothing, the item's other fields included, while nothing is decided", () => {
		expect(
			reviewedTicketChange({
				change: {
					...MERGED_UPDATE,
					priority: { from: "P3", to: "P1" },
					size: { to: "S" },
				},
				stored: STORED,
				unchanged,
				reviewed: unchanged,
				undecidedBodyChanges: true,
			}),
		).toBeNull();
	});

	it("applies the item's other fields alone once every body change was rejected", () => {
		const change = reviewedTicketChange({
			change: {
				...MERGED_UPDATE,
				title: { from: "Bravo", to: "Bravo, renamed" },
			},
			stored: STORED,
			unchanged,
			reviewed: unchanged,
			undecidedBodyChanges: false,
		});

		expect(change?.title).toEqual({ from: "Bravo", to: "Bravo, renamed" });
		expect(change?.description).toBeUndefined();
		expect(change?.acceptanceCriteria).toBeUndefined();
	});

	it("applies the other fields of an update that changes no body", () => {
		const change = reviewedTicketChange({
			change: {
				...MERGED_UPDATE,
				description: undefined,
				acceptanceCriteria: undefined,
				priority: { from: "P3", to: "P1" },
			},
			stored: STORED,
			unchanged,
			reviewed: unchanged,
			undecidedBodyChanges: false,
		});

		expect(change?.description).toBeUndefined();
		expect(change?.priority).toEqual({ from: "P3", to: "P1" });
	});

	it("leaves nothing to apply when the review kept the ticket as it was", () => {
		expect(
			reviewedTicketChange({
				change: MERGED_UPDATE,
				stored: STORED,
				unchanged,
				reviewed: unchanged,
				undecidedBodyChanges: false,
			}),
		).toBeNull();
	});
});
