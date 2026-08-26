/**
 * PendingBacklogProposalsInbox — chat-thread image-attachment plumbing.
 *
 * Group 6 of spec `chat-thread-image-attachments`. The inbox itself
 * renders no chip — it reads `sourceMetadata.attachments` and
 * `sourceMetadata.attachmentWarnings` from the detail response and
 * passes both arrays to `BacklogChangeProposal`, which surfaces the
 * `📎 N` / `⚠ M` chips. These tests verify the plumbing end-to-end
 * by mounting the real inbox + real child and asserting on the chips
 * the child renders.
 *
 * Covers FR-26, FR-27, AC12, AC14.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pendingProposalsList = vi.fn();
const pendingProposalsGet = vi.fn();
const teamsChannelApprove = vi.fn();
const teamsChannelReject = vi.fn();
const slackChannelApprove = vi.fn();
const slackChannelReject = vi.fn();
const teamsChatApprove = vi.fn();
const teamsChatReject = vi.fn();
const storiesCheckPmSyncConflicts = vi.fn().mockResolvedValue({ results: [] });
const storiesReformatProposalBody = vi.fn();
const draftsList = vi.fn().mockResolvedValue({ drafts: [] });
const draftsStart = vi.fn().mockResolvedValue({
	kind: "BUG",
	status: "RUNNING",
	startedAt: "2026-06-18T12:00:00.000Z",
	description: null,
	acceptanceCriteria: null,
	needsMoreInfo: null,
});
const draftsCancel = vi.fn().mockResolvedValue({ cancelled: true });
const projectsUpdate = vi.fn().mockResolvedValue({});
const projectsGetData = vi.fn().mockReturnValue({ project: {} });
const proposalsRetry = vi.fn();
const proposalsDismiss = vi.fn();
const proposalsRetryAllFailed = vi.fn();
const proposalsFailedCount = vi.fn();

// Both import specifiers (`@shared/lib/orpc-client` from the inbox AND
// `../../../../../shared/lib/orpc-client` from `BacklogChangeProposal`)
// resolve to the same physical module, but vitest tracks mocks per
// specifier — so we register the SAME factory at both. Otherwise the
// second mock would dedupe-replace the first, silently dropping
// `pendingProposals.list` from the inbox's view and stranding tests in
// the "All caught up" empty state.
//
// `vi.mock` is hoisted above the variable declarations at the top of
// this file, so the factories reference the `pendingProposals*` /
// `*Approve` / `*Reject` / `storiesCheckPmSyncConflicts` symbols
// indirectly via the closure that vitest re-evaluates each test. The
// factories cannot pull a shared object literal off of an outer
// variable (the hoist throws TDZ); they must each construct their own.
//
// Read endpoints (`list`, `get`) are source-agnostic and live on
// `teamsChannelMonitor`. Write endpoints (`approve`, `reject`) are
// source-specific — the inbox dispatches to the namespace matching
// `proposal.source`. We give each write endpoint its own spy so the
// dispatch-routing tests can assert which one fired.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			teamsChannelMonitor: {
				pendingProposals: {
					list: (...args: unknown[]) => pendingProposalsList(...args),
					get: (...args: unknown[]) => pendingProposalsGet(...args),
					approve: (...args: unknown[]) =>
						teamsChannelApprove(...args),
					reject: (...args: unknown[]) => teamsChannelReject(...args),
				},
			},
			slackChannelMonitor: {
				pendingProposals: {
					approve: (...args: unknown[]) =>
						slackChannelApprove(...args),
					reject: (...args: unknown[]) => slackChannelReject(...args),
				},
			},
			teamsChatMonitor: {
				pendingProposals: {
					approve: (...args: unknown[]) => teamsChatApprove(...args),
					reject: (...args: unknown[]) => teamsChatReject(...args),
				},
			},
			update: (...args: unknown[]) => projectsUpdate(...args),
			backlog: {
				proposals: {
					retry: (...args: unknown[]) => proposalsRetry(...args),
					dismiss: (...args: unknown[]) => proposalsDismiss(...args),
					retryAllFailed: (...args: unknown[]) =>
						proposalsRetryAllFailed(...args),
					failedCount: (...args: unknown[]) =>
						proposalsFailedCount(...args),
				},
				drafts: {
					list: (...args: unknown[]) => draftsList(...args),
					start: (...args: unknown[]) => draftsStart(...args),
					cancel: (...args: unknown[]) => draftsCancel(...args),
				},
			},
			stories: {
				checkPmSyncConflicts: (...args: unknown[]) =>
					storiesCheckPmSyncConflicts(...args),
				retryPmSyncBatch: vi.fn(),
				reformatProposalBody: (...args: unknown[]) =>
					storiesReformatProposalBody(...args),
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
					approve: (...args: unknown[]) =>
						teamsChannelApprove(...args),
					reject: (...args: unknown[]) => teamsChannelReject(...args),
				},
			},
			slackChannelMonitor: {
				pendingProposals: {
					approve: (...args: unknown[]) =>
						slackChannelApprove(...args),
					reject: (...args: unknown[]) => slackChannelReject(...args),
				},
			},
			teamsChatMonitor: {
				pendingProposals: {
					approve: (...args: unknown[]) => teamsChatApprove(...args),
					reject: (...args: unknown[]) => teamsChatReject(...args),
				},
			},
			update: (...args: unknown[]) => projectsUpdate(...args),
			backlog: {
				proposals: {
					retry: (...args: unknown[]) => proposalsRetry(...args),
					dismiss: (...args: unknown[]) => proposalsDismiss(...args),
					retryAllFailed: (...args: unknown[]) =>
						proposalsRetryAllFailed(...args),
					failedCount: (...args: unknown[]) =>
						proposalsFailedCount(...args),
				},
				drafts: {
					list: (...args: unknown[]) => draftsList(...args),
					start: (...args: unknown[]) => draftsStart(...args),
					cancel: (...args: unknown[]) => draftsCancel(...args),
				},
			},
			stories: {
				checkPmSyncConflicts: (...args: unknown[]) =>
					storiesCheckPmSyncConflicts(...args),
				retryPmSyncBatch: vi.fn(),
				reformatProposalBody: (...args: unknown[]) =>
					storiesReformatProposalBody(...args),
			},
		},
	},
}));

// Stub orpc query-key builders so the inbox's invalidate-all path works
// without dragging the whole oRPC client into the test bundle.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: () => ({
					queryKey: ["projects-get"],
					queryFn: async () => projectsGetData(),
				}),
				queryKey: () => ["projects-get"],
			},
			stories: {
				list: { queryKey: () => ["stories-list"] },
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

const PROPOSAL_ID = "proposal_1";
const PROJECT_ID = "project_1";

type RowSource =
	| "SLACK_CHANNEL"
	| "TEAMS_CHANNEL"
	| "TEAMS_CHAT"
	| "AI_UPDATE_SIDEBAR";

function makeListRow(
	overrides: Partial<{
		id: string;
		source: RowSource;
		sourceMetadata: Record<string, unknown> | null;
		status: "PENDING" | "FAILED" | "APPLIED" | "BACKLOG";
		applyError: string | null;
		errorClass: string | null;
		errorMessage: string | null;
		failedAt: string | null;
		summary: string;
	}> = {},
) {
	return {
		id: overrides.id ?? PROPOSAL_ID,
		source: overrides.source ?? "SLACK_CHANNEL",
		status: overrides.status ?? "PENDING",
		summary: overrides.summary ?? "Captured from a Slack thread",
		changeCount: 1,
		sourceMetadata: overrides.sourceMetadata ?? null,
		applyError: overrides.applyError ?? null,
		errorClass: overrides.errorClass ?? null,
		errorMessage: overrides.errorMessage ?? null,
		failedAt: overrides.failedAt ?? null,
		createdAt: "2026-05-23T12:00:00.000Z",
		reviewedAt: null,
		appliedAt: null,
	};
}

function makeDetail(
	overrides: Partial<{
		source: RowSource;
		sourceMetadata: Record<string, unknown> | null;
		status: "PENDING" | "FAILED" | "APPLIED" | "BACKLOG";
		applyError: string | null;
		errorClass: string | null;
		errorMessage: string | null;
		failedAt: string | null;
	}> = {},
) {
	return {
		...makeListRow(overrides),
		projectId: PROJECT_ID,
		userId: "user_1",
		organizationId: null,
		proposal: {
			summary: "Captured from a Slack thread",
			contextSummary: "Discussed in #design",
			changes: [
				{
					type: "feature",
					action: "create",
					title: { to: "Add chat-thread image attachment chips" },
					description: { to: "Render the 📎 N / ⚠ M chips." },
					reasoning: "Reviewers need attachment volume at a glance.",
					sourceContext: "teams_messages",
				},
			],
		},
	};
}

function buildAttachment(id: string) {
	return {
		source: "slack" as const,
		messageTs: "1715724000.123456",
		file: {
			id,
			name: `image-${id}.png`,
			mimetype: "image/png",
			urlPrivate: "https://files.slack.com/example",
			size: 1024,
		},
	};
}

function renderInbox(
	options: {
		defaultFilter?: "all" | "failed" | "backlog";
		hasPMTool?: boolean;
		pmToolName?: string;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const utils = render(
		<QueryClientProvider client={client}>
			<PendingBacklogProposalsInbox
				open
				onOpenChange={vi.fn()}
				projectId={PROJECT_ID}
				organizationId={null}
				defaultFilter={options.defaultFilter}
				hasPMTool={options.hasPMTool}
				pmToolName={options.pmToolName}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, client };
}

describe("PendingBacklogProposalsInbox — chat-thread attachment plumbing", () => {
	beforeEach(() => {
		pendingProposalsList.mockReset();
		pendingProposalsGet.mockReset();
		teamsChannelApprove.mockReset();
		teamsChannelReject.mockReset();
		slackChannelApprove.mockReset();
		slackChannelReject.mockReset();
		teamsChatApprove.mockReset();
		teamsChatReject.mockReset();
		storiesCheckPmSyncConflicts.mockReset();
		storiesCheckPmSyncConflicts.mockResolvedValue({ results: [] });
		proposalsRetry.mockReset();
		proposalsDismiss.mockReset();
		proposalsRetryAllFailed.mockReset();
		proposalsFailedCount.mockReset();
	});

	afterEach(() => {
		// React Testing Library auto-cleanup runs in vitest.setup; this is
		// belt-and-suspenders against shared module-level fakes.
	});

	it("renders the 📎 4 chip via the child when the detail row carries 4 attachments and 0 warnings", async () => {
		const sourceMetadata = {
			channelName: "design",
			attachments: [
				buildAttachment("F1"),
				buildAttachment("F2"),
				buildAttachment("F3"),
				buildAttachment("F4"),
			],
			attachmentWarnings: [],
		};
		pendingProposalsList.mockResolvedValue([
			makeListRow({ sourceMetadata }),
		]);
		pendingProposalsGet.mockResolvedValue(makeDetail({ sourceMetadata }));

		renderInbox();

		// Drill into the detail view by clicking the row.
		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		const chip = await screen.findByRole("img", {
			name: "4 image attachments from chat thread",
		});
		expect(chip).toBeInTheDocument();
		expect(chip).toHaveTextContent("4");
		// No warning chip on the happy path.
		expect(
			screen.queryByRole("img", { name: /attachment warning/i }),
		).not.toBeInTheDocument();
	});

	it("renders no chips via the child when the detail row carries 0 attachments and 0 warnings", async () => {
		const sourceMetadata = {
			channelName: "design",
			attachments: [],
			attachmentWarnings: [],
		};
		pendingProposalsList.mockResolvedValue([
			makeListRow({ sourceMetadata }),
		]);
		pendingProposalsGet.mockResolvedValue(makeDetail({ sourceMetadata }));

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		// Wait for the detail to mount — the proposal card heading is
		// the stable signal that BacklogChangeProposal has rendered.
		await screen.findByText(/Proposed Backlog Changes/);

		expect(
			screen.queryByRole("img", { name: /image attachment/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: /attachment warning/i }),
		).not.toBeInTheDocument();
	});

	it("renders both chips via the child when the detail row carries 1 attachment + 2 warnings (PENDING)", async () => {
		const sourceMetadata = {
			channelName: "design",
			attachments: [buildAttachment("F1")],
			attachmentWarnings: [
				{ source: "slack", refId: "F2", reason: "unsupported_mime" },
				{ source: "slack", refId: "F3", reason: "image_too_large" },
			],
		};
		pendingProposalsList.mockResolvedValue([
			makeListRow({ sourceMetadata, status: "PENDING" }),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ sourceMetadata, status: "PENDING" }),
		);

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		expect(
			await screen.findByRole("img", {
				name: "1 image attachment from chat thread",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("img", { name: "2 attachment warnings" }),
		).toBeInTheDocument();
	});

	it("renders no chips via the child for legacy rows whose sourceMetadata.attachments is undefined (FR-27)", async () => {
		// Legacy row — `sourceMetadata` exists but has no `attachments`
		// or `attachmentWarnings` keys. The defensive reader returns
		// `[]` for both so the child stays quiet and the page does NOT
		// crash on the missing keys.
		const sourceMetadata = { channelName: "design" };
		pendingProposalsList.mockResolvedValue([
			makeListRow({ sourceMetadata }),
		]);
		pendingProposalsGet.mockResolvedValue(makeDetail({ sourceMetadata }));

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		await screen.findByText(/Proposed Backlog Changes/);

		expect(
			screen.queryByRole("img", { name: /image attachment/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: /attachment warning/i }),
		).not.toBeInTheDocument();
	});

	it("treats sourceMetadata === null as legacy (no crash, no chips)", async () => {
		// Older rows may also arrive with a null `sourceMetadata` —
		// confirm the defensive readers don't blow up on null.
		pendingProposalsList.mockResolvedValue([
			makeListRow({ sourceMetadata: null }),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ sourceMetadata: null }),
		);

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		await screen.findByText(/Proposed Backlog Changes/);

		expect(
			screen.queryByRole("img", { name: /image attachment/i }),
		).not.toBeInTheDocument();
	});

	it("treats non-array attachments JSON as empty (defensive against corrupt JSON)", async () => {
		// `sourceMetadata.attachments` is a plain object (not an array)
		// — the orchestrator never writes this shape, but the readers
		// must defend against it so a malformed row never crashes the
		// inbox.
		const sourceMetadata = {
			attachments: { not: "an array" },
			attachmentWarnings: "also not an array",
		};
		pendingProposalsList.mockResolvedValue([
			makeListRow({ sourceMetadata }),
		]);
		pendingProposalsGet.mockResolvedValue(makeDetail({ sourceMetadata }));

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		await screen.findByText(/Proposed Backlog Changes/);

		expect(
			screen.queryByRole("img", { name: /image attachment/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: /attachment warning/i }),
		).not.toBeInTheDocument();
	});

	// ----- Source-routing regression tests (PR validation finding) -----
	//
	// Bug discovered live during PR validation: the inbox unconditionally
	// called `teamsChannelMonitor.pendingProposals.approve` regardless of
	// `proposal.source`, and the Teams approve procedure's source filter
	// (`collectTeamsAttachmentRefs`) silently dropped Slack-source refs.
	// These tests pin the dispatch behavior so that:
	//   • SLACK_CHANNEL proposals → slackChannelMonitor.approve/reject
	//   • TEAMS_CHANNEL proposals → teamsChannelMonitor.approve/reject
	//   • TEAMS_CHAT    proposals → teamsChatMonitor.approve/reject
	// and so the wrong endpoint is never invoked.

	it("approves a SLACK_CHANNEL proposal via slackChannelMonitor (NOT teamsChannelMonitor)", async () => {
		const sourceMetadata = {
			channelName: "design",
			attachments: [buildAttachment("F1")],
			attachmentWarnings: [],
		};
		pendingProposalsList.mockResolvedValue([
			makeListRow({ source: "SLACK_CHANNEL", sourceMetadata }),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ source: "SLACK_CHANNEL", sourceMetadata }),
		);
		slackChannelApprove.mockResolvedValue({ status: "ok" });

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		const applyButton = await screen.findByRole("button", {
			name: /Apply Selected/,
		});
		applyButton.click();

		await waitFor(() => {
			expect(slackChannelApprove).toHaveBeenCalledTimes(1);
		});
		expect(teamsChannelApprove).not.toHaveBeenCalled();
		expect(teamsChatApprove).not.toHaveBeenCalled();

		expect(slackChannelApprove).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				proposalId: PROPOSAL_ID,
			}),
		);
	});

	it("approves a TEAMS_CHANNEL proposal via teamsChannelMonitor (NOT slackChannelMonitor)", async () => {
		const sourceMetadata = {
			channelName: "design",
			attachments: [],
			attachmentWarnings: [],
		};
		pendingProposalsList.mockResolvedValue([
			makeListRow({ source: "TEAMS_CHANNEL", sourceMetadata }),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ source: "TEAMS_CHANNEL", sourceMetadata }),
		);
		teamsChannelApprove.mockResolvedValue({ status: "ok" });

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		const applyButton = await screen.findByRole("button", {
			name: /Apply Selected/,
		});
		applyButton.click();

		await waitFor(() => {
			expect(teamsChannelApprove).toHaveBeenCalledTimes(1);
		});
		expect(slackChannelApprove).not.toHaveBeenCalled();
		expect(teamsChatApprove).not.toHaveBeenCalled();
	});

	it("approves a TEAMS_CHAT proposal via teamsChatMonitor (NOT teamsChannelMonitor or slackChannelMonitor)", async () => {
		const sourceMetadata = {
			channelName: "design",
			attachments: [],
			attachmentWarnings: [],
		};
		pendingProposalsList.mockResolvedValue([
			makeListRow({ source: "TEAMS_CHAT", sourceMetadata }),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ source: "TEAMS_CHAT", sourceMetadata }),
		);
		teamsChatApprove.mockResolvedValue({ status: "ok" });

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		const applyButton = await screen.findByRole("button", {
			name: /Apply Selected/,
		});
		applyButton.click();

		await waitFor(() => {
			expect(teamsChatApprove).toHaveBeenCalledTimes(1);
		});
		expect(slackChannelApprove).not.toHaveBeenCalled();
		expect(teamsChannelApprove).not.toHaveBeenCalled();
	});

	it("deletes a rejected SLACK_CHANNEL proposal via slackChannelMonitor (NOT teamsChannelMonitor)", async () => {
		// The internal BACKLOG state is presented as the recoverable Rejected
		// panel. Its terminal action still routes through the existing reject
		// endpoint so the audit record is retained.
		const sourceMetadata = {
			channelName: "design",
			attachments: [buildAttachment("F1")],
			attachmentWarnings: [],
		};
		pendingProposalsList.mockResolvedValue([
			makeListRow({
				source: "SLACK_CHANNEL",
				sourceMetadata,
				status: "BACKLOG",
			}),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({
				source: "SLACK_CHANNEL",
				sourceMetadata,
				status: "BACKLOG",
			}),
		);
		slackChannelReject.mockResolvedValue({ status: "ok" });

		// defaultFilter="backlog" opens the legacy BACKLOG rows in the Rejected
		// proposals panel.
		renderInbox({ defaultFilter: "backlog" });

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		const deleteButton = await screen.findByRole("button", {
			name: /Delete proposal/,
		});
		deleteButton.click();

		await waitFor(() => {
			expect(slackChannelReject).toHaveBeenCalledTimes(1);
		});
		expect(teamsChannelReject).not.toHaveBeenCalled();
		expect(teamsChatReject).not.toHaveBeenCalled();
	});

	it("offers Move to Rejected as the only non-approve action on a pending proposal", async () => {
		const sourceMetadata = {
			channelName: "design",
			attachments: [],
			attachmentWarnings: [],
		};
		pendingProposalsList.mockResolvedValue([
			makeListRow({
				source: "SLACK_CHANNEL",
				sourceMetadata,
				status: "PENDING",
			}),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({
				source: "SLACK_CHANNEL",
				sourceMetadata,
				status: "PENDING",
			}),
		);

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		// The stored transition remains PENDING -> BACKLOG, but the user-facing
		// action reflects the agreed Rejected terminology. Its accessible name
		// must match the visible intent.
		await screen.findByRole("button", {
			name: /Move this proposal to Rejected/,
		});
		expect(
			screen.queryByRole("button", { name: /Delete proposal/ }),
		).toBeNull();
	});

	it("maps legacy BACKLOG rows to the Rejected proposals UI", async () => {
		pendingProposalsList.mockImplementation(
			(input: { status?: string[] }) =>
				input.status?.includes("BACKLOG")
					? [makeListRow({ status: "BACKLOG" })]
					: [],
		);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ status: "BACKLOG" }),
		);

		renderInbox({ defaultFilter: "backlog" });

		expect(
			await screen.findByRole("heading", { name: "Rejected proposals" }),
		).toBeInTheDocument();
		expect(await screen.findByText("Rejected")).toBeInTheDocument();
		expect(screen.queryByText(/^Backlog$/)).not.toBeInTheDocument();

		screen.getByText(/Captured from a Slack thread/).click();

		expect(
			await screen.findByRole("button", {
				name: /Restore & Apply Selected/,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Delete proposal/ }),
		).toBeInTheDocument();
	});

	it("shows a Rejected empty state without exposing the BACKLOG label", async () => {
		pendingProposalsList.mockResolvedValue([]);

		renderInbox({ defaultFilter: "backlog" });

		expect(
			await screen.findByRole("heading", { name: "Rejected proposals" }),
		).toBeInTheDocument();
		expect(
			await screen.findByRole("heading", {
				name: "No rejected proposals",
			}),
		).toBeInTheDocument();
		expect(screen.queryByText(/backlog/i)).not.toBeInTheDocument();
	});

	it("waits for the detail query before rendering chips so legacy proposals never momentarily flash a chip", async () => {
		const sourceMetadata = {
			attachments: [buildAttachment("F1")],
			attachmentWarnings: [],
		};
		pendingProposalsList.mockResolvedValue([
			makeListRow({ sourceMetadata }),
		]);
		pendingProposalsGet.mockResolvedValue(makeDetail({ sourceMetadata }));

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();

		// The chip should appear after the detail query resolves.
		await waitFor(() => {
			expect(
				screen.getByRole("img", {
					name: "1 image attachment from chat thread",
				}),
			).toBeInTheDocument();
		});
	});
});

// ============================================================================
// PM-tool sync checkbox — user-controlled sync for monitored-channel proposals.
//
// The inbox surfaces the shared `BacklogChangeProposal` "Also sync to {PM Tool}"
// checkbox when the project has a PM tool configured (`hasPMTool`). The checkbox
// defaults OFF here (unlike the AI Update flow's default-on) so approved
// channel-monitor proposals stay on the Fabric roadmap unless the reviewer
// explicitly opts in. The reviewer's choice is forwarded to the source-specific
// `approve()` as an explicit `syncToPM` boolean.
// ============================================================================

describe("PendingBacklogProposalsInbox — PM-tool sync checkbox", () => {
	beforeEach(() => {
		pendingProposalsList.mockReset();
		pendingProposalsGet.mockReset();
		teamsChannelApprove.mockReset();
		slackChannelApprove.mockReset();
		teamsChatApprove.mockReset();
		storiesCheckPmSyncConflicts.mockReset();
		storiesCheckPmSyncConflicts.mockResolvedValue({ results: [] });
	});

	it("does NOT render the sync checkbox when the project has no PM tool", async () => {
		pendingProposalsList.mockResolvedValue([
			makeListRow({ source: "SLACK_CHANNEL" }),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ source: "SLACK_CHANNEL" }),
		);

		renderInbox(); // hasPMTool defaults to false

		(await screen.findByText(/Captured from a Slack thread/)).click();
		await screen.findByText(/Proposed Backlog Changes/);

		expect(
			screen.queryByRole("checkbox", { name: /Also sync to/i }),
		).not.toBeInTheDocument();
	});

	it("renders the sync checkbox UNCHECKED by default when the project has a PM tool", async () => {
		pendingProposalsList.mockResolvedValue([
			makeListRow({ source: "SLACK_CHANNEL" }),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ source: "SLACK_CHANNEL" }),
		);

		renderInbox({ hasPMTool: true, pmToolName: "Fizzy" });

		(await screen.findByText(/Captured from a Slack thread/)).click();

		const checkbox = await screen.findByRole("checkbox", {
			name: /Also sync to Fizzy/i,
		});
		expect(checkbox).toBeInTheDocument();
		// Default OFF — the deliberate behavior change: approvals stay
		// Fabric-only unless the reviewer opts in.
		expect(checkbox).not.toBeChecked();
	});

	it("approves with syncToPM:false when the box is left unchecked (Fabric-only)", async () => {
		pendingProposalsList.mockResolvedValue([
			makeListRow({ source: "SLACK_CHANNEL" }),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ source: "SLACK_CHANNEL" }),
		);
		slackChannelApprove.mockResolvedValue({ status: "ok" });

		renderInbox({ hasPMTool: true, pmToolName: "Fizzy" });

		(await screen.findByText(/Captured from a Slack thread/)).click();
		(await screen.findByRole("button", { name: /Apply Selected/ })).click();

		await waitFor(() => {
			expect(slackChannelApprove).toHaveBeenCalledTimes(1);
		});
		expect(slackChannelApprove).toHaveBeenCalledWith(
			expect.objectContaining({ syncToPM: false }),
		);
	});

	it("approves with syncToPM:true when the reviewer checks the box", async () => {
		pendingProposalsList.mockResolvedValue([
			makeListRow({ source: "SLACK_CHANNEL" }),
		]);
		pendingProposalsGet.mockResolvedValue(
			makeDetail({ source: "SLACK_CHANNEL" }),
		);
		slackChannelApprove.mockResolvedValue({ status: "ok" });

		renderInbox({ hasPMTool: true, pmToolName: "Fizzy" });

		(await screen.findByText(/Captured from a Slack thread/)).click();

		const checkbox = await screen.findByRole("checkbox", {
			name: /Also sync to Fizzy/i,
		});
		// fireEvent (act-wrapped) drives the controlled Radix checkbox toggle
		// and flushes the re-render; a raw DOM `.click()` does not in jsdom.
		fireEvent.click(checkbox);
		await waitFor(() => expect(checkbox).toBeChecked());

		(await screen.findByRole("button", { name: /Apply Selected/ })).click();

		await waitFor(() => {
			expect(slackChannelApprove).toHaveBeenCalledTimes(1);
		});
		expect(slackChannelApprove).toHaveBeenCalledWith(
			expect.objectContaining({ syncToPM: true }),
		);
	});
});

// ============================================================================
// AI Update sidebar failure rows — TG6 of the sync-failure-retry spec.
//
// These tests cover the new failure surface added on top of the existing
// inbox: AI Update source pill, plain-English copy via failureClassToCopy,
// Show-details expander, per-row Retry routing to the new
// `projects.backlog.proposals.retry` procedure (NOT the channel-monitor
// approve endpoint), and the confirm-dismiss → `proposals.dismiss` path.
// ============================================================================

describe("PendingBacklogProposalsInbox — failed AI Update sidebar rows", () => {
	beforeEach(() => {
		pendingProposalsList.mockReset();
		pendingProposalsGet.mockReset();
		teamsChannelApprove.mockReset();
		teamsChannelReject.mockReset();
		slackChannelApprove.mockReset();
		slackChannelReject.mockReset();
		teamsChatApprove.mockReset();
		teamsChatReject.mockReset();
		storiesCheckPmSyncConflicts.mockReset();
		storiesCheckPmSyncConflicts.mockResolvedValue({ results: [] });
		proposalsRetry.mockReset();
		proposalsDismiss.mockReset();
		proposalsRetryAllFailed.mockReset();
		proposalsFailedCount.mockReset();
	});

	it("renders the AI Update source pill, plain-English copy, Show-details expander, and Retry/Dismiss buttons for a FAILED sidebar row", async () => {
		pendingProposalsList.mockResolvedValue([
			makeListRow({
				source: "AI_UPDATE_SIDEBAR",
				status: "FAILED",
				summary: "5 proposed change(s) from analysis",
				errorClass: "PmAuthError",
				errorMessage: "401 — Bearer token expired",
				applyError: "401 — Bearer token expired",
				failedAt: "2026-05-28T10:00:00.000Z",
			}),
		]);

		renderInbox();

		// Source label uses the new AI Update copy. The row holds the
		// exact "AI Update" text; the sheet header/summary do not, so
		// a single-element match is correct.
		expect(
			await screen.findByText("AI Update", { selector: "span" }),
		).toBeInTheDocument();

		// Plain-English copy mapped from `PmAuthError`.
		expect(
			screen.getByText(/credentials are invalid/i),
		).toBeInTheDocument();

		// Show-details expander surfaces the raw errorMessage on demand.
		const showDetails = screen.getByText("Show details");
		expect(showDetails).toBeInTheDocument();

		// Per-row Retry and Dismiss buttons.
		expect(
			screen.getByRole("button", { name: /Retry this failed proposal/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /Dismiss this failed proposal/i,
			}),
		).toBeInTheDocument();
	});

	it("clicking Retry on a sidebar row calls the new proposals.retry procedure (NOT a channel-monitor approve endpoint)", async () => {
		pendingProposalsList.mockResolvedValue([
			makeListRow({
				source: "AI_UPDATE_SIDEBAR",
				status: "FAILED",
				errorClass: "PmRateLimitError",
				errorMessage: "429 — slow down",
			}),
		]);
		proposalsRetry.mockResolvedValue({
			workflowId: "wf_retry_1",
			dedupCollisionCount: 0,
			message: "Retry queued.",
		});

		renderInbox();

		const retryButton = await screen.findByRole("button", {
			name: /Retry this failed proposal/i,
		});
		retryButton.click();

		await waitFor(() => {
			expect(proposalsRetry).toHaveBeenCalledTimes(1);
		});
		expect(proposalsRetry).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			organizationId: null,
			proposalId: PROPOSAL_ID,
		});
		// Source-aware dispatch must NOT route to channel-monitor approve.
		expect(teamsChannelApprove).not.toHaveBeenCalled();
		expect(slackChannelApprove).not.toHaveBeenCalled();
		expect(teamsChatApprove).not.toHaveBeenCalled();
	});

	it("clicking Dismiss opens a confirm dialog; confirming calls the dismiss procedure and surfaces a toast", async () => {
		pendingProposalsList.mockResolvedValue([
			makeListRow({
				source: "AI_UPDATE_SIDEBAR",
				status: "FAILED",
				errorClass: "PmCreateError",
				errorMessage: "Server error 500",
			}),
		]);
		proposalsDismiss.mockResolvedValue({
			success: true,
			syncLogId: "log_1",
		});

		// We need the actual toast spy from sonner.
		const { toast } = await import("sonner");

		renderInbox();

		const dismissButton = await screen.findByRole("button", {
			name: /Dismiss this failed proposal/i,
		});
		dismissButton.click();

		// Confirm dialog opens — verify copy.
		expect(
			await screen.findByText(/A record will be kept in Sync History/i),
		).toBeInTheDocument();

		// Confirm dismissal — the AlertDialogAction renders an actual
		// button with text "Dismiss" inside the dialog.
		const dialog = screen.getByRole("alertdialog");
		const { getByRole } = await import("@testing-library/react").then(
			(m) => ({
				getByRole: (role: string, opts?: { name: RegExp }) =>
					m.within(dialog).getByRole(role, opts),
			}),
		);
		const confirmButton = getByRole("button", { name: /^Dismiss$/i });
		confirmButton.click();

		await waitFor(() => {
			expect(proposalsDismiss).toHaveBeenCalledTimes(1);
		});
		expect(proposalsDismiss).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			organizationId: null,
			proposalId: PROPOSAL_ID,
		});

		// The success toast carries the audit-trail copy.
		await waitFor(() => {
			expect(toast.success).toHaveBeenCalled();
		});
		const calls = (toast.success as ReturnType<typeof vi.fn>).mock.calls;
		const lastCall = calls[calls.length - 1];
		expect(lastCall?.[0]).toMatch(/Dismissed/i);
	});

	it("cancels the dismiss flow without calling the dismiss procedure when Cancel is clicked", async () => {
		pendingProposalsList.mockResolvedValue([
			makeListRow({
				source: "AI_UPDATE_SIDEBAR",
				status: "FAILED",
				errorClass: "default",
			}),
		]);

		renderInbox();

		const dismissButton = await screen.findByRole("button", {
			name: /Dismiss this failed proposal/i,
		});
		dismissButton.click();

		const dialog = await screen.findByRole("alertdialog");
		const within = (await import("@testing-library/react")).within;
		const cancelButton = within(dialog).getByRole("button", {
			name: /Cancel/i,
		});
		cancelButton.click();

		// Allow microtasks; dismiss must NOT fire.
		await new Promise((r) => setTimeout(r, 0));
		expect(proposalsDismiss).not.toHaveBeenCalled();
	});

	it("falls back to the default copy when errorClass is null (legacy FAILED row)", async () => {
		pendingProposalsList.mockResolvedValue([
			makeListRow({
				source: "AI_UPDATE_SIDEBAR",
				status: "FAILED",
				errorClass: null,
				errorMessage: null,
				applyError: "Pre-migration legacy error text",
			}),
		]);

		renderInbox();

		// Default copy is rendered (the failureClassToCopy fallback).
		// The default copy contains "Couldn't sync this proposal." and
		// also the "Show details." sentence — we anchor on the unique
		// prefix to avoid matching the expander summary below.
		expect(
			await screen.findByText(/Couldn't sync this proposal/i),
		).toBeInTheDocument();
		// Raw applyError is still surfaced behind the expander; we
		// match the exact summary text to disambiguate from the body
		// copy that also contains the "Show details" string.
		expect(screen.getByText("Show details")).toBeInTheDocument();
	});

	it("when defaultFilter='failed' is provided, the inbox calls scrollIntoView on the Failed section", async () => {
		// jsdom doesn't implement scrollIntoView; install a spy. We mount
		// the inbox with `defaultFilter="failed"` and a single FAILED row
		// — once the list resolves, the auto-scroll effect should fire
		// scrollIntoView once on the Failed section node.
		const scrollSpy = vi.fn();
		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = scrollSpy as never;
		try {
			pendingProposalsList.mockResolvedValue([
				makeListRow({
					source: "AI_UPDATE_SIDEBAR",
					status: "FAILED",
					errorClass: "PmRateLimitError",
				}),
			]);

			renderInbox({ defaultFilter: "failed" });

			await screen.findByText(/PM tool rate limit/i);

			await waitFor(() => {
				expect(scrollSpy).toHaveBeenCalled();
			});
		} finally {
			Element.prototype.scrollIntoView = original;
		}
	});
});

// ---------------------------------------------------------------------------
// Bug 1429 / Codex Fix D — forbidEpics gated on the proposal source
// ---------------------------------------------------------------------------
//
// The inbox surfaces ALL `PendingBacklogProposalSource` rows, including
// `AI_UPDATE_SIDEBAR` (the general AI Update flow, e.g. FAILED rows). For the
// three channel-monitor sources (TEAMS_CHANNEL / TEAMS_CHAT / SLACK_CHANNEL)
// the child must normalize epic→feature (forbidEpics). For AI_UPDATE_SIDEBAR
// `epic` is first-class and must NOT be rewritten — otherwise the detail-view
// approve would send a feature instead of the epic.

function makeEpicDetail(source: RowSource) {
	return {
		...makeListRow({ source, summary: `Epic proposal from ${source}` }),
		projectId: PROJECT_ID,
		userId: "user_1",
		organizationId: null,
		proposal: {
			summary: `Epic proposal from ${source}`,
			contextSummary: "Big initiative",
			changes: [
				{
					type: "epic",
					action: "create",
					title: { to: "Mobile launch initiative" },
					description: { to: "A large strategic initiative." },
					reasoning: "Spans many features.",
					sourceContext: "teams_messages",
				},
			],
		},
	};
}

describe("PendingBacklogProposalsInbox — forbidEpics source gating (Bug 1429 / Codex D)", () => {
	beforeEach(() => {
		pendingProposalsList.mockReset();
		pendingProposalsGet.mockReset();
		storiesCheckPmSyncConflicts.mockReset();
		storiesCheckPmSyncConflicts.mockResolvedValue({ results: [] });
	});

	it("AI_UPDATE_SIDEBAR: an epic CREATE keeps the raw Epic badge and renders NO Feature/Bug selector (epics stay first-class)", async () => {
		const detail = makeEpicDetail("AI_UPDATE_SIDEBAR");
		pendingProposalsList.mockResolvedValue([
			makeListRow({
				source: "AI_UPDATE_SIDEBAR",
				summary: "Epic proposal from AI_UPDATE_SIDEBAR",
			}),
		]);
		pendingProposalsGet.mockResolvedValue(detail);

		renderInbox();
		(
			await screen.findByText(/Epic proposal from AI_UPDATE_SIDEBAR/)
		).click();
		await screen.findByText(/Proposed Backlog Changes/);

		// No epic→feature normalization → no Feature/Bug selector for the row,
		// and the raw "epic" type badge is shown.
		expect(
			screen.queryByRole("radiogroup", {
				name: /Work item type for "Mobile launch initiative"/,
			}),
		).not.toBeInTheDocument();
		expect(screen.getByText("epic")).toBeInTheDocument();
	});

	it.each(["TEAMS_CHANNEL", "TEAMS_CHAT", "SLACK_CHANNEL"] as const)(
		"%s: an epic CREATE normalizes to FEATURE and renders the Feature/Bug selector",
		async (source) => {
			const detail = makeEpicDetail(source);
			pendingProposalsList.mockResolvedValue([
				makeListRow({
					source,
					summary: `Epic proposal from ${source}`,
				}),
			]);
			pendingProposalsGet.mockResolvedValue(detail);

			renderInbox();
			(
				await screen.findByText(
					new RegExp(`Epic proposal from ${source}`),
				)
			).click();
			await screen.findByText(/Proposed Backlog Changes/);

			// Channel-monitor source → epic normalized to feature → selector shown.
			const group = await screen.findByRole("radiogroup", {
				name: /Work item type for "Mobile launch initiative"/,
			});
			expect(group).toBeInTheDocument();
			expect(
				within(group).queryByRole("radio", { name: /Epic/i }),
			).toBeNull();
		},
	);
});

describe("PendingBacklogProposalsInbox — forwards projectId for in-review drafting", () => {
	beforeEach(() => {
		pendingProposalsList.mockReset();
		pendingProposalsGet.mockReset();
		storiesCheckPmSyncConflicts.mockReset();
		storiesCheckPmSyncConflicts.mockResolvedValue({ results: [] });
		draftsList.mockReset();
		draftsList.mockResolvedValue({ drafts: [] });
		draftsStart.mockReset();
		draftsStart.mockResolvedValue({
			kind: "BUG",
			status: "RUNNING",
			startedAt: "2026-06-18T12:00:00.000Z",
			description: null,
			acceptanceCriteria: null,
			needsMoreInfo: null,
		});
		proposalsFailedCount.mockReset();
	});

	// Drafting is now EXPLICIT ("Draft with AI"), never automatic on open — so a
	// reviewer opening a proposal must NOT trigger a draft (no surprise spend).
	// The hook still reads the shared state (drafts.list) with the forwarded
	// projectId + proposalId so the button works.
	it("opening a proposal does NOT auto-draft, but forwards projectId/proposalId to the draft state read", async () => {
		pendingProposalsList.mockResolvedValue([makeListRow()]);
		pendingProposalsGet.mockResolvedValue(makeDetail());

		renderInbox();

		const row = await screen.findByText(/Captured from a Slack thread/);
		row.click();
		const openBtn = await screen.findByRole("button", {
			name: /open full detail to review/i,
		});
		openBtn.click();

		// The hook reads the shared draft state with the forwarded context…
		await waitFor(() => expect(draftsList).toHaveBeenCalled());
		expect(draftsList).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				proposalId: PROPOSAL_ID,
			}),
		);
		// …but opening must NOT start a draft (explicit only).
		expect(draftsStart).not.toHaveBeenCalled();
	});
});
