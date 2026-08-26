import type { DecisionPrecheckResult } from "@repo/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Database boundary — selective mocks. The Teams activity uses `db.$transaction`
// directly on the Prisma client (no helper indirection), so we stub the inner
// Prisma calls via a transaction-aware mock.
const getCachedProjectBacklog = vi.fn();
const markTeamsMessagesAsSeen = vi.fn();
const createMany = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		markTeamsMessagesAsSeen: (...a: unknown[]) =>
			markTeamsMessagesAsSeen(...a),
		db: {
			$transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({
					projectLinkedTeamsChannelSeenMessage: {
						createMany: (...a: unknown[]) => createMany(...a),
						updateMany: (...a: unknown[]) => updateMany(...a),
					},
					pendingBacklogProposal: {
						create: (...a: unknown[]) => create(...a),
					},
				}),
		},
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

vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

import { analyzeChannelThreadActivity } from "../analyze-channel-messages";
import type { FetchedThread } from "../fetch-new-messages";

const BASE_INPUT_WITHOUT_THREAD = {
	projectId: "p1",
	userId: "u1",
	organizationId: "o1",
	linkedChannelId: "lc1",
	// Microsoft Graph identifiers required for the apply-time orchestrator
	// to build the hostedContents download URL (bug_001 fix). Distinct from
	// the DB-cuid `linkedChannelId`.
	teamId: "team-graph-id",
	channelId: "19:abc@thread.tacv2",
	channelDisplayName: "engineering",
	channelWebUrl: "https://teams/engineering",
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

function buildThread(args: {
	pendingAttachments?: FetchedThread["pendingAttachments"];
	replyPendingAttachments?: FetchedThread["replies"][number]["pendingAttachments"];
}): FetchedThread {
	return {
		rootMessageId: "M1",
		rootCreatedAt: "2026-05-23T10:00:00.000Z",
		rootAuthor: "Alice",
		rootContent: "Bug repro: nav fails on Safari",
		rootWebLink: "https://teams/M1",
		replies: [
			{
				messageId: "M1-R1",
				author: "Bob",
				createdAt: "2026-05-23T10:01:00.000Z",
				content: "Repro'd locally, here's my env",
				webLink: "https://teams/M1-R1",
				pendingAttachments: args.replyPendingAttachments ?? [],
			},
		],
		threadLastActivity: "2026-05-23T10:01:00.000Z",
		pendingAttachments: args.pendingAttachments ?? [],
	};
}

describe("analyzeChannelThreadActivity — attachment sidecar", () => {
	beforeEach(() => {
		getCachedProjectBacklog.mockReset();
		markTeamsMessagesAsSeen.mockReset();
		createMany.mockReset();
		create.mockReset();
		updateMany.mockReset();
		analyzeContextAndPropose.mockReset();

		// Default-happy path: backlog load is empty, seen-marker claim
		// succeeds, proposal returned has one CREATE change.
		getCachedProjectBacklog.mockResolvedValue(EMPTY_BACKLOG);
		markTeamsMessagesAsSeen.mockResolvedValue(undefined);
		createMany.mockResolvedValue({ count: 1 });
		create.mockResolvedValue({ id: "pbp-teams-1" });
		updateMany.mockResolvedValue({ count: 1 });
		analyzeContextAndPropose.mockResolvedValue({
			summary: "Fix Safari nav crash",
			changes: [
				{
					type: "bug",
					action: "create",
					title: "Safari nav crashes",
					description: "users report nav fails on Safari",
				},
			],
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces pendingAttachments + attachmentWarnings on the activity result", async () => {
		const pendingAttachments = [
			{
				source: "teams" as const,
				ref: {
					id: "root-img-1",
					messageId: "M1",
					contentType: "application/octet-stream",
					altText: "step 1",
				},
			},
			{
				source: "teams" as const,
				ref: {
					id: "reply-img-1",
					messageId: "M1-R1",
					contentType: "application/octet-stream",
					altText: "my env",
				},
			},
		];

		const thread = buildThread({
			pendingAttachments,
			replyPendingAttachments: [pendingAttachments[1]],
		});

		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread,
		});

		expect(result.success).toBe(true);
		expect(result.pendingProposalId).toBe("pbp-teams-1");
		expect(result.pendingAttachments).toHaveLength(2);
		expect(result.pendingAttachments).toEqual(pendingAttachments);
		// Teams fetch path emits no fetch-time warnings — mirrors Slack
		// shape so the orchestrator treats both providers uniformly.
		expect(result.attachmentWarnings).toEqual([]);

		// Verify the proposal row received the sidecar via sourceMetadata.
		expect(create).toHaveBeenCalledTimes(1);
		const createArg = create.mock.calls[0][0] as {
			data: {
				sourceMetadata: {
					attachments: unknown[];
					attachmentWarnings: unknown[];
				};
			};
		};
		expect(createArg.data.sourceMetadata.attachments).toHaveLength(2);
		expect(createArg.data.sourceMetadata.attachmentWarnings).toEqual([]);
	});

	it("stores a headline derived from the change title when the analyzer summary is blank", async () => {
		// Monitored-source proposals routinely come back with no top-level
		// summary; the row must still show the change title.
		analyzeContextAndPropose.mockResolvedValueOnce({
			summary: "",
			changes: [
				{
					type: "bug",
					action: "create",
					title: { to: "Safari nav crashes" },
					description: "users report nav fails on Safari",
				},
			],
		});

		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: buildThread({}),
		});

		expect(create).toHaveBeenCalledTimes(1);
		const createArg = create.mock.calls[0][0] as {
			data: { summary: string };
		};
		expect(createArg.data.summary).toBe("Safari nav crashes");
	});

	it("persists Microsoft Graph teamId + channelId on sourceMetadata (bug_001)", async () => {
		// Regression test for bug_001: prior to this fix the workflow had
		// `channel.teamId` / `channel.channelId` in scope but never forwarded
		// them to the analyze activity, so `sourceMetadata` only carried the
		// DB-cuid `linkedChannelId` — the apply-time orchestrator then had no
		// way to build the Graph hostedContents URL and every Teams attachment
		// failed with `download_failed`. Pin the contract: the activity input
		// includes `teamId` + `channelId`, and the persisted JSON carries
		// them verbatim under those exact keys.
		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: buildThread({}),
		});

		expect(result.success).toBe(true);
		const createArg = create.mock.calls[0][0] as {
			data: { sourceMetadata: Record<string, unknown> };
		};
		expect(createArg.data.sourceMetadata.teamId).toBe("team-graph-id");
		expect(createArg.data.sourceMetadata.channelId).toBe(
			"19:abc@thread.tacv2",
		);
		// `linkedChannelId` stays for backward compat but MUST be distinct
		// from the Graph identifiers — building a Graph URL from a cuid 404s.
		expect(createArg.data.sourceMetadata.linkedChannelId).toBe("lc1");
		expect(createArg.data.sourceMetadata.linkedChannelId).not.toBe(
			createArg.data.sourceMetadata.channelId,
		);
	});

	it("invokes analyzeContextAndPropose with allowEpics:false (Bug 1429 — channel monitor is feature/bug-only)", async () => {
		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: buildThread({}),
		});
		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
		const callArg = analyzeContextAndPropose.mock.calls[0][0] as {
			allowEpics?: boolean;
		};
		expect(callArg.allowEpics).toBe(false);
	});

	it("LLM prompt input is byte-identical whether pendingAttachments is empty or populated (FR-9)", async () => {
		const baseThread = buildThread({});

		// Run 1 — no attachments.
		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: baseThread,
		});
		const firstCall = analyzeContextAndPropose.mock.calls[0][0] as {
			fetchedContext: { teamsMessages: string };
			userPrompt: string;
		};

		// Reset only the LLM-call mock so we can capture run 2 cleanly.
		analyzeContextAndPropose.mockClear();
		// `create` is called once per run — reset so the assertion above
		// doesn't leak into a second mock call.
		create.mockClear();

		// Run 2 — same thread content (same root/reply messages, same author
		// names, same timestamps) but with attachments populated.
		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: buildThread({
				pendingAttachments: [
					{
						source: "teams",
						ref: {
							id: "img-1",
							messageId: "M1",
							contentType: "application/octet-stream",
						},
					},
				],
				replyPendingAttachments: [],
			}),
		});
		const secondCall = analyzeContextAndPropose.mock.calls[0][0] as {
			fetchedContext: { teamsMessages: string };
			userPrompt: string;
		};

		// Both the formatted thread AND the constant prompt must match exactly.
		expect(secondCall.fetchedContext.teamsMessages).toBe(
			firstCall.fetchedContext.teamsMessages,
		);
		expect(secondCall.userPrompt).toBe(firstCall.userPrompt);
	});

	it("folds the proposal's decisionConflicts into sourceMetadata — omitted when the proposal carries none (finding #14)", async () => {
		// Run 1 — analyzer returns a proposal carrying a "conflicts" pre-check.
		analyzeContextAndPropose.mockResolvedValueOnce({
			summary: "Fix Safari nav crash",
			changes: [
				{
					type: "bug",
					action: "create",
					title: "Safari nav crashes",
					description: "users report nav fails on Safari",
				},
			],
			decisionConflicts: DECISION_PRECHECK_CONFLICTS,
		});
		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: buildThread({}),
		});
		// This fold is the only link that makes the contradiction warning durable
		// and the override loggable for the Teams channel monitor surface.
		const withConflicts = create.mock.calls[0][0] as {
			data: { sourceMetadata: { decisionPrecheck?: unknown } };
		};
		expect(withConflicts.data.sourceMetadata.decisionPrecheck).toEqual(
			DECISION_PRECHECK_CONFLICTS,
		);

		// Run 2 — default proposal (no decisionConflicts).
		create.mockClear();
		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: buildThread({}),
		});
		const withoutConflicts = create.mock.calls[0][0] as {
			data: { sourceMetadata: { decisionPrecheck?: unknown } };
		};
		expect(
			withoutConflicts.data.sourceMetadata.decisionPrecheck,
		).toBeUndefined();
	});
});
