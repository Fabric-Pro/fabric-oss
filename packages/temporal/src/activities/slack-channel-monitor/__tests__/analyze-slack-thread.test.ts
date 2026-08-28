import type { DecisionPrecheckResult } from "@repo/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Database boundary — all four methods are explicit stubs so the activity
// runs without touching Postgres.
const claimSlackMessageForAnalysis = vi.fn();
const getLinkedSlackChannelsForMonitor = vi.fn();
const getCachedProjectBacklog = vi.fn();
const createPendingBacklogProposal = vi.fn();
const attachProposalToSeenSlackMessage = vi.fn();

// Partial mock: keep every real export (constants, side-effect registrations,
// etc.) but override the specific functions this test cares about. Required
// because the transitive load chain (analyze-context → @repo/ai → @repo/payments)
// pulls many sibling exports we don't want to enumerate by hand.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		claimSlackMessageForAnalysis: (...a: unknown[]) =>
			claimSlackMessageForAnalysis(...a),
		getLinkedSlackChannelsForMonitor: (...a: unknown[]) =>
			getLinkedSlackChannelsForMonitor(...a),
		createPendingBacklogProposal: (...a: unknown[]) =>
			createPendingBacklogProposal(...a),
		attachProposalToSeenSlackMessage: (...a: unknown[]) =>
			attachProposalToSeenSlackMessage(...a),
		// Conversation capture (Fizzy #2228) runs between the fetch and the
		// claim and looks the channel's ProjectContext row up through this.
		// These fixtures register no such row, so capture correctly finds no
		// parent and writes nothing — which keeps this suite about the
		// attachment sidecar and the prompt bytes, exactly as before. Capture's
		// own behaviour is covered in
		// `__tests__/conversation-bundle-capture.test.ts`.
		db: { projectContext: { findMany: async () => [] } },
	};
});

// Mock the fetch activity so we control the full thread payload (including
// pendingAttachments + attachmentWarnings).
const fetchSlackThreadContextActivity = vi.fn();
vi.mock("../fetch-thread-context", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		fetchSlackThreadContextActivity: (...a: unknown[]) =>
			fetchSlackThreadContextActivity(...a),
	};
});

// Capture LLM-prompt input across runs to assert byte-identity.
const analyzeContextAndPropose = vi.fn();
vi.mock("../../backlog-context/analyze-context", () => ({
	analyzeContextAndPropose: (...a: unknown[]) =>
		analyzeContextAndPropose(...a),
}));

// Flat-backlog cache (stories only — the Epic/Feature folder tables were dropped).
vi.mock("../../backlog-context/project-backlog-cache", () => ({
	getCachedProjectBacklog: (...a: unknown[]) => getCachedProjectBacklog(...a),
}));

// Temporal activity heartbeat is a no-op in tests.
vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

import { analyzeSlackThreadActivity } from "../analyze-slack-thread";

const BASE_INPUT = {
	projectId: "p1",
	userId: "u1",
	organizationId: "o1",
	channelId: "C1",
	threadRootTs: "1700000000.000100",
};

const LINKED_CHANNEL = {
	id: "lcs1",
	channelId: "C1",
	slackTeamId: "T1",
	channelName: "engineering",
	teamName: "Eng",
	channelWebUrl: "https://slack.com/archives/C1",
};

const EMPTY_BACKLOG = { stories: [] };

// A pre-check that flagged one contradiction — the ride-along shape
// `analyzeContextAndPropose` attaches to a proposal as `decisionConflicts`.
const DECISION_PRECHECK_CONFLICTS: DecisionPrecheckResult = {
	checkedAt: "2026-07-10T00:00:00.000Z",
	status: "conflicts",
	findings: [
		{
			decisionId: "dec-1",
			decisionIdentifier: "ADR-012",
			decisionTitle: "Use Postgres for primary storage",
			natureOfConflict: "Proposes migrating primary storage to DynamoDB",
			conflictType: "reintroduces_rejected",
			confidence: 0.9,
		},
	],
};

