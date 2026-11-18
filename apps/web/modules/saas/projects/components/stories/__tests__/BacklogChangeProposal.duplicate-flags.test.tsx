/**
 * BacklogChangeProposal — "Possible duplicate" notes in the Proposal Inbox.
 *
 * A flagged item shows what it may duplicate and how similar it is; an item
 * with no match shows nothing. "Use as Enrich target" re-routes the item to
 * enrich the matched ticket through the existing routing override, also on a
 * row that came without a routing annotation, and approving it then sends an
 * update of that ticket. "Open proposal" hands the other proposal's id up,
 * and "Move matched item to Rejected" rejects that item where it stands.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import {
	BacklogChangeProposal,
	type ChangeItem,
} from "../BacklogChangeProposal";
import type { ProposalDuplicateMatch } from "../proposal-duplicate-flags";
import type { LockedReason } from "../proposal-item-state";

const h = vi.hoisted(() => ({
	rejectItem: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: { proposals: { rejectItem: h.rejectItem } },
			stories: {
				checkPmSyncConflicts: vi
					.fn()
					.mockResolvedValue({ results: [] }),
				retryPmSyncBatch: vi.fn(),
				reformatProposalBody: vi
					.fn()
					.mockResolvedValue({ aiDrafted: false }),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				board: {
					queryOptions: (opts: Record<string, unknown>) => ({
						queryKey: ["stories.board", opts],
						queryFn: async () => ({ statuses: [], stories: [] }),
					}),
				},
				previewEnrichment: {
					queryOptions: (opts: Record<string, unknown>) => ({
						queryKey: ["stories.previewEnrichment", opts],
						queryFn: async () => null,
					}),
				},
			},
		},
	},
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	useBasePath: () => "/app/example-org",
}));

if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}

function feature(title: string): ChangeItem {
	return {
		type: "feature",
		action: "create",
		title: { to: title },
		description: { to: `${title}, described.` },
		reasoning: "Test fixture",
		sourceContext: "teams_messages",
	};
}

const CHANGES = [feature("Alpha"), feature("Bravo"), feature("Charlie")];

const STORY_MATCH: ProposalDuplicateMatch = {
	kind: "story",
	storyId: "story-1",
	identifier: "F-12",
	title: "Export throttling",
	similarity: 0.912,
};

function renderWithFlags(
	flags: Map<number, ProposalDuplicateMatch[]>,
	lockedReasons: ReadonlyMap<number, LockedReason> = new Map(),
) {
	const onApproveItem = vi.fn();
	const onOpenProposal = vi.fn();
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<BacklogChangeProposal
				panel="feature-proposals"
				summary="Captured from a channel"
				contextSummary="Weekly planning"
				changes={CHANGES}
				hasPMTool={false}
				projectId="project_1"
				proposalId="prop-open"
				proposalStatus="PENDING"
				onApprove={vi.fn()}
				onReject={vi.fn()}
				onBacklog={vi.fn()}
				itemReview={{
					lockedReasons,
					onApproveItem,
					onRejectItem: vi.fn(),
					duplicateFlags: flags,
					onOpenProposal,
				}}
			/>
		</QueryClientProvider>,
	);
	return { onApproveItem, onOpenProposal };
}

const OTHER_PROPOSAL_ITEM: ProposalDuplicateMatch = {
	kind: "proposal_item",
	proposalId: "prop-other",
	matchChangeIndex: 0,
	title: "Bravo again",
	similarity: 0.75,
};

const noteFor = (title: string) =>
	screen.getByRole("region", { name: `Possible duplicate of ${title}` });

describe("BacklogChangeProposal — possible duplicates", () => {
	it("flags only the matched item, with the match and its similarity", () => {
		renderWithFlags(new Map([[0, [STORY_MATCH]]]));

		const note = noteFor("Alpha");
		expect(within(note).getByText("F-12")).toBeInTheDocument();
		expect(within(note).getByText("Export throttling")).toBeInTheDocument();
		expect(within(note).getByText("91% similar")).toBeInTheDocument();
		expect(
			within(note).getByRole("link", { name: "Open F-12 in a new tab" }),
		).toHaveAttribute("target", "_blank");
		expect(
			screen.queryByRole("region", {
				name: "Possible duplicate of Bravo",
			}),
		).toBeNull();
	});

	it("shows no note on a resolved item", () => {
		renderWithFlags(
			new Map([[0, [STORY_MATCH]]]),
			new Map<number, LockedReason>([[0, "applied"]]),
		);

		expect(
			screen.queryByRole("region", {
				name: "Possible duplicate of Alpha",
			}),
		).toBeNull();
	});

	it("re-routes the item to enrich the matched ticket and approves it as an update", async () => {
		const user = userEvent.setup();
		const { onApproveItem } = renderWithFlags(
			new Map([[0, [STORY_MATCH]]]),
		);

		await user.click(
			within(noteFor("Alpha")).getByRole("button", {
				name: "Enrich F-12 with Alpha instead of creating a new ticket",
			}),
		);

		expect(
			within(noteFor("Alpha")).getByText("Enrich target"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Approve Alpha" }));

		expect(onApproveItem).toHaveBeenCalledOnce();
		const [change, , , index] = onApproveItem.mock.calls[0] as [
			ChangeItem,
			boolean,
			unknown,
			number,
		];
		expect(index).toBe(0);
		expect(change.action).toBe("update");
		expect(change.existingId).toBe("story-1");
		expect(change.existingIdentifier).toBe("F-12");
		expect(change.description?.to).toBe("Alpha, described.");
	});

	it("tells a sibling in the same proposal apart, and opens another proposal on request", async () => {
		const user = userEvent.setup();
		const { onOpenProposal } = renderWithFlags(
			new Map([
				[
					1,
					[
						{
							kind: "proposal_item",
							proposalId: "prop-open",
							matchChangeIndex: 2,
							title: "Charlie",
							similarity: 0.8,
						},
						OTHER_PROPOSAL_ITEM,
					],
				],
			]),
		);

		const note = noteFor("Bravo");
		expect(
			within(note).getByText("Item 3 of this proposal"),
		).toBeInTheDocument();
		// Both actions belong to the other proposal's item; the sibling
		// has none.
		expect(
			within(note)
				.getAllByRole("button")
				.map((button) => button.getAttribute("aria-label")),
		).toEqual([
			"Open the proposal with Bravo again",
			"Move the matched item Bravo again to Rejected",
		]);

		await user.click(
			within(note).getByRole("button", {
				name: "Open the proposal with Bravo again",
			}),
		);

		expect(onOpenProposal).toHaveBeenCalledWith("prop-other");
	});

	it("moves another proposal's matched item to Rejected and drops it from the note", async () => {
		const user = userEvent.setup();
		renderWithFlags(new Map([[1, [OTHER_PROPOSAL_ITEM]]]));

		await user.click(
			within(noteFor("Bravo")).getByRole("button", {
				name: "Move the matched item Bravo again to Rejected",
			}),
		);

		expect(h.rejectItem).toHaveBeenCalledWith({
			projectId: "project_1",
			organizationId: null,
			proposalId: "prop-other",
			changeIndex: 0,
		});
		await waitFor(() =>
			expect(
				screen.queryByRole("region", {
					name: "Possible duplicate of Bravo",
				}),
			).toBeNull(),
		);
		expect(toast.success).toHaveBeenCalledWith(
			"Moved “Bravo again” to Rejected",
			expect.anything(),
		);
	});

	it("shows a judge-confirmed match below 70% like any other", () => {
		renderWithFlags(new Map([[0, [{ ...STORY_MATCH, similarity: 0.55 }]]]));

		const note = noteFor("Alpha");
		expect(within(note).getByText("55% similar")).toBeInTheDocument();
		expect(
			within(note).getByRole("button", {
				name: "Enrich F-12 with Alpha instead of creating a new ticket",
			}),
		).toBeEnabled();
	});

	it("says the item is merged at apply once it is re-routed to the matched ticket", async () => {
		const user = userEvent.setup();
		renderWithFlags(new Map([[0, [STORY_MATCH]]]));
		expect(
			screen.queryByText(/merged into the ticket when applied/),
		).toBeNull();

		await user.click(
			within(noteFor("Alpha")).getByRole("button", {
				name: "Enrich F-12 with Alpha instead of creating a new ticket",
			}),
		);

		expect(
			screen.getByText(
				"The proposal is merged into the ticket when applied; the changes are listed after apply.",
			),
		).toBeInTheDocument();
	});
});
