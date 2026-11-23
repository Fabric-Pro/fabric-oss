/**
 * PendingBacklogProposalsInbox — list search and per-item review.
 *
 * The search narrows the Pending, Failed and Rejected lists by summary,
 * item title or ticket ID, and lives for as long as the drawer is open.
 * In the detail view each unresolved item is approved, or moved to
 * Rejected, on its own: the inbox sends only that index and stays on the
 * proposal until nothing is left to review. A background refresh of the
 * open proposal never disables those actions.
 */

import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

const pendingProposalsList = vi.fn();
const pendingProposalsGet = vi.fn();
const slackChannelApprove = vi.fn();
const slackChannelReject = vi.fn();
const slackChannelBacklog = vi.fn();
const proposalsRejectItem = vi.fn();
const otherSourceWrite = vi.fn();
const storiesCheckPmSyncConflicts = vi.fn().mockResolvedValue({ results: [] });
const proposalsFailedCount = vi.fn().mockResolvedValue({ count: 0 });

// The inbox and its child import the oRPC client through two specifiers;
// vitest tracks mocks per specifier, so both get the same factory. Each
// factory builds its own literal because `vi.mock` is hoisted above the
// spies (see the sibling inbox test file).
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			teamsChannelMonitor: {
				pendingProposals: {
					list: (...args: unknown[]) => pendingProposalsList(...args),
					get: (...args: unknown[]) => pendingProposalsGet(...args),
					approve: (...args: unknown[]) => otherSourceWrite(...args),
					reject: (...args: unknown[]) => otherSourceWrite(...args),
					backlog: (...args: unknown[]) => otherSourceWrite(...args),
				},
			},
			slackChannelMonitor: {
				pendingProposals: {
					approve: (...args: unknown[]) =>
						slackChannelApprove(...args),
					reject: (...args: unknown[]) => slackChannelReject(...args),
					backlog: (...args: unknown[]) =>
						slackChannelBacklog(...args),
				},
			},
			teamsChatMonitor: {
				pendingProposals: {
					approve: (...args: unknown[]) => otherSourceWrite(...args),
					reject: (...args: unknown[]) => otherSourceWrite(...args),
					backlog: (...args: unknown[]) => otherSourceWrite(...args),
				},
			},
			update: vi.fn().mockResolvedValue({}),
			backlog: {
				applyChanges: (...args: unknown[]) => otherSourceWrite(...args),
				proposals: {
					retry: vi.fn(),
					dismiss: vi.fn(),
					retryAllFailed: vi.fn(),
					failedCount: (...args: unknown[]) =>
						proposalsFailedCount(...args),
					rejectItem: (...args: unknown[]) =>
						proposalsRejectItem(...args),
				},
				drafts: {
					list: vi.fn().mockResolvedValue({ drafts: [] }),
					start: vi.fn().mockResolvedValue({}),
					cancel: vi.fn().mockResolvedValue({ cancelled: true }),
				},
			},
			stories: {
				checkPmSyncConflicts: (...args: unknown[]) =>
					storiesCheckPmSyncConflicts(...args),
				retryPmSyncBatch: vi.fn(),
				reformatProposalBody: vi
					.fn()
					.mockResolvedValue({ aiDrafted: false }),
			},
		},
	},
}));
vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			teamsChannelMonitor: {
				pendingProposals: {
					list: (...args: unknown[]) => pendingProposalsList(...args),
					get: (...args: unknown[]) => pendingProposalsGet(...args),
					approve: (...args: unknown[]) => otherSourceWrite(...args),
					reject: (...args: unknown[]) => otherSourceWrite(...args),
					backlog: (...args: unknown[]) => otherSourceWrite(...args),
				},
			},
			slackChannelMonitor: {
				pendingProposals: {
					approve: (...args: unknown[]) =>
						slackChannelApprove(...args),
					reject: (...args: unknown[]) => slackChannelReject(...args),
					backlog: (...args: unknown[]) =>
						slackChannelBacklog(...args),
				},
			},
			teamsChatMonitor: {
				pendingProposals: {
					approve: (...args: unknown[]) => otherSourceWrite(...args),
					reject: (...args: unknown[]) => otherSourceWrite(...args),
					backlog: (...args: unknown[]) => otherSourceWrite(...args),
				},
			},
			update: vi.fn().mockResolvedValue({}),
			backlog: {
				applyChanges: (...args: unknown[]) => otherSourceWrite(...args),
				proposals: {
					retry: vi.fn(),
					dismiss: vi.fn(),
					retryAllFailed: vi.fn(),
					failedCount: (...args: unknown[]) =>
						proposalsFailedCount(...args),
					rejectItem: (...args: unknown[]) =>
						proposalsRejectItem(...args),
				},
				drafts: {
					list: vi.fn().mockResolvedValue({ drafts: [] }),
					start: vi.fn().mockResolvedValue({}),
					cancel: vi.fn().mockResolvedValue({ cancelled: true }),
				},
			},
			stories: {
				checkPmSyncConflicts: (...args: unknown[]) =>
					storiesCheckPmSyncConflicts(...args),
				retryPmSyncBatch: vi.fn(),
				reformatProposalBody: vi
					.fn()
					.mockResolvedValue({ aiDrafted: false }),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", async (importOriginal) => ({
	orpc: {
		projects: {
			decisionReplay: (
				await importOriginal<
					typeof import("@shared/lib/orpc-query-utils")
				>()
			).orpc.projects.decisionReplay,
			get: {
				queryOptions: () => ({
					queryKey: ["projects-get"],
					queryFn: async () => ({ project: {} }),
				}),
				queryKey: () => ["projects-get"],
			},
			stories: {
				board: {
					queryKey: () => ["stories-list"],
					queryOptions: () => ({
						queryKey: ["stories-board"],
						queryFn: async () => ({ statuses: [], stories: [] }),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
	}),
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	useBasePath: () => "/app/example-org",
}));

// Radix tooltip needs a ResizeObserver + hasPointerCapture in jsdom.
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

import { PendingBacklogProposalsInbox } from "../PendingBacklogProposalsInbox";
import {
	endProposalTicketReview,
	pendingProposalTicketReview,
} from "../proposal-ticket-review";

const PROJECT_ID = "project_1";
const PROPOSAL_ID = "proposal_1";
const SUMMARY = "Captured from a Slack thread";

/** A toast action button, which the inbox's own handler calls bare. */
function isClickAction(
	action: unknown,
): action is { label: unknown; onClick: () => void } {
	return (
		typeof action === "object" &&
		action !== null &&
		"onClick" in action &&
		typeof action.onClick === "function"
	);
}

// The drawer is a modal Radix sheet, which sets `pointer-events: none` on
// the body; the check is off so clicks inside the sheet are attempted.
const setupUser = () => userEvent.setup({ pointerEventsCheck: 0 });

type Status = "PENDING" | "FAILED" | "BACKLOG" | "APPLIED";

function makeRow(params: {
	id: string;
	summary: string;
	status?: Status;
	items?: Array<{ title: string; identifier: string | null }>;
	remainingCount?: number;
}) {
	const items = params.items ?? [];
	return {
		id: params.id,
		source: "SLACK_CHANNEL",
		status: params.status ?? "PENDING",
		summary: params.summary,
		changeCount: items.length,
		resolvedItems: [],
		remainingCount: params.remainingCount ?? items.length,
		items,
		appliedChangeIndexes: [],
		rejectedChangeIndexes: [],
		sourceMetadata: null,
		applyError: null,
		errorClass: null,
		errorMessage: null,
		failedAt: null,
		createdAt: "2026-05-23T12:00:00.000Z",
		reviewedAt: null,
		appliedAt: null,
	};
}

function feature(title: string) {
	return {
		type: "feature",
		action: "create",
		title: { to: title },
		description: { to: `${title}, described.` },
		reasoning: "Test fixture",
		sourceContext: "teams_messages",
	};
}

function makeDetail(
	overrides: Partial<{
		status: Status;
		appliedChangeIndexes: number[];
		createdChangeIndexes: number[];
		rejectedChangeIndexes: number[];
		applications: Array<{
			changeIndex: number;
			createdEntityId: string | null;
			action: string;
		}>;
		proposalRevision: string;
	}> = {},
) {
	const applied = overrides.appliedChangeIndexes ?? [];
	const rejected = overrides.rejectedChangeIndexes ?? [];
	// What the server reports as resolved, from the same outcomes.
	const resolvedItems = [
		...applied.map((changeIndex) => ({ changeIndex, reason: "applied" })),
		...rejected.map((changeIndex) => ({
			changeIndex,
			reason: "rejected",
		})),
	];
	return {
		...makeRow({
			id: PROPOSAL_ID,
			summary: SUMMARY,
			status: overrides.status,
			items: [
				{ title: "Alpha item", identifier: null },
				{ title: "Bravo item", identifier: null },
			],
		}),
		projectId: PROJECT_ID,
		userId: "user_1",
		organizationId: null,
		appliedChangeIndexes: applied,
		createdChangeIndexes: overrides.createdChangeIndexes ?? [],
		rejectedChangeIndexes: rejected,
		resolvedItems,
		remainingCount: 2 - resolvedItems.length,
		proposalRevision: overrides.proposalRevision,
		applications: overrides.applications ?? [],
		proposal: {
			summary: SUMMARY,
			contextSummary: "Discussed in #design",
			changes: [feature("Alpha item"), feature("Bravo item")],
		},
	};
}

const ACTIVE_ROWS = [
	makeRow({
		id: PROPOSAL_ID,
		summary: SUMMARY,
		items: [
			{ title: "Add export button", identifier: null },
			{ title: "Tidy the login form", identifier: "ABC-12" },
		],
	}),
	makeRow({
		id: "proposal_2",
		summary: "Billing tweaks",
		items: [{ title: "Invoice (beta) flag", identifier: "ABC-40" }],
	}),
	makeRow({
		id: "proposal_3",
		summary: "Retry me later",
		status: "FAILED",
		items: [{ title: "Export audit logs", identifier: null }],
	}),
];

const REJECTED_ROWS = [
	makeRow({
		id: "proposal_4",
		summary: "Dark mode ideas",
		status: "BACKLOG",
		items: [{ title: "Theme toggle", identifier: null }],
	}),
	makeRow({
		id: "proposal_5",
		summary: "Onboarding copy",
		status: "BACKLOG",
		items: [{ title: "Welcome email", identifier: "ABC-77" }],
	}),
];

function renderInbox(
	options: {
		defaultFilter?: "all" | "backlog";
		navigate?: (href: string) => void;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const tree = (open: boolean) => (
		<QueryClientProvider client={client}>
			<PendingBacklogProposalsInbox
				open={open}
				onOpenChange={vi.fn()}
				projectId={PROJECT_ID}
				organizationId={null}
				defaultFilter={options.defaultFilter}
				navigate={options.navigate}
			/>
		</QueryClientProvider>
	);
	const utils = render(tree(true));
	return { ...utils, setOpen: (open: boolean) => utils.rerender(tree(open)) };
}

beforeEach(() => {
	vi.clearAllMocks();
	// The review view saves each proposal's selection; a selection left by an
	// earlier test would otherwise become this test's starting selection.
	window.localStorage.clear();
	slackChannelApprove.mockReset();
	storiesCheckPmSyncConflicts.mockResolvedValue({ results: [] });
	proposalsFailedCount.mockResolvedValue({ count: 0 });
	pendingProposalsList.mockImplementation(
		async (input: { status?: string[] }) =>
			input.status?.includes("BACKLOG") ? REJECTED_ROWS : ACTIVE_ROWS,
	);
	pendingProposalsGet.mockResolvedValue(makeDetail());
});

describe("PendingBacklogProposalsInbox — list search", () => {
	it("keeps the Pending and Failed rows whose item titles match, ignoring case", async () => {
		const user = setupUser();
		renderInbox();
		await screen.findByText(SUMMARY);

		await user.type(
			screen.getByRole("searchbox", { name: "Search proposals" }),
			"EXPORT",
		);

		expect(screen.getByText(SUMMARY)).toBeInTheDocument();
		expect(screen.getByText("Retry me later")).toBeInTheDocument();
		expect(screen.queryByText("Billing tweaks")).not.toBeInTheDocument();
		expect(screen.getByText("2 proposals match")).toBeInTheDocument();
	});

	it("matches a ticket ID and treats regex characters as plain text", async () => {
		const user = setupUser();
		renderInbox();
		await screen.findByText(SUMMARY);
		const search = screen.getByRole("searchbox", {
			name: "Search proposals",
		});

		await user.type(search, "abc-40");
		expect(screen.getByText("Billing tweaks")).toBeInTheDocument();
		expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument();
		expect(screen.getByText("1 proposal matches")).toBeInTheDocument();

		await user.clear(search);
		await user.type(search, "(beta)");
		expect(screen.getByText("Billing tweaks")).toBeInTheDocument();
		expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument();
	});

	it("shows a no-match state that is not “All caught up”, and clears it", async () => {
		const user = setupUser();
		renderInbox();
		await screen.findByText(SUMMARY);

		await user.type(
			screen.getByRole("searchbox", { name: "Search proposals" }),
			"zzz",
		);

		const noMatch = screen.getByText("No proposals match “zzz”");
		expect(noMatch).toBeInTheDocument();
		expect(screen.queryByText("All caught up")).not.toBeInTheDocument();
		expect(screen.getByText("0 proposals match")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Clear search" }));
		expect(screen.getByText(SUMMARY)).toBeInTheDocument();
		expect(screen.getByText("Billing tweaks")).toBeInTheDocument();
	});

	it("filters the Rejected list", async () => {
		const user = setupUser();
		renderInbox({ defaultFilter: "backlog" });
		await screen.findByText("Dark mode ideas");

		await user.type(
			screen.getByRole("searchbox", {
				name: "Search rejected proposals",
			}),
			"welcome",
		);

		expect(screen.getByText("Onboarding copy")).toBeInTheDocument();
		expect(screen.queryByText("Dark mode ideas")).not.toBeInTheDocument();
	});

	it("keeps the query across list and detail, and clears it when the drawer closes", async () => {
		const user = setupUser();
		const { setOpen } = renderInbox();
		await screen.findByText(SUMMARY);
		await user.type(
			screen.getByRole("searchbox", { name: "Search proposals" }),
			"export",
		);

		await user.click(screen.getByText(SUMMARY));
		await user.click(
			await screen.findByRole("button", { name: "Back to inbox" }),
		);
		expect(
			await screen.findByRole("searchbox", { name: "Search proposals" }),
		).toHaveValue("export");

		setOpen(false);
		setOpen(true);
		expect(
			await screen.findByRole("searchbox", { name: "Search proposals" }),
		).toHaveValue("");
	});
});

describe("PendingBacklogProposalsInbox — per-item review", () => {
	async function openDetail() {
		const user = setupUser();
		const utils = renderInbox();
		await user.click(await screen.findByText(SUMMARY));
		const approve = await screen.findByRole("button", {
			name: "Approve Alpha item",
		});
		await waitFor(() => {
			expect(approve).toBeEnabled();
		});
		return { user, ...utils };
	}

	it("approves one item by its index and stays on the proposal", async () => {
		slackChannelApprove.mockResolvedValue({
			status: "pending",
			remainingChangeCount: 1,
			skipped: [],
		});
		const { user } = await openDetail();

		await user.click(
			screen.getByRole("button", { name: "Approve Alpha item" }),
		);

		await waitFor(() => {
			expect(slackChannelApprove).toHaveBeenCalledTimes(1);
		});
		const input = slackChannelApprove.mock.calls[0]?.[0];
		expect(input).toEqual(
			expect.objectContaining({
				proposalId: PROPOSAL_ID,
				approvedChangeIndexes: [0],
			}),
		);
		expect(input.approvedChanges).toHaveLength(1);
		expect(input.approvedChanges[0].title.to).toBe("Alpha item");
		await waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith(
				"Approved “Alpha item”",
				{ description: "The other items stay in review." },
			);
		});
		await waitFor(() => {
			expect(pendingProposalsGet.mock.calls.length).toBeGreaterThan(1);
		});
		expect(
			screen.getByRole("button", { name: "Back to inbox" }),
		).toBeInTheDocument();
	});

	it("moves one item to Rejected by its index and stays on the proposal", async () => {
		proposalsRejectItem.mockResolvedValue({ success: true, updated: true });
		const { user } = await openDetail();

		await user.click(
			screen.getByRole("button", { name: "Move Bravo item to Rejected" }),
		);

		await waitFor(() => {
			expect(proposalsRejectItem).toHaveBeenCalledWith(
				expect.objectContaining({
					proposalId: PROPOSAL_ID,
					changeIndex: 1,
				}),
			);
		});
		expect(slackChannelBacklog).not.toHaveBeenCalled();
		await waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith(
				"Moved “Bravo item” to Rejected",
				expect.anything(),
			);
		});
		expect(otherSourceWrite).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Back to inbox" }),
		).toBeInTheDocument();
	});

	it("returns to the list once the refreshed proposal has left review", async () => {
		// The last open item: the server finishes the proposal, and the
		// refetch after the approve sees it applied.
		slackChannelApprove.mockImplementation(async () => {
			pendingProposalsGet.mockResolvedValue(
				makeDetail({
					status: "APPLIED",
					appliedChangeIndexes: [0, 1],
				}),
			);
			return { status: "applied", remainingChangeCount: 0, skipped: [] };
		});
		const { user } = await openDetail();

		await user.click(
			screen.getByRole("button", { name: "Approve Alpha item" }),
		);

		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "Back to inbox" }),
			).not.toBeInTheDocument();
		});
		expect(toast.success).toHaveBeenCalledWith("Approved “Alpha item”", {
			description: "That was the last item in this proposal.",
		});
		expect(
			screen.getByRole("searchbox", { name: "Search proposals" }),
		).toBeInTheDocument();
	});

	it("shows resolved items with their outcome and offers actions only on the rest", async () => {
		pendingProposalsGet.mockResolvedValue(
			makeDetail({
				appliedChangeIndexes: [0],
				createdChangeIndexes: [0],
				applications: [
					{
						changeIndex: 0,
						createdEntityId: "story-alpha",
						action: "create",
					},
				],
			}),
		);
		const user = setupUser();
		renderInbox();
		await user.click(await screen.findByText(SUMMARY));

		const link = await screen.findByRole("link", {
			name: "Open the ticket for Alpha item in a new tab",
		});
		expect(link).toHaveAttribute(
			"href",
			"/app/example-org/projects/project_1/stories/story-alpha",
		);
		expect(link).toHaveAttribute("target", "_blank");
		expect(
			screen.queryByRole("button", { name: "Approve Alpha item" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Approve Bravo item" }),
		).toBeEnabled();
	});

	it("labels an item moved to Rejected and offers it no actions", async () => {
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ rejectedChangeIndexes: [1] }),
		);
		const user = setupUser();
		renderInbox();
		await user.click(await screen.findByText(SUMMARY));

		const badge = await screen.findByText("Moved to Rejected");
		expect(badge).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Approve Bravo item" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: "Move Bravo item to Rejected",
			}),
		).not.toBeInTheDocument();
	});

	it("offers per-item actions on a failed proposal's open items", async () => {
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ status: "FAILED", appliedChangeIndexes: [0] }),
		);
		const user = setupUser();
		renderInbox();
		await user.click(await screen.findByText(SUMMARY));

		const approve = await screen.findByRole("button", {
			name: "Approve Bravo item",
		});
		await waitFor(() => {
			expect(approve).toBeEnabled();
		});
		expect(
			screen.getByRole("button", { name: "Move Bravo item to Rejected" }),
		).toBeEnabled();
		expect(
			screen.queryByRole("button", { name: "Approve Alpha item" }),
		).not.toBeInTheDocument();
	});

	it("explains a conflict, refreshes and stays on the proposal", async () => {
		const raced = "This proposal has already been approved or rejected.";
		slackChannelApprove.mockRejectedValue(
			Object.assign(new Error(raced), { code: "CONFLICT" }),
		);
		const { user } = await openDetail();

		await user.click(
			screen.getByRole("button", { name: "Approve Alpha item" }),
		);

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"This proposal has already been approved or rejected perhaps by another user.",
			);
		});
		await waitFor(() => {
			expect(pendingProposalsGet.mock.calls.length).toBeGreaterThan(1);
		});
		expect(
			screen.getByRole("button", { name: "Back to inbox" }),
		).toBeInTheDocument();
	});

	it("shows the server's message when the approve is refused", async () => {
		const message =
			"“Alpha item” can't update ABC-9: it is not in this project.";
		slackChannelApprove.mockRejectedValue(
			Object.assign(new Error(message), { code: "BAD_REQUEST" }),
		);
		const { user } = await openDetail();

		await user.click(
			screen.getByRole("button", { name: "Approve Alpha item" }),
		);

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"Couldn't approve “Alpha item”",
				{ description: message },
			);
		});
	});

	it("sends the revision it was opened at with a single-item approve", async () => {
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ proposalRevision: "rev-1" }),
		);
		slackChannelApprove.mockResolvedValue({
			status: "pending",
			remainingChangeCount: 1,
			skipped: [],
		});
		const { user } = await openDetail();

		await user.click(
			screen.getByRole("button", { name: "Approve Alpha item" }),
		);

		await waitFor(() => {
			expect(slackChannelApprove).toHaveBeenCalledWith(
				expect.objectContaining({
					proposalId: PROPOSAL_ID,
					expectedProposalRevision: "rev-1",
				}),
			);
		});
	});

	it("sends the revision it was opened at with a whole-proposal approve", async () => {
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ proposalRevision: "rev-1" }),
		);
		slackChannelApprove.mockResolvedValue({ status: "applied" });
		const { user } = await openDetail();

		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		await waitFor(() => {
			expect(slackChannelApprove).toHaveBeenCalledWith(
				expect.objectContaining({
					approvedChangeIndexes: [0, 1],
					expectedProposalRevision: "rev-1",
				}),
			);
		});
	});

	it("shows that the proposal changed since it was opened, refreshes and stays on it", async () => {
		const changed =
			"This proposal changed after you opened it. Reopen it to review the latest version.";
		slackChannelApprove.mockRejectedValue(
			Object.assign(new Error(changed), { code: "CONFLICT" }),
		);
		const { user } = await openDetail();

		await user.click(
			screen.getByRole("button", { name: "Approve Alpha item" }),
		);

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(changed);
		});
		await waitFor(() => {
			expect(pendingProposalsGet.mock.calls.length).toBeGreaterThan(1);
		});
		expect(
			screen.getByRole("button", { name: "Back to inbox" }),
		).toBeInTheDocument();
	});

	it("closes the proposal after its last item and offers the new ticket in the toast", async () => {
		// Bravo was moved to Rejected, so Alpha is the last open item.
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ rejectedChangeIndexes: [1] }),
		);
		slackChannelApprove.mockResolvedValue({
			status: "applied",
			remainingChangeCount: 0,
			skipped: [],
			createdStoryIds: ["story-alpha"],
		});
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const { user } = await openDetail();

		await user.click(
			screen.getByRole("button", { name: "Approve Alpha item" }),
		);

		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "Back to inbox" }),
			).not.toBeInTheDocument();
		});
		expect(slackChannelApprove).toHaveBeenCalledWith(
			expect.objectContaining({ approvedChangeIndexes: [0] }),
		);
		expect(toast.success).toHaveBeenCalledWith("Approved “Alpha item”", {
			description: "That was the last item in this proposal.",
			action: { label: "Open ticket", onClick: expect.any(Function) },
		});
		const action = vi.mocked(toast.success).mock.lastCall?.[1]?.action;
		if (!isClickAction(action)) {
			throw new Error("the toast offers no ticket");
		}
		action.onClick();
		expect(open).toHaveBeenCalledWith(
			"/app/example-org/projects/project_1/stories/story-alpha",
			"_blank",
			"noopener,noreferrer",
		);
		open.mockRestore();
	});

	it("counts on the list row what the server says still waits for a decision", async () => {
		pendingProposalsList.mockImplementation(
			async (input: { status?: string[] }) =>
				input.status?.includes("BACKLOG")
					? []
					: [
							makeRow({
								id: PROPOSAL_ID,
								summary: SUMMARY,
								items: [
									{ title: "Alpha item", identifier: null },
									{ title: "Bravo item", identifier: null },
								],
								remainingCount: 1,
							}),
						],
		);
		renderInbox();

		expect(
			await screen.findByText("1 of 2 changes left"),
		).toBeInTheDocument();
	});
});