describe("analyzeSlackThreadActivity — attachment sidecar", () => {
	beforeEach(() => {
		claimSlackMessageForAnalysis.mockReset();
		getLinkedSlackChannelsForMonitor.mockReset();
		getCachedProjectBacklog.mockReset();
		createPendingBacklogProposal.mockReset();
		attachProposalToSeenSlackMessage.mockReset();
		fetchSlackThreadContextActivity.mockReset();
		analyzeContextAndPropose.mockReset();

		// Default-happy path: linked channel exists, claim succeeds, proposal
		// returned has one CREATE change.
		getLinkedSlackChannelsForMonitor.mockResolvedValue([LINKED_CHANNEL]);
		claimSlackMessageForAnalysis.mockResolvedValue(true);
		getCachedProjectBacklog.mockResolvedValue(EMPTY_BACKLOG);
		createPendingBacklogProposal.mockResolvedValue({ id: "pbp-1" });
		attachProposalToSeenSlackMessage.mockResolvedValue(undefined);
		analyzeContextAndPropose.mockResolvedValue({
			summary: "Investigate auth crash",
			changes: [
				{
					// The analyzer emits feature/bug only now — "story" was
					// retired (DSU 2026-05-23), so it can no longer appear here.
					type: "feature",
					action: "create",
					title: "Auth crash on /login",
					description: "users report 500 on submit",
				},
			],
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces pendingAttachments + attachmentWarnings on the activity result", async () => {
		fetchSlackThreadContextActivity.mockResolvedValue({
			messages: [
				{
					ts: "1700000000.000100",
					sender: "U1",
					content: "see attached screenshot",
					createdAt: "2026-05-23T10:00:00.000Z",
					threadTs: "1700000000.000100",
				},
			],
			truncated: false,
			pendingAttachments: [
				{
					source: "slack",
					messageTs: "1700000000.000100",
					file: {
						id: "F-png",
						name: "shot.png",
						mimetype: "image/png",
						urlPrivate:
							"https://files.slack.com/files-pri/T1-F1/shot.png",
						size: 1024,
					},
				},
			],
			attachmentWarnings: [
				{
					source: "slack",
					refId: "F-svg",
					reason: "unsupported_mime",
					detail: "image/svg+xml",
				},
			],
		});

		const result = await analyzeSlackThreadActivity(BASE_INPUT);

		expect(result.success).toBe(true);
		expect(result.pendingProposalId).toBe("pbp-1");
		expect(result.pendingAttachments).toHaveLength(1);
		expect(result.pendingAttachments[0]).toMatchObject({
			source: "slack",
			file: { id: "F-png" },
		});
		expect(result.attachmentWarnings).toHaveLength(1);
		expect(result.attachmentWarnings[0]).toMatchObject({
			reason: "unsupported_mime",
			refId: "F-svg",
		});

		// Verify the proposal row received the sidecar via sourceMetadata.
		expect(createPendingBacklogProposal).toHaveBeenCalledTimes(1);
		const call = createPendingBacklogProposal.mock.calls[0][0] as {
			sourceMetadata: {
				attachments: unknown[];
				attachmentWarnings: unknown[];
			};
		};
		expect(call.sourceMetadata.attachments).toHaveLength(1);
		expect(call.sourceMetadata.attachmentWarnings).toHaveLength(1);
	});

	it("invokes analyzeContextAndPropose with allowEpics:false (Bug 1429 — channel monitor is feature/bug-only)", async () => {
		fetchSlackThreadContextActivity.mockResolvedValue({
			messages: [
				{
					ts: "1700000000.000100",
					sender: "U1",
					content: "users hit a 500 on login",
					createdAt: "2026-05-23T10:00:00.000Z",
					threadTs: "1700000000.000100",
				},
			],
			truncated: false,
			pendingAttachments: [],
			attachmentWarnings: [],
		});
		await analyzeSlackThreadActivity(BASE_INPUT);
		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
		const callArg = analyzeContextAndPropose.mock.calls[0][0] as {
			allowEpics?: boolean;
		};
		expect(callArg.allowEpics).toBe(false);
	});

	it("LLM prompt input is byte-identical whether pendingAttachments is empty or populated (FR-4)", async () => {
		// Run 1 — no attachments.
		fetchSlackThreadContextActivity.mockResolvedValueOnce({
			messages: [
				{
					ts: "1700000000.000100",
					sender: "U1",
					content: "users hit a 500 on login",
					createdAt: "2026-05-23T10:00:00.000Z",
					threadTs: "1700000000.000100",
				},
			],
			truncated: false,
			pendingAttachments: [],
			attachmentWarnings: [],
		});
		await analyzeSlackThreadActivity(BASE_INPUT);
		const firstCall = analyzeContextAndPropose.mock.calls[0][0] as {
			fetchedContext: { slackMessages: string };
			userPrompt: string;
		};

		// Reset only the LLM-call mock so we can capture run 2 cleanly.
		analyzeContextAndPropose.mockClear();

		// Run 2 — same messages, but with attachments populated.
		fetchSlackThreadContextActivity.mockResolvedValueOnce({
			messages: [
				{
					ts: "1700000000.000100",
					sender: "U1",
					content: "users hit a 500 on login",
					createdAt: "2026-05-23T10:00:00.000Z",
					threadTs: "1700000000.000100",
					files: [
						{
							id: "F-png",
							name: "shot.png",
							mimetype: "image/png",
							urlPrivate:
								"https://files.slack.com/files-pri/T1-F1/shot.png",
							size: 1024,
						},
					],
				},
			],
			truncated: false,
			pendingAttachments: [
				{
					source: "slack",
					messageTs: "1700000000.000100",
					file: {
						id: "F-png",
						name: "shot.png",
						mimetype: "image/png",
						urlPrivate:
							"https://files.slack.com/files-pri/T1-F1/shot.png",
						size: 1024,
					},
				},
			],
			attachmentWarnings: [],
		});
		await analyzeSlackThreadActivity(BASE_INPUT);
		const secondCall = analyzeContextAndPropose.mock.calls[0][0] as {
			fetchedContext: { slackMessages: string };
			userPrompt: string;
		};

		// Both the formatted thread AND the constant prompt must match exactly.
		expect(secondCall.fetchedContext.slackMessages).toBe(
			firstCall.fetchedContext.slackMessages,
		);
		expect(secondCall.userPrompt).toBe(firstCall.userPrompt);
	});

	it("folds the proposal's decisionConflicts into the persisted proposal — omitted when the proposal carries none (finding #14)", async () => {
		// Same thread payload for both runs; this test isolates whether the
		// analyzer's decisionConflicts ride-along reaches the durable proposal.
		fetchSlackThreadContextActivity.mockResolvedValue({
			messages: [
				{
					ts: "1700000000.000100",
					sender: "U1",
					content: "users hit a 500 on login",
					createdAt: "2026-05-23T10:00:00.000Z",
					threadTs: "1700000000.000100",
				},
			],
			truncated: false,
			pendingAttachments: [],
			attachmentWarnings: [],
		});

		// Run 1 — analyzer returns a proposal carrying a "conflicts" pre-check.
		analyzeContextAndPropose.mockResolvedValueOnce({
			summary: "Investigate auth crash",
			changes: [
				{
					type: "feature",
					action: "create",
					title: "Auth crash on /login",
					description: "users report 500 on submit",
				},
			],
			decisionConflicts: DECISION_PRECHECK_CONFLICTS,
		});
		await analyzeSlackThreadActivity(BASE_INPUT);

		// Run 2 — default analyzer proposal (no decisionConflicts).
		await analyzeSlackThreadActivity(BASE_INPUT);

		expect(createPendingBacklogProposal).toHaveBeenCalledTimes(2);
		// This fold is the only link that makes the contradiction warning durable
		// and the override loggable for the Slack monitor surface — the helper
		// takes `decisionPrecheck` top-level and merges it into
		// `sourceMetadata.decisionPrecheck`.
		expect(createPendingBacklogProposal.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				decisionPrecheck: DECISION_PRECHECK_CONFLICTS,
			}),
		);
		// No conflicts on the proposal ⇒ nothing folded in.
		expect(createPendingBacklogProposal.mock.calls[1][0]).toEqual(
			expect.objectContaining({ decisionPrecheck: undefined }),
		);
	});
});
