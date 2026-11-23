/**
 * BacklogChangeProposal — per-item decisions in the Proposal Inbox.
 *
 * Each unresolved item of a pending proposal can be approved, or moved to
 * Rejected, on its own, from its row or from its detail dialog. Resolved
 * items are locked: they show what happened to them, link to their ticket,
 * leave the selection and offer no further action.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	BacklogChangeProposal,
	type ChangeItem,
} from "../BacklogChangeProposal";
import type { LockedReason } from "../proposal-item-state";
import type { ProposalItemReview } from "../useProposalItemReview";

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
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

const h = vi.hoisted(() => ({ trackEvent: vi.fn() }));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: h.trackEvent }),
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

function feature(title: string, overrides: Partial<ChangeItem> = {}) {
	const change: ChangeItem = {
		type: "feature",
		action: "create",
		title: { to: title },
		description: { to: `${title}, described.` },
		reasoning: "Test fixture",
		sourceContext: "teams_messages",
		...overrides,
	};
	return change;
}

const CHANGES = [feature("Alpha"), feature("Bravo"), feature("Charlie")];

/** Item `index` resolved for `reason`. */
function locked(index: number, reason: LockedReason) {
	return new Map<number, LockedReason>([[index, reason]]);
}

function renderInboxProposal(
	props: Partial<React.ComponentProps<typeof BacklogChangeProposal>> = {},
	review: Partial<ProposalItemReview> = {},
) {
	const onApprove = vi.fn();
	const onApproveItem = vi.fn();
	const onRejectItem = vi.fn();
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const element = (extraReview: Partial<ProposalItemReview>) => (
		<QueryClientProvider client={queryClient}>
			<BacklogChangeProposal
				panel="feature-proposals"
				summary="Captured from a channel"
				contextSummary="Weekly planning"
				changes={CHANGES}
				hasPMTool={false}
				projectId="project_1"
				proposalStatus="PENDING"
				onApprove={onApprove}
				onReject={vi.fn()}
				onBacklog={vi.fn()}
				{...props}
				itemReview={{
					lockedReasons: new Map(),
					onApproveItem,
					onRejectItem,
					...review,
					...extraReview,
				}}
			/>
		</QueryClientProvider>
	);
	const utils = render(element({}));
	return {
		...utils,
		onApprove,
		onApproveItem,
		onRejectItem,
		rerenderWith: (extraReview: Partial<ProposalItemReview>) =>
			utils.rerender(element(extraReview)),
	};
}