describe("PendingBacklogProposalsInbox — actions during a background refresh", () => {
	const update = {
		type: "feature",
		action: "update",
		existingId: "story-7",
		existingIdentifier: "ABC-7",
		title: { from: "Bravo item", to: "Bravo item" },
		description: { from: "Intro\nOld step", to: "Intro\nNew step" },
		structurePreserved: true,
		reasoning: "Test fixture",
		sourceContext: "teams_messages",
	};

	/** Re-read the open proposal as the tab regaining focus does, held open. */
	function startBackgroundRefresh(detail: unknown): () => void {
		let release: () => void = () => {};
		pendingProposalsGet.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve(detail);
				}),
		);
		act(() => {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		return () => release();
	}

	afterEach(() => {
		focusManager.setFocused(undefined);
	});

	it("moves an item to Rejected on the first click while the proposal refreshes", async () => {
		proposalsRejectItem.mockResolvedValue({ success: true, updated: true });
		const user = setupUser();
		renderInbox();
		await user.click(await screen.findByText(SUMMARY));
		const reject = await screen.findByRole("button", {
			name: "Move Bravo item to Rejected",
		});
		await waitFor(() => {
			expect(reject).toBeEnabled();
		});
		const getCalls = pendingProposalsGet.mock.calls.length;

		const release = startBackgroundRefresh(makeDetail());
		await waitFor(() => {
			expect(pendingProposalsGet.mock.calls.length).toBeGreaterThan(
				getCalls,
			);
		});
		await user.click(
			screen.getByRole("button", { name: "Move Bravo item to Rejected" }),
		);

		await waitFor(() => {
			expect(proposalsRejectItem).toHaveBeenCalledTimes(1);
		});
		expect(proposalsRejectItem).toHaveBeenCalledWith(
			expect.objectContaining({
				proposalId: PROPOSAL_ID,
				changeIndex: 1,
			}),
		);
		release();
	});

	it("opens an update's ticket for a line-by-line review, handing it the item", async () => {
		const base = makeDetail();
		const detail = {
			...base,
			proposal: {
				...base.proposal,
				changes: [feature("Alpha item"), update],
			},
		};
		pendingProposalsGet.mockResolvedValue(detail);
		const navigate = vi.fn();
		const user = setupUser();
		renderInbox({ navigate });
		await user.click(await screen.findByText(SUMMARY));
		const review = await screen.findByRole("button", {
			name: "Review Bravo item line by line",
		});
		await waitFor(() => {
			expect(review).toBeEnabled();
		});
		await user.click(review);

		expect(navigate).toHaveBeenCalledWith(
			"/app/example-org/projects/project_1/stories/story-7?storyTab=cleanSpec",
		);
		const handed = pendingProposalTicketReview("story-7");
		expect(handed).toMatchObject({
			projectId: PROJECT_ID,
			proposalId: PROPOSAL_ID,
			changeIndex: 1,
			source: detail.source,
		});
		expect(handed?.change.existingId).toBe("story-7");
		expect(proposalsRejectItem).not.toHaveBeenCalled();
		endProposalTicketReview();
	});
});
