/**
 * useProposalTicketReview — Apply on the ticket page approves only the
 * changes the reviewer accepted, and changes the editor only once the
 * approval succeeds: a refused or failed Apply leaves every undecided
 * change in place to review, and an Apply with nothing to write neither
 * approves nor rejects the item.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MOVED_BLOCKS_AFTER,
	MOVED_BLOCKS_BEFORE,
} from "../../../lib/__tests__/moved-list-block-fixtures";
import { fromMarkdown } from "../../../lib/diff-utils";
import {
	acceptAllChanges,
	acceptChange,
	type DiffRange,
	editorHoldsDiffMarks,
	findDiffRanges,
	rejectAllChanges,
	rejectChange,
} from "../../../lib/editor-diff-marks";
import { getEditorMarkdownForSave } from "../../../lib/editor-markdown-save";
import { formatStoredStoryContent } from "../../../lib/story-content";
import { advancedExtensions } from "../../../lib/tiptap-extensions-advanced";
import type { ChangeItem } from "../BacklogChangeProposal";
import {
	endProposalTicketReview,
	startProposalTicketReview,
} from "../proposal-ticket-review";
import { useProposalTicketReview } from "../useProposalTicketReview";

const mocks = vi.hoisted(() => ({
	getProposal: vi.fn(),
	rejectItem: vi.fn(),
	approve: vi.fn(),
	diffPartialText: vi.fn(),
	getEditorMarkdownForSave: vi.fn(),
}));

vi.mock("../../../lib/editor-markdown-save", async () => {
	const actual = await vi.importActual<
		typeof import("../../../lib/editor-markdown-save")
	>("../../../lib/editor-markdown-save");
	mocks.getEditorMarkdownForSave.mockImplementation(
		actual.getEditorMarkdownForSave,
	);
	return {
		...actual,
		getEditorMarkdownForSave: mocks.getEditorMarkdownForSave,
	};
});

vi.mock("../../../lib/diff-utils", async () => {
	const actual = await vi.importActual<
		typeof import("../../../lib/diff-utils")
	>("../../../lib/diff-utils");
	mocks.diffPartialText.mockImplementation(actual.diffPartialText);
	return { ...actual, diffPartialText: mocks.diffPartialText };
});

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			teamsChannelMonitor: {
				pendingProposals: { get: mocks.getProposal },
			},
			backlog: { proposals: { rejectItem: mocks.rejectItem } },
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("../proposal-inbox-client", async () => ({
	...(await vi.importActual<Record<string, unknown>>(
		"../proposal-inbox-client",
	)),
	requestProposalApproval: mocks.approve,
	invalidateProposalInboxQueries: vi.fn(),
}));

const STORED = "First old.\n\nSecond old.";

const STORY = {
	id: "story-7",
	description: STORED,
	acceptanceCriteria: "",
};

const CHANGE: ChangeItem = {
	type: "feature",
	action: "update",
	existingId: "story-7",
	existingIdentifier: "F-7",
	title: { from: "Bravo", to: "Bravo" },
	description: { from: STORED, to: "First new.\n\nSecond new." },
	structurePreserved: true,
	reasoning: "Raised in planning",
	sourceContext: "teams_messages",
};

const editors: Editor[] = [];

type Ticket = typeof STORY;

function ticketEditor(story: Ticket): Editor {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: advancedExtensions,
		content: fromMarkdown(
			formatStoredStoryContent({
				description: story.description,
				acceptanceCriteria: story.acceptanceCriteria,
			}),
			{ repairLegacyBullets: false },
		),
	});
	editors.push(editor);
	return editor;
}

/** Open the review of `change` on its ticket, and wait for its diff. */
async function openReview(story: Ticket = STORY, change: ChangeItem = CHANGE) {
	startProposalTicketReview({
		projectId: "project_1",
		organizationId: null,
		storyId: STORY.id,
		proposalId: "proposal_1",
		source: "SLACK_CHANNEL",
		changeIndex: 0,
		change,
		syncToPM: false,
	});
	const editor = ticketEditor(story);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
	const hook = renderHook(
		() =>
			useProposalTicketReview({
				story,
				editor,
				enabled: true,
				basePath: "/app/example-org",
				isSyncingFromPropRef: { current: false },
				onTicketChanged: vi.fn(),
			}),
		{ wrapper },
	);
	await waitFor(() => expect(hook.result.current.showingDiff).toBe(true));
	return { editor, result: hook.result };
}

