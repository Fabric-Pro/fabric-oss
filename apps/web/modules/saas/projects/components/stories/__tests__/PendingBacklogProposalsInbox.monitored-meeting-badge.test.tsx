/**
 * PendingBacklogProposalsInbox — MONITORED_MEETING source badge.
 *
 * Spec `ai-update-auto-scan`, Task 7.3 (AC3). Auto-analyzed monitored-meeting
 * transcripts land in the unified Feature Proposals inbox with
 * `source === "MONITORED_MEETING"`. The `ProposalSourceBadge` renders a
 * calendar-icon chip whose label prefers `sourceMetadata.meetingSubject`
 * ("From {meetingSubject}") and falls back to "From a monitored meeting"
 * when the subject is absent. These tests mount the real inbox and assert
 * the badge text on the PENDING list row (no detail drill-in needed).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pendingProposalsList = vi.fn();
const pendingProposalsGet = vi.fn();
const teamsChannelApprove = vi.fn();
const teamsChannelReject = vi.fn();
const slackChannelApprove = vi.fn();
const slackChannelReject = vi.fn();
const teamsChatApprove = vi.fn();
const teamsChatReject = vi.fn();
const storiesCheckPmSyncConflicts = vi.fn().mockResolvedValue({ results: [] });
const proposalsRetry = vi.fn();
const proposalsDismiss = vi.fn();
const proposalsRetryAllFailed = vi.fn();
const proposalsFailedCount = vi.fn();

// The inbox imports `@shared/lib/orpc-client`; its child
// `BacklogChangeProposal` imports the same module via a relative specifier.
// vitest tracks mocks per specifier, so register the SAME shape at both to
// avoid one mock dedupe-replacing the other (which would strand the inbox in
// the "All caught up" empty state). `vi.mock` is hoisted above any top-level
// const, so each factory must construct its own object literal (referencing a
// shared outer const throws a TDZ ReferenceError) — mirrors the sibling inbox
// test file.
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
			update: vi.fn().mockResolvedValue({}),
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
					list: vi.fn().mockResolvedValue({ drafts: [] }),
					start: vi.fn().mockResolvedValue({}),
					cancel: vi.fn().mockResolvedValue({ cancelled: true }),
				},
			},
			stories: {
				checkPmSyncConflicts: (...args: unknown[]) =>
					storiesCheckPmSyncConflicts(...args),
				retryPmSyncBatch: vi.fn(),
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
			update: vi.fn().mockResolvedValue({}),
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
					list: vi.fn().mockResolvedValue({ drafts: [] }),
					start: vi.fn().mockResolvedValue({}),
					cancel: vi.fn().mockResolvedValue({ cancelled: true }),
				},
			},
			stories: {
				checkPmSyncConflicts: (...args: unknown[]) =>
					storiesCheckPmSyncConflicts(...args),
				retryPmSyncBatch: vi.fn(),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: () => ({
					queryKey: ["projects-get"],
					queryFn: async () => ({ project: {} }),
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

const PROJECT_ID = "project_1";

function makeMeetingRow(
	overrides: Partial<{
		id: string;
		sourceMetadata: Record<string, unknown> | null;
		summary: string;
	}> = {},
) {
	return {
		id: overrides.id ?? "proposal_meeting_1",
		source: "MONITORED_MEETING",
		status: "PENDING" as const,
		summary: overrides.summary ?? "Captured from a monitored meeting",
		changeCount: 2,
		sourceMetadata:
			overrides.sourceMetadata === undefined
				? null
				: overrides.sourceMetadata,
		applyError: null,
		errorClass: null,
		errorMessage: null,
		failedAt: null,
		createdAt: "2026-06-16T12:00:00.000Z",
		reviewedAt: null,
		appliedAt: null,
	};
}

function renderInbox() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<PendingBacklogProposalsInbox
				open
				onOpenChange={vi.fn()}
				projectId={PROJECT_ID}
				organizationId={null}
			/>
		</QueryClientProvider>,
	);
}

describe("PendingBacklogProposalsInbox — MONITORED_MEETING badge", () => {
	beforeEach(() => {
		pendingProposalsList.mockReset();
		pendingProposalsGet.mockReset();
		storiesCheckPmSyncConflicts.mockReset();
		storiesCheckPmSyncConflicts.mockResolvedValue({ results: [] });
	});

	it("renders 'From {meetingSubject}' when sourceMetadata.meetingSubject is present", async () => {
		pendingProposalsList.mockResolvedValue([
			makeMeetingRow({
				sourceMetadata: {
					meetingSubject: "Sprint Planning",
					meetingId: "m1",
					transcriptId: "t1",
				},
			}),
		]);

		renderInbox();

		expect(
			await screen.findByText("From Sprint Planning"),
		).toBeInTheDocument();
	});

	it("falls back to 'From a monitored meeting' when no meeting subject is present", async () => {
		pendingProposalsList.mockResolvedValue([
			makeMeetingRow({ sourceMetadata: { meetingId: "m1" } }),
		]);

		renderInbox();

		expect(
			await screen.findByText("From a monitored meeting"),
		).toBeInTheDocument();
	});

	it("falls back to 'From a monitored meeting' when sourceMetadata is null", async () => {
		pendingProposalsList.mockResolvedValue([
			makeMeetingRow({ sourceMetadata: null }),
		]);

		renderInbox();

		expect(
			await screen.findByText("From a monitored meeting"),
		).toBeInTheDocument();
	});

	it("renders 'Proposal Inbox' header title when drawer is open", async () => {
		pendingProposalsList.mockResolvedValue([]);

		renderInbox();

		expect(
			await screen.findByRole("heading", { name: "Proposal Inbox" }),
		).toBeInTheDocument();
	});
});