describe("BacklogChangeProposal — per-item actions", () => {
	it("offers Approve and Move to Rejected on every unresolved item, named after it", () => {
		renderInboxProposal({}, { lockedReasons: locked(1, "applied") });
		for (const title of ["Alpha", "Charlie"]) {
			expect(
				screen.getByRole("button", { name: `Approve ${title}` }),
			).toBeEnabled();
			expect(
				screen.getByRole("button", {
					name: `Move ${title} to Rejected`,
				}),
			).toBeEnabled();
		}
		expect(
			screen.queryByRole("button", { name: "Approve Bravo" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Move Bravo to Rejected" }),
		).toBeNull();
	});

	it.each(["BACKLOG", "APPLYING"] as const)(
		"offers no per-item action on a %s proposal",
		(proposalStatus) => {
			renderInboxProposal({ proposalStatus });
			expect(
				screen.queryByRole("button", { name: "Approve Alpha" }),
			).toBeNull();
		},
	);

	it("offers per-item actions on a FAILED proposal, which stays in review", () => {
		renderInboxProposal({ proposalStatus: "FAILED" });
		expect(
			screen.getByRole("button", { name: "Approve Alpha" }),
		).toBeInTheDocument();
	});

	it("approves only that item, with its own kind choice and index", async () => {
		const user = userEvent.setup();
		const { onApproveItem, onApprove } = renderInboxProposal();
		const group = screen.getByRole("radiogroup", {
			name: 'Work item type for "Bravo"',
		});
		await user.click(within(group).getByRole("radio", { name: "Bug" }));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Approve Bravo" }),
			).toBeEnabled(),
		);

		await user.click(screen.getByRole("button", { name: "Approve Bravo" }));

		expect(onApprove).not.toHaveBeenCalled();
		expect(onApproveItem).toHaveBeenCalledOnce();
		const [change, syncToPM, overrides, index] = onApproveItem.mock
			.calls[0] as [ChangeItem, boolean, unknown, number];
		expect(change.title.to).toBe("Bravo");
		expect(change.kindOverride).toBe("BUG");
		expect(syncToPM).toBe(false);
		expect(overrides).toBeUndefined();
		expect(index).toBe(1);
	});

	it("moves only that item to Rejected", async () => {
		const user = userEvent.setup();
		const { onRejectItem } = renderInboxProposal();
		await user.click(
			screen.getByRole("button", { name: "Move Charlie to Rejected" }),
		);
		expect(onRejectItem).toHaveBeenCalledWith(2, "Charlie");
	});

	it("blocks Approve only on the item whose routing is unfinished", async () => {
		const user = userEvent.setup();
		renderInboxProposal({
			changes: [
				feature("Alpha", {
					routing: {
						decision: "create",
						confidence: 0.9,
						proposedTitle: "Alpha",
						alternatives: [],
					},
				}),
				feature("Bravo"),
			],
		});
		await user.click(
			screen.getByRole("button", { name: "Enrich existing" }),
		);

		const blocked = screen.getByRole("button", { name: "Approve Alpha" });
		expect(blocked).toBeDisabled();
		expect(blocked).toHaveAccessibleDescription(
			"Choose a ticket to enrich before approving this item.",
		);
		expect(
			screen.getByRole("button", { name: "Approve Bravo" }),
		).toBeEnabled();
	});

	it("disables every action while the parent has one in flight", () => {
		renderInboxProposal(
			{ actionsBusy: true },
			{ pendingItemAction: { changeIndex: 0, action: "approve" } },
		);
		expect(
			screen.getByRole("button", { name: "Approve Alpha" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Move Bravo to Rejected" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /Apply Selected/ }),
		).toBeDisabled();
	});
});

describe("BacklogChangeProposal — resolved items", () => {
	it("shows an applied item with a new-tab link to its ticket", () => {
		renderInboxProposal(
			{},
			{
				lockedReasons: locked(0, "applied"),
				lockedTargets: new Map([[0, "story-alpha"]]),
			},
		);
		expect(screen.getByText("Applied")).toBeInTheDocument();
		const link = screen.getByRole("link", {
			name: "Open the ticket for Alpha in a new tab",
		});
		expect(link).toHaveAttribute(
			"href",
			"/app/example-org/projects/project_1/stories/story-alpha",
		);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		expect(
			screen.getByRole("checkbox", { name: "Alpha (already applied)" }),
		).toBeDisabled();
	});

	it("shows an item moved to Rejected without a link", () => {
		renderInboxProposal({}, { lockedReasons: locked(2, "rejected") });
		expect(screen.getByText("Moved to Rejected")).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", {
				name: "Charlie (moved to Rejected)",
			}),
		).toBeDisabled();
		expect(
			screen.queryByRole("link", { name: /Open the ticket for Charlie/ }),
		).toBeNull();
	});

	it("shows an item restored from Rejected with a link to the ticket it created", () => {
		renderInboxProposal(
			{},
			{
				lockedReasons: locked(2, "restored"),
				lockedTargets: new Map([[2, "story-charlie"]]),
			},
		);
		expect(screen.getByText("Restored from Rejected")).toBeInTheDocument();
		expect(screen.queryByText("Moved to Rejected")).toBeNull();
		expect(
			screen.getByRole("checkbox", {
				name: "Charlie (restored from Rejected)",
			}),
		).toBeDisabled();
		expect(
			screen.getByRole("link", {
				name: "Open the ticket for Charlie in a new tab",
			}),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/project_1/stories/story-charlie",
		);
	});

	it("shows a restored update whose restore wrote no ticket as restored, not as proposed and applied", () => {
		renderInboxProposal(
			{
				changes: [
					feature("Alpha"),
					feature("Bravo"),
					feature("Charlie", {
						action: "update",
						existingId: "story-charlie",
						existingIdentifier: "12",
						description: {
							from: "Charlie, as it was.",
							to: "Charlie, described.",
						},
					}),
				],
			},
			{ lockedReasons: locked(2, "restored") },
		);
		expect(screen.getByText("Restored from Rejected")).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /Open the ticket for Charlie/ }),
		).toBeNull();
		expect(screen.queryByText("As proposed")).toBeNull();
		expect(
			screen.queryByText(/recorded in the ticket's Decision Log/),
		).toBeNull();
	});

	it("drops an item resolved while open from the selection, keeping its siblings' choices", async () => {
		const user = userEvent.setup();
		const { rerenderWith } = renderInboxProposal();
		// The reviewer unchecks Charlie, then approves Alpha on its own.
		await user.click(
			screen.getByRole("checkbox", { name: "Toggle Charlie" }),
		);
		expect(
			screen.getByRole("button", { name: "Apply Selected (2/3)" }),
		).toBeInTheDocument();

		rerenderWith({ lockedReasons: locked(0, "applied") });

		expect(
			await screen.findByRole("button", { name: "Apply Selected (1/3)" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: "Toggle Bravo" }),
		).toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: "Toggle Charlie" }),
		).not.toBeChecked();
	});

	it("moves focus to the next open item's Approve after a keyboard approve", async () => {
		const user = userEvent.setup();
		const { onApproveItem, rerenderWith } = renderInboxProposal();
		screen.getByRole("button", { name: "Approve Alpha" }).focus();
		await user.keyboard("{Enter}");
		expect(onApproveItem).toHaveBeenCalledOnce();

		rerenderWith({ lockedReasons: locked(0, "applied") });

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Approve Bravo" }),
			).toHaveFocus(),
		);
	});

	it("moves focus to the nearest earlier open item when the last one is moved to Rejected", async () => {
		const user = userEvent.setup();
		const { rerenderWith } = renderInboxProposal();
		screen
			.getByRole("button", { name: "Move Charlie to Rejected" })
			.focus();
		await user.keyboard("{Enter}");

		rerenderWith({ lockedReasons: locked(2, "rejected") });

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Approve Bravo" }),
			).toHaveFocus(),
		);
	});
});

