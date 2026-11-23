/**
 * ProposalDuplicateNote — an item whose duplicate check has no final answer
 * yet says so, with or without the confirmed matches found so far; an item
 * that is checked and matches nothing shows no note. A sibling in the same
 * proposal is offered the same resolutions as another proposal's item:
 * merge it into this item, or move it to Rejected, through the per-item
 * procedures; nothing runs until the reviewer picks one.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	rejectItem: vi.fn(),
	mergeIntoItem: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: {
				proposals: {
					rejectItem: h.rejectItem,
					mergeIntoItem: h.mergeIntoItem,
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProposalDuplicateNote } from "../ProposalDuplicateNote";
import type {
	ProposalDuplicateItemMatch,
	ProposalDuplicateMatch,
} from "../proposal-duplicate-flags";

const MATCH: ProposalDuplicateMatch = {
	kind: "story",
	storyId: "story-1",
	identifier: "F-12",
	title: "Export throttling",
	similarity: 0.82,
};

const SIBLING: ProposalDuplicateItemMatch = {
	kind: "proposal_item",
	proposalId: "prop-open",
	matchChangeIndex: 4,
	title: "Queue large exports",
	similarity: 0.93,
};

function renderNote(node: ReactNode) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			{node}
		</QueryClientProvider>,
	);
}

/** `null` renders an item with no change index: its proposal is not in review. */
function renderSiblingNote(changeIndex: number | null = 3) {
	return renderNote(
		<ProposalDuplicateNote
			matches={[SIBLING]}
			itemTitle="Queue exports"
			projectId="project_1"
			proposalId="prop-open"
			changeIndex={changeIndex ?? undefined}
			onOpenProposal={vi.fn()}
		/>,
	);
}

const note = () =>
	screen.getByRole("region", {
		name: "Possible duplicate of Queue exports",
	});

beforeEach(() => {
	vi.clearAllMocks();
	h.rejectItem.mockResolvedValue({ success: true });
	h.mergeIntoItem.mockResolvedValue({ id: "prop-open", changeIndex: 3 });
});

describe("ProposalDuplicateNote", () => {
	it("says the item is still being checked before any match is confirmed", () => {
		renderNote(
			<ProposalDuplicateNote
				matches={[]}
				checking
				itemTitle="Queue exports"
			/>,
		);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Still checking for possible duplicates",
		);
		expect(screen.queryByText("Possible duplicate")).toBeNull();
	});

	it("shows the confirmed matches and that more are still being checked", () => {
		renderNote(
			<ProposalDuplicateNote
				matches={[MATCH]}
				checking
				itemTitle="Queue exports"
			/>,
		);

		expect(screen.getByText("Export throttling")).toBeInTheDocument();
		expect(screen.getByText("82% similar")).toBeInTheDocument();
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("shows nothing for a checked item with no match", () => {
		const { container } = renderNote(
			<ProposalDuplicateNote matches={[]} itemTitle="Queue exports" />,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("offers merge and Move to Rejected for a sibling, and runs neither until one is chosen", () => {
		renderSiblingNote();

		expect(
			within(note()).getByText("Item 5 of this proposal"),
		).toBeInTheDocument();
		expect(
			within(note())
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["Merge into this item", "Move matched item to Rejected"]);
		// Proceeding leaves both items in review: nothing was called.
		expect(h.mergeIntoItem).not.toHaveBeenCalled();
		expect(h.rejectItem).not.toHaveBeenCalled();
	});

	it("merges the sibling into this item of the same proposal", async () => {
		const user = userEvent.setup();
		renderSiblingNote();

		await user.click(
			within(note()).getByRole("button", {
				name: "Merge the matched item Queue large exports into Queue exports",
			}),
		);

		// The server reads the sibling's text and moves it to Rejected.
		expect(h.mergeIntoItem).toHaveBeenCalledWith({
			projectId: "project_1",
			organizationId: null,
			proposalId: "prop-open",
			changeIndex: 3,
			source: { proposalId: "prop-open", changeIndex: 4 },
		});
		await waitFor(() =>
			expect(
				screen.queryByRole("region", {
					name: "Possible duplicate of Queue exports",
				}),
			).toBeNull(),
		);
		expect(toast.success).toHaveBeenCalledWith(
			"Merged “Queue large exports” into “Queue exports”",
			expect.anything(),
		);
	});

	it("moves the sibling to Rejected where it stands", async () => {
		const user = userEvent.setup();
		renderSiblingNote();

		await user.click(
			within(note()).getByRole("button", {
				name: "Move the matched item Queue large exports to Rejected",
			}),
		);

		expect(h.rejectItem).toHaveBeenCalledWith({
			projectId: "project_1",
			organizationId: null,
			proposalId: "prop-open",
			changeIndex: 4,
		});
		expect(h.mergeIntoItem).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				"Moved “Queue large exports” to Rejected",
				expect.anything(),
			),
		);
	});

	it("keeps the sibling in the note and says why when the merge is refused", async () => {
		const user = userEvent.setup();
		h.mergeIntoItem.mockRejectedValue(
			new Error(
				"The duplicate item was already approved or moved to Rejected. Refresh the inbox.",
			),
		);
		renderSiblingNote();

		await user.click(
			within(note()).getByRole("button", {
				name: "Merge the matched item Queue large exports into Queue exports",
			}),
		);

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"Couldn't merge “Queue large exports”",
				{
					description:
						"The duplicate item was already approved or moved to Rejected. Refresh the inbox.",
				},
			),
		);
		expect(note()).toBeInTheDocument();
	});

	it("offers no merge into an item whose proposal is not in review", () => {
		renderSiblingNote(null);

		expect(
			within(note()).queryByRole("button", {
				name: /^Merge the matched item/,
			}),
		).toBeNull();
	});
});
