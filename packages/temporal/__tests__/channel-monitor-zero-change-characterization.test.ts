/**
 * Characterization of the two CHANNEL analyzers' zero-change return, pinned
 * BEFORE conversation capture was inserted into them (Fizzy #2228, U5).
 *
 * The whole point of U5 is that a monitored channel's messages survive an
 * analyzer run that proposes nothing — the branch where content was being lost.
 * Capture is inserted ahead of that branch, so the branch itself is exactly the
 * thing most at risk of being changed by accident. These assertions describe
 * the contract as it stood beforehand: the shape of the output object, the
 * skip reason, and — for each provider — the writes the branch does and does
 * NOT perform.
 *
 * They are deliberately capture-agnostic: nothing here mentions bundles, so a
 * later refactor of capture cannot make them pass by moving with it. If one of
 * these goes red, the analyzer's own contract moved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	// Shared
	analyzeContextAndPropose: vi.fn(),
	getCachedProjectBacklog: vi.fn(),
	// Teams
	markTeamsMessagesAsSeen: vi.fn(),
	teamsTransaction: vi.fn(),
	// Slack
	claimSlackMessageForAnalysis: vi.fn(),
	attachProposalToSeenSlackMessage: vi.fn(),
	createPendingBacklogProposal: vi.fn(),
	getLinkedSlackChannelsForMonitor: vi.fn(),
	fetchSlackThreadContext: vi.fn(),
	// Job hub
	jobEnsure: vi.fn(),
	jobIncrement: vi.fn(),
	jobStep: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: {
			$transaction: m.teamsTransaction,
			projectContext: { findMany: vi.fn().mockResolvedValue([]) },
			projectLinkedSlackChannel: { findUnique: vi.fn() },
		},
		markTeamsMessagesAsSeen: m.markTeamsMessagesAsSeen,
		resolveProposalSummary: (summary: string) => summary,
		claimSlackMessageForAnalysis: m.claimSlackMessageForAnalysis,
		attachProposalToSeenSlackMessage: m.attachProposalToSeenSlackMessage,
		createPendingBacklogProposal: m.createPendingBacklogProposal,
		getLinkedSlackChannelsForMonitor: m.getLinkedSlackChannelsForMonitor,
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

vi.mock("../src/activities/backlog-context/analyze-context", () => ({
	analyzeContextAndPropose: m.analyzeContextAndPropose,
}));

vi.mock("../src/activities/backlog-context/project-backlog-cache", () => ({
	getCachedProjectBacklog: m.getCachedProjectBacklog,
}));

vi.mock("../src/activities/lib/job-progress", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../src/activities/lib/job-progress")
		>();
	return {
		...actual,
		jobEnsure: m.jobEnsure,
		jobIncrement: m.jobIncrement,
		jobStep: m.jobStep,
	};
});

vi.mock("../src/activities/slack-channel-monitor/fetch-thread-context", () => ({
	fetchSlackThreadContextActivity: m.fetchSlackThreadContext,
}));

import { analyzeSlackThreadActivity } from "../src/activities/slack-channel-monitor/analyze-slack-thread";
import { analyzeChannelThreadActivity } from "../src/activities/teams-channel-monitor/analyze-channel-messages";

const TEAMS_INPUT = {
	projectId: "proj_1",
	userId: "user_1",
	organizationId: "org_1",
	linkedChannelId: "lc_teams_1",
	teamId: "team-guid",
	channelId: "19:channel@thread.tacv2",
	channelDisplayName: "engineering",
	thread: {
		rootMessageId: "1700000000000",
		rootCreatedAt: "2026-08-20T10:00:00.000Z",
		rootAuthor: "Ada",
		rootContent: "The importer times out on large files.",
		replies: [
			{
				messageId: "1700000060000",
				author: "Grace",
				createdAt: "2026-08-20T10:01:00.000Z",
				content: "Reproduced with a 2 GB CSV.",
			},
		],
		threadLastActivity: "2026-08-20T10:01:00.000Z",
	},
};

const SLACK_INPUT = {
	projectId: "proj_1",
	userId: "user_1",
	organizationId: "org_1",
	channelId: "C123",
	threadRootTs: "1700000000.000100",
	linkedChannelId: "lc_slack_1",
	slackTeamId: "T1",
	channelDisplayName: "engineering",
	channelWebUrl: "https://example.slack.com/archives/C123",
};

const SLACK_THREAD = {
	messages: [
		{
			ts: "1700000000.000100",
			sender: "Ada",
			content: "The importer times out on large files.",
			createdAt: "2026-08-20T10:00:00.000Z",
		},
		{
			ts: "1700000060.000200",
			sender: "Grace",
			content: "Reproduced with a 2 GB CSV.",
			createdAt: "2026-08-20T10:01:00.000Z",
		},
	],
	truncated: false,
	pendingAttachments: [],
	attachmentWarnings: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	m.getCachedProjectBacklog.mockResolvedValue({ items: [] });
	m.analyzeContextAndPropose.mockResolvedValue({
		changes: [],
		summary: "nothing to propose",
	});
	m.claimSlackMessageForAnalysis.mockResolvedValue(true);
	m.fetchSlackThreadContext.mockResolvedValue(SLACK_THREAD);
	m.markTeamsMessagesAsSeen.mockResolvedValue(undefined);
});

describe("Teams channel analyzer — zero-change return (pre-capture contract)", () => {
	it("returns success with changeCount 0 and skippedReason no_relevant_content", async () => {
		const result = await analyzeChannelThreadActivity(TEAMS_INPUT);

		expect(result).toMatchObject({
			success: true,
			changeCount: 0,
			skippedReason: "no_relevant_content",
		});
		expect(result.pendingProposalId).toBeUndefined();
		expect(result.pendingAttachments).toEqual([]);
		expect(result.attachmentWarnings).toEqual([]);
	});

	it("marks the thread root seen and writes NO proposal transaction", async () => {
		await analyzeChannelThreadActivity(TEAMS_INPUT);

		expect(m.markTeamsMessagesAsSeen).toHaveBeenCalledWith(
			"lc_teams_1",
			["1700000000000"],
			null,
		);
		// The proposal transaction is the other branch — it must not run.
		expect(m.teamsTransaction).not.toHaveBeenCalled();
	});

	it("hands the analyzer the formatted thread under fetchedContext.teamsMessages", async () => {
		await analyzeChannelThreadActivity(TEAMS_INPUT);

		const call = m.analyzeContextAndPropose.mock.calls[0][0];
		expect(call.fetchedContext.teamsMessages).toContain(
			"## Thread in #engineering",
		);
		expect(call.fetchedContext.teamsMessages).toContain(
			"The importer times out on large files.",
		);
		expect(call.fetchedContext.teamsMessages).toContain(
			"Reproduced with a 2 GB CSV.",
		);
	});
});

describe("Slack channel analyzer — zero-change return (pre-capture contract)", () => {
	it("returns success with changeCount 0 and skippedReason no_relevant_content", async () => {
		const result = await analyzeSlackThreadActivity(SLACK_INPUT);

		expect(result).toMatchObject({
			success: true,
			changeCount: 0,
			skippedReason: "no_relevant_content",
		});
		expect(result.pendingProposalId).toBeUndefined();
	});

	it("writes no proposal and never attaches one to the seen row", async () => {
		await analyzeSlackThreadActivity(SLACK_INPUT);

		expect(m.createPendingBacklogProposal).not.toHaveBeenCalled();
		expect(m.attachProposalToSeenSlackMessage).not.toHaveBeenCalled();
	});

	it("returns already_seen without calling the analyzer when the claim is lost", async () => {
		m.claimSlackMessageForAnalysis.mockResolvedValue(false);

		const result = await analyzeSlackThreadActivity(SLACK_INPUT);

		expect(result).toMatchObject({
			success: true,
			changeCount: 0,
			skippedReason: "already_seen",
		});
		expect(m.analyzeContextAndPropose).not.toHaveBeenCalled();
	});

	it("returns no_linked_channel without fetching when the link is gone", async () => {
		m.getLinkedSlackChannelsForMonitor.mockResolvedValue([]);

		const result = await analyzeSlackThreadActivity({
			projectId: "proj_1",
			userId: "user_1",
			organizationId: "org_1",
			channelId: "C123",
			threadRootTs: "1700000000.000100",
		});

		expect(result).toMatchObject({
			success: true,
			changeCount: 0,
			skippedReason: "no_linked_channel",
		});
		expect(m.fetchSlackThreadContext).not.toHaveBeenCalled();
		expect(m.claimSlackMessageForAnalysis).not.toHaveBeenCalled();
	});

	it("hands the analyzer the formatted thread under fetchedContext.slackMessages", async () => {
		await analyzeSlackThreadActivity(SLACK_INPUT);

		const call = m.analyzeContextAndPropose.mock.calls[0][0];
		expect(call.fetchedContext.slackMessages).toContain(
			"## Thread in #engineering",
		);
		expect(call.fetchedContext.slackMessages).toContain(
			"Reproduced with a 2 GB CSV.",
		);
	});
});