describe("BacklogChangeProposal — the detail dialog commits one item", () => {
	it("approves the open item at once instead of toggling the selection", async () => {
		const user = userEvent.setup();
		const { onApproveItem } = renderInboxProposal();
		const [, bravoDetail] = screen.getAllByRole("button", {
			name: /Open full detail to review/,
		});
		if (!bravoDetail) {
			throw new Error("no detail button for Bravo");
		}
		await user.click(bravoDetail);

		const dialog = await screen.findByTestId(
			"backlog-change-detail-dialog",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Approve Bravo" }),
		);

		expect(onApproveItem).toHaveBeenCalledOnce();
		expect(onApproveItem.mock.calls[0]?.[3]).toBe(1);
	});

	it("moves the open item to Rejected at once", async () => {
		const user = userEvent.setup();
		const { onRejectItem } = renderInboxProposal();
		const [alphaDetail] = screen.getAllByRole("button", {
			name: /Open full detail to review/,
		});
		if (!alphaDetail) {
			throw new Error("no detail button for Alpha");
		}
		await user.click(alphaDetail);

		const dialog = await screen.findByTestId(
			"backlog-change-detail-dialog",
		);
		await user.click(
			within(dialog).getByRole("button", {
				name: "Move Alpha to Rejected",
			}),
		);

		expect(onRejectItem).toHaveBeenCalledWith(0, "Alpha");
	});

	it("shows a resolved item's outcome and offers no decision", async () => {
		const user = userEvent.setup();
		renderInboxProposal(
			{},
			{
				lockedReasons: locked(0, "applied"),
				lockedTargets: new Map([[0, "story-alpha"]]),
			},
		);
		const [alphaDetail] = screen.getAllByRole("button", {
			name: /Open full detail to review/,
		});
		if (!alphaDetail) {
			throw new Error("no detail button for Alpha");
		}
		await user.click(alphaDetail);

		const dialog = await screen.findByTestId(
			"backlog-change-detail-dialog",
		);
		expect(within(dialog).getByText("Applied")).toBeInTheDocument();
		expect(
			within(dialog).getByRole("link", {
				name: "Open the ticket for Alpha in a new tab",
			}),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/project_1/stories/story-alpha",
		);
		expect(
			within(dialog).queryByRole("button", { name: /^Approve/ }),
		).toBeNull();
		expect(
			within(dialog).queryByRole("button", { name: /to Rejected$/ }),
		).toBeNull();
	});
});