/** A change still undecided in the editor's first paragraph. */
function firstParagraphChange(editor: Editor): DiffRange | undefined {
	const end = editor.state.doc.child(0).nodeSize;
	return findDiffRanges(editor.state.doc).find((range) => range.to <= end);
}

/** Accept every change of the first paragraph, leave the second undecided. */
function acceptFirstParagraph(editor: Editor): void {
	let change = firstParagraphChange(editor);
	while (change) {
		acceptChange(editor, change);
		change = firstParagraphChange(editor);
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getProposal.mockResolvedValue({
		status: "PENDING",
		resolvedItems: [],
	});
});

afterEach(() => {
	endProposalTicketReview();
	window.sessionStorage.clear();
	for (const editor of editors.splice(0)) {
		editor.destroy();
	}
});

describe("useProposalTicketReview — Apply", () => {
	it.each([
		{
			outcome: "refused",
			arrange: () =>
				mocks.approve.mockResolvedValue({
					status: "failed",
					errors: ["Refused"],
				}),
		},
		{
			outcome: "failed",
			arrange: () => mocks.approve.mockRejectedValue(new Error("down")),
		},
	])(
		"keeps every undecided change when the approval is $outcome",
		async ({ arrange }) => {
			arrange();
			const { editor, result } = await openReview();
			acceptFirstParagraph(editor);
			const before = editor.getJSON();

			await act(async () => {
				await result.current.apply();
			});

			expect(mocks.approve).toHaveBeenCalledOnce();
			expect(editor.getJSON()).toEqual(before);
			expect(editorHoldsDiffMarks(editor.state.doc)).toBe(true);
			expect(result.current.showingDiff).toBe(true);
			expect(result.current.isApplying).toBe(false);
		},
	);

	it("approves only the accepted change, then shows the applied ticket", async () => {
		mocks.approve.mockResolvedValue({ status: "applied" });
		const { editor, result } = await openReview();
		acceptFirstParagraph(editor);

		await act(async () => {
			await result.current.apply();
		});

		const [request] = mocks.approve.mock.calls[0] ?? [];
		expect(request.approvedChanges[0].description.to).toContain(
			"First new.",
		);
		expect(request.approvedChanges[0].description.to).toContain(
			"Second old.",
		);
		expect(editorHoldsDiffMarks(editor.state.doc)).toBe(false);
		expect(getEditorMarkdownForSave(editor)).not.toContain("Second new.");
	});

	it("neither approves nor rejects the item when nothing was accepted", async () => {
		const { editor, result } = await openReview();

		expect(result.current.canApply()).toBe(false);
		await act(async () => {
			await result.current.apply();
		});

		expect(mocks.approve).not.toHaveBeenCalled();
		expect(mocks.rejectItem).not.toHaveBeenCalled();
		expect(toast.info).toHaveBeenCalledWith(
			"Accept at least one change to apply it.",
			expect.anything(),
		);
		expect(editorHoldsDiffMarks(editor.state.doc)).toBe(true);
	});

	it("finds nothing to apply when nothing was accepted on a ticket that repeats its criteria", async () => {
		// The criteria column holds the same section twice, which the save
		// stores once: reading the untouched ticket any other way makes that
		// look like a change nobody was shown.
		const { result } = await openReview({
			...STORY,
			acceptanceCriteria: "- AC 1\n\n## Acceptance Criteria\n\n- AC 1",
		});

		expect(result.current.canApply()).toBe(false);
		await act(async () => {
			await result.current.apply();
		});

		expect(mocks.approve).not.toHaveBeenCalled();
		expect(mocks.rejectItem).not.toHaveBeenCalled();
		expect(toast.info).toHaveBeenCalledWith(
			"Accept at least one change to apply it.",
			expect.anything(),
		);
	});

	it("finds nothing to apply when the only change, a parent line added over nested lines, is undecided", async () => {
		// The nested lines keep their depth, so the diff leaves them unmarked:
		// without the new line they stay under "Scope", as on the ticket.
		const ticket = "- Scope\n  - Export CSV\n  - Export PDF";
		const { editor, result } = await openReview(
			{ ...STORY, description: ticket },
			{
				...CHANGE,
				description: {
					from: ticket,
					to: "- Scope\n- Formats\n  - Export CSV\n  - Export PDF",
				},
			},
		);

		expect(findDiffRanges(editor.state.doc)).toHaveLength(1);
		expect(result.current.canApply()).toBe(false);
	});

	describe.each([
		{
			block: "a heading",
			ticket: "## Steps\n\n- a\n- b\n\nNotes follow.",
			proposed: "## Next\n\n- A\n  - b\n\nNotes follow.",
		},
		{
			block: "a quote",
			ticket: "- p\n- step\n  > Note: careful\n\nNotes follow.",
			proposed: "- p\n  - step\n    > Note: careful\n\nNotes follow.",
		},
	])("a moved block holding $block", ({ ticket, proposed }) => {
		const open = () =>
			openReview(
				{ ...STORY, description: ticket },
				{ ...CHANGE, description: { from: ticket, to: proposed } },
			);

		it("finds nothing to apply while it is undecided", async () => {
			const { result } = await open();

			expect(result.current.canApply()).toBe(false);
		});

		it("finds nothing to apply once Reject all took it back", async () => {
			const { editor, result } = await open();

			rejectAllChanges(editor);

			expect(result.current.canApply()).toBe(false);
		});

		it("can apply once Accept all took it", async () => {
			const { editor, result } = await open();

			acceptAllChanges(editor);

			expect(result.current.canApply()).toBe(true);
		});
	});

	it("applies nothing from a review whose changes could not be marked", async () => {
		mocks.diffPartialText.mockImplementationOnce(() => {
			throw new Error("The marks break a table");
		});
		mocks.approve.mockResolvedValue({ status: "applied" });
		const { editor, result } = await openReview();

		// The proposed text is shown whole, with nothing to accept in it.
		expect(result.current.lineByLineUnavailable).toBe(true);
		expect(getEditorMarkdownForSave(editor)).toContain("Second new.");
		expect(editorHoldsDiffMarks(editor.state.doc)).toBe(false);
		expect(result.current.canApply()).toBe(false);
		await act(async () => {
			await result.current.apply();
		});

		expect(mocks.approve).not.toHaveBeenCalled();
		expect(mocks.rejectItem).not.toHaveBeenCalled();
	});

	it("says line-by-line review is unavailable when the marked document can't be read", async () => {
		// Read when the review starts: without it no Apply could ever tell
		// what was accepted, and the review would wait on an Apply that never
		// works.
		mocks.getEditorMarkdownForSave.mockImplementationOnce(() => null);
		const { editor, result } = await openReview();

		expect(result.current.lineByLineUnavailable).toBe(true);
		expect(editorHoldsDiffMarks(editor.state.doc)).toBe(false);
		expect(result.current.canApply()).toBe(false);
		await act(async () => {
			await result.current.apply();
		});

		expect(mocks.approve).not.toHaveBeenCalled();
		expect(mocks.rejectItem).not.toHaveBeenCalled();
	});

	it("can apply once a change is accepted", async () => {
		const { editor, result } = await openReview();

		acceptFirstParagraph(editor);

		expect(result.current.canApply()).toBe(true);
	});

	it("applies nothing when nothing was decided on a ticket whose moved items hold tables", async () => {
		// A live check: this Apply wrote the update, its tables taken out of
		// their items and an emptied table added.
		const ticket = { ...STORY, description: MOVED_BLOCKS_BEFORE };
		const { result } = await openReview(ticket, {
			...CHANGE,
			description: { from: MOVED_BLOCKS_BEFORE, to: MOVED_BLOCKS_AFTER },
		});

		expect(result.current.canApply()).toBe(false);
		await act(async () => {
			await result.current.apply();
		});

		expect(mocks.approve).not.toHaveBeenCalled();
	});

	it("writes three accepted moves and leaves every undecided line as it was", async () => {
		// A live check: this Apply wrote the editor's reading of the whole
		// ticket, with loose lists, a blank line after each heading and the
		// HTML table as a Markdown table with its data row for a header.
		mocks.approve.mockResolvedValue({ status: "applied" });
		const fence = "```";
		const moves = [
			{
				holding: "Run the installer",
				before: `  - Run the installer:\n    ${fence}bash\n    pnpm install\n    ${fence}`,
				after: `- Run the installer:\n  ${fence}bash\n  pnpm install\n  ${fence}`,
			},
			{
				holding: "Add the summary section",
				before: "  - Add the summary section\n    ### Summary heading\n    > A quoted tip for readers.",
				after: "- Add the summary section\n  ### Summary heading\n  > A quoted tip for readers.",
			},
			{
				holding: "Plan table",
				before: "  - Plan table\n    | Plan | Price |\n    | --- | --- |\n    | Basic | 5 |",
				after: "- Plan table\n  | Plan | Price |\n  | --- | --- |\n  | Basic | 5 |",
			},
		];
		const { editor, result } = await openReview(
			{ ...STORY, description: MOVED_BLOCKS_BEFORE },
			{
				...CHANGE,
				description: {
					from: MOVED_BLOCKS_BEFORE,
					to: MOVED_BLOCKS_AFTER,
				},
			},
		);
		for (const move of moves) {
			const range = findDiffRanges(editor.state.doc).find(
				(candidate) =>
					candidate.moved !== undefined &&
					editor.state.doc
						.textBetween(candidate.from, candidate.to, "\n")
						.includes(move.holding),
			);
			expect(range).toBeDefined();
			if (range) {
				acceptChange(editor, range);
			}
		}

		await act(async () => {
			await result.current.apply();
		});

		let expected = MOVED_BLOCKS_BEFORE;
		for (const move of moves) {
			expected = expected.replace(move.before, move.after);
		}
		const [request] = mocks.approve.mock.calls[0] ?? [];
		expect(request.approvedChanges[0].description.to).toBe(expected);
		expect(request.approvedChanges[0].description.to).toContain(
			"<table><tr><td>Pro</td><td>9</td></tr></table>",
		);
	});

	describe("the item's fields outside the editor", () => {
		const FIELDS = {
			size: { to: "S" },
			priority: { from: "P3_LOW", to: "P2_MEDIUM" },
		};

		it("apply nothing while no body change is accepted", async () => {
			// A live check: this Apply set the size, with nothing decided.
			const { result } = await openReview(STORY, {
				...CHANGE,
				...FIELDS,
			});

			expect(result.current.canApply()).toBe(false);
			await act(async () => {
				await result.current.apply();
			});

			expect(mocks.approve).not.toHaveBeenCalled();
		});

		it("apply alone once every body change is rejected", async () => {
			// A reviewer who keeps the fields and rejects the body is not left
			// with Reject all, which drops the fields too.
			mocks.approve.mockResolvedValue({ status: "applied" });
			const { editor, result } = await openReview(STORY, {
				...CHANGE,
				...FIELDS,
			});

			rejectAllChanges(editor);

			expect(result.current.canApply()).toBe(true);
			await act(async () => {
				await result.current.apply();
			});

			const [request] = mocks.approve.mock.calls[0] ?? [];
			expect(request.approvedChanges[0]).toMatchObject(FIELDS);
			expect(request.approvedChanges[0].description).toBeUndefined();
		});

		it("apply nothing while a body change is still undecided and none is accepted", async () => {
			const { editor, result } = await openReview(STORY, {
				...CHANGE,
				...FIELDS,
			});
			const [first] = findDiffRanges(editor.state.doc);
			if (!first) {
				throw new Error("no change to reject");
			}

			rejectChange(editor, first);

			expect(editorHoldsDiffMarks(editor.state.doc)).toBe(true);
			expect(result.current.canApply()).toBe(false);
		});

		it("apply with an accepted body change", async () => {
			mocks.approve.mockResolvedValue({ status: "applied" });
			const { editor, result } = await openReview(STORY, {
				...CHANGE,
				...FIELDS,
			});
			acceptFirstParagraph(editor);

			await act(async () => {
				await result.current.apply();
			});

			const [request] = mocks.approve.mock.calls[0] ?? [];
			expect(request.approvedChanges[0]).toMatchObject(FIELDS);
		});

		it("apply on their own when the update changes no body", async () => {
			const { editor, result } = await openReview(STORY, {
				...CHANGE,
				description: undefined,
				...FIELDS,
			});

			expect(editorHoldsDiffMarks(editor.state.doc)).toBe(false);
			expect(result.current.canApply()).toBe(true);
		});
	});
});