describe("BacklogChangeProposal — reviewing an update", () => {
	// Already merged at analysis, so its body can be reviewed line by line.
	const UPDATE = feature("Delta", {
		action: "update",
		existingId: "story-delta",
		existingIdentifier: "F-4",
		title: { from: "Delta draft", to: "Delta" },
		description: { from: "Line one", to: "Line one\nLine two" },
		reasoning: "Raised in planning",
		structurePreserved: true,
	});

	it("summarizes the update on its row and applies it all at once", async () => {
		const user = userEvent.setup();
		const { onApproveItem } = renderInboxProposal(
			{ changes: [UPDATE] },
			{ onReviewOnTicket: vi.fn() },
		);

		const summary = screen.getByTestId("proposal-update-summary");
		expect(
			within(summary).getByText(/Renamed “Delta draft” → “Delta”/),
		).toBeInTheDocument();
		expect(within(summary).getByText(/1 line added/)).toBeInTheDocument();
		expect(
			within(summary).getByText(/Raised in planning/),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Apply all changes to Delta" }),
		);

		const [change, , , index] = onApproveItem.mock.calls[0] as [
			ChangeItem,
			boolean,
			unknown,
			number,
		];
		expect(change.description?.to).toBe("Line one\nLine two");
		expect(index).toBe(0);
	});

	it("reads Apply accepted changes on the row once a proposed field is rejected", async () => {
		const user = userEvent.setup();
		renderInboxProposal(
			{ changes: [UPDATE] },
			{ onReviewOnTicket: vi.fn() },
		);

		const [detail] = screen.getAllByRole("button", {
			name: /Open full detail to review/,
		});
		if (!detail) {
			throw new Error("no detail button for Delta");
		}
		await user.click(detail);
		const dialog = await screen.findByTestId(
			"backlog-change-detail-dialog",
		);
		await user.click(
			within(dialog).getByRole("button", {
				name: /Reject Description change/,
			}),
		);

		expect(
			within(dialog).getByRole("button", {
				name: "Apply accepted changes to Delta",
			}),
		).toBeInTheDocument();
		await user.keyboard("{Escape}");
		expect(
			await screen.findByRole("button", {
				name: "Apply accepted changes to Delta",
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: "Apply all changes to Delta",
			}),
		).toBeNull();
	});

	it("hands the update, as the reviewer left it, to its ticket for a line-by-line review", async () => {
		const user = userEvent.setup();
		const onReviewOnTicket = vi.fn();
		const { onApproveItem } = renderInboxProposal(
			{ changes: [UPDATE] },
			{ onReviewOnTicket },
		);

		await user.click(
			screen.getByRole("button", { name: "Review Delta line by line" }),
		);

		expect(onReviewOnTicket).toHaveBeenCalledOnce();
		const [change, syncToPM, overrides, index] = onReviewOnTicket.mock
			.calls[0] as [ChangeItem, boolean, unknown, number];
		expect(change.existingId).toBe("story-delta");
		expect(change.description).toEqual({
			from: "Line one",
			to: "Line one\nLine two",
		});
		expect(syncToPM).toBe(false);
		expect(overrides).toBeUndefined();
		expect(index).toBe(0);
		expect(onApproveItem).not.toHaveBeenCalled();
	});

	it("offers the same line-by-line review from the detail dialog", async () => {
		const user = userEvent.setup();
		const onReviewOnTicket = vi.fn();
		renderInboxProposal({ changes: [UPDATE] }, { onReviewOnTicket });

		const [detail] = screen.getAllByRole("button", {
			name: /Open full detail to review/,
		});
		if (!detail) {
			throw new Error("no detail button for Delta");
		}
		await user.click(detail);
		const dialog = await screen.findByTestId(
			"backlog-change-detail-dialog",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Review line by line" }),
		);

		expect(onReviewOnTicket).toHaveBeenCalledOnce();
		expect(onReviewOnTicket.mock.calls[0]?.[3]).toBe(0);
	});

	it("offers no line-by-line review where the inbox cannot open a ticket", () => {
		renderInboxProposal({ changes: [UPDATE] });

		expect(
			screen.queryByRole("button", { name: "Review Delta line by line" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Approve Delta" }),
		).toBeEnabled();
	});

	it("disables both reviews, with the reason, for an update the server would hold back", () => {
		renderInboxProposal(
			{ changes: [UPDATE] },
			{
				onReviewOnTicket: vi.fn(),
				heldBackUpdateIndexes: new Set([0]),
			},
		);

		expect(
			screen.getByRole("button", { name: "Apply all changes to Delta" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Review Delta line by line" }),
		).toBeDisabled();
		expect(
			screen.getByText(
				"Ticket F-4 is not a work item in this project, so this update can't be applied. Move it to Rejected instead.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Move Delta to Rejected" }),
		).toBeEnabled();
		expect(screen.getByText("ticketNotFound")).toBeInTheDocument();
	});

	it("keeps both reviews for a target the board hides, such as an initiative, when the server would apply it", () => {
		// Initiatives are off, so the board does not list the target, but
		// it is a work item of this project and the approval applies it.
		renderInboxProposal(
			{
				changes: [UPDATE],
				boardStoryIds: {
					status: "ready",
					ids: new Set(["story-other"]),
				},
			},
			{
				onReviewOnTicket: vi.fn(),
				heldBackUpdateIndexes: new Set<number>(),
			},
		);

		expect(
			screen.getByRole("button", { name: "Apply all changes to Delta" }),
		).toBeEnabled();
		expect(
			screen.getByRole("button", { name: "Review Delta line by line" }),
		).toBeEnabled();
		expect(
			screen.queryByText(/is not a work item in this project/),
		).toBeNull();
		// The ticket exists: the item names it, and never reads as missing.
		expect(screen.getByText(/Updates F-4/)).toBeInTheDocument();
		expect(screen.queryByText("ticketNotFound")).toBeNull();
	});

	it("counts an update the server would hold back out of Apply Selected's approved changes", async () => {
		const user = userEvent.setup();
		const { onApprove } = renderInboxProposal(
			{ changes: [UPDATE, feature("Echo")] },
			{ heldBackUpdateIndexes: new Set([0]) },
		);

		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		expect(onApprove).toHaveBeenCalledOnce();
		expect(
			await screen.findByText(
				/Approved 1 of 2 proposed changes\. 1 held back: its target ticket is not in this project\./,
			),
		).toBeInTheDocument();
	});

	it("titles an applied update 'As proposed' and links the ticket's Decision Log", () => {
		renderInboxProposal(
			{ changes: [UPDATE] },
			{ lockedReasons: locked(0, "applied") },
		);

		const summary = screen.getByTestId("proposal-update-summary");
		expect(within(summary).getByText("As proposed")).toBeInTheDocument();
		expect(within(summary).queryByText("Proposed changes")).toBeNull();
		expect(
			within(summary).getByRole("link", {
				name: "Open the Decision Log of Delta in a new tab",
			}),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/project_1/stories/story-delta?storyTab=decisionLog",
		);
	});

	it("keeps an open update titled 'Proposed changes', with no Decision Log link", () => {
		renderInboxProposal({ changes: [UPDATE] });

		const summary = screen.getByTestId("proposal-update-summary");
		expect(within(summary).getByText("Proposed changes")).toHaveClass(
			"text-xs",
		);
		expect(
			within(summary).queryByRole("link", { name: /Decision Log/ }),
		).toBeNull();
	});

	it("warns that the ticket changed and still offers both reviews, merged into the current ticket", async () => {
		const user = userEvent.setup();
		const { onApproveItem } = renderInboxProposal(
			{ changes: [UPDATE] },
			{
				targetChangedIndexes: new Set([0]),
				onReviewOnTicket: vi.fn(),
			},
		);

		expect(
			screen.getByText(
				"This ticket changed after the proposal was made. The change will be merged into the current ticket.",
			),
		).toBeInTheDocument();
		// The ticket page merges the update into the ticket as it is now
		// before it shows the lines.
		expect(
			screen.getByRole("button", { name: "Review Delta line by line" }),
		).toBeEnabled();

		const [detail] = screen.getAllByRole("button", {
			name: /Open full detail to review/,
		});
		if (!detail) {
			throw new Error("no detail button for Delta");
		}
		await user.click(detail);
		const dialog = await screen.findByTestId(
			"backlog-change-detail-dialog",
		);
		expect(
			within(dialog).getByText(/This ticket changed after the proposal/),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Review line by line" }),
		).toBeEnabled();

		await user.click(
			within(dialog).getByRole("button", {
				name: "Apply all changes to Delta",
			}),
		);
		expect(onApproveItem).toHaveBeenCalledOnce();
	});
});

describe("BacklogChangeProposal — routing an item approved on its own", () => {
	const ROUTED = feature("Echo", {
		routing: {
			decision: "create",
			confidence: 0.88,
			reasoning: "Nothing similar in the backlog.",
			proposedTitle: "Echo",
			proposedDescription: "Echo, described.",
			alternatives: [],
		},
	});

	it("keeps the routing picker usable on an unselected unresolved item", async () => {
		const user = userEvent.setup();
		renderInboxProposal({ changes: [ROUTED] });

		await user.click(screen.getByRole("checkbox", { name: "Toggle Echo" }));

		expect(
			screen.getByRole("button", { name: "Enrich existing" }),
		).toBeEnabled();
	});

	it("disables the routing picker on a resolved item", () => {
		renderInboxProposal(
			{ changes: [ROUTED] },
			{ lockedReasons: locked(0, "applied") },
		);

		expect(
			screen.getByRole("button", { name: "Enrich existing" }),
		).toBeDisabled();
	});
});
