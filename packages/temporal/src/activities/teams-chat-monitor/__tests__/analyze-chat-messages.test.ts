import type { DecisionPrecheckResult } from "@repo/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Database boundary — selective mocks. The Teams chat activity uses
// `db.$transaction` directly (no helper indirection), so we stub the inner
// Prisma calls via a transaction-aware mock. Mirrors the channel-monitor
// caller test (`teams-channel-monitor/__tests__/analyze-channel-messages.test.ts`).
const getCachedProjectBacklog = vi.fn();
const markTeamsChatMessagesAsSeen = vi.fn();
const createMany = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		markTeamsChatMessagesAsSeen: (...a: unknown[]) =>
			markTeamsChatMessagesAsSeen(...a),
		db: {
			$transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({
					projectLinkedTeamsChatSeenMessage: {
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

// Capture the analyzer-call input so we can assert `allowEpics: false`.
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

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { analyzeChatThreadActivity } from "../analyze-chat-messages";
import type { FetchedChatThread } from "../fetch-new-messages";

const BASE_INPUT = {
	projectId: "p1",
	userId: "u1",
	organizationId: "o1",
	linkedChatId: "lc1",
	chatTopic: "Eng sync",
	chatWebUrl: "https://teams/chat",
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

function buildThread(): FetchedChatThread {
	return {
		rootMessageId: "M1",
		rootCreatedAt: "2026-05-23T10:00:00.000Z",
		rootAuthor: "Alice",
		rootContent:
			"We need a big mobile launch initiative spanning many areas",
		rootWebLink: "https://teams/M1",
		replies: [],
		threadLastActivity: "2026-05-23T10:00:00.000Z",
		messageIds: ["M1"],
	};
}

describe("analyzeChatThreadActivity — epic suppression (Bug 1429, Codex Fix C)", () => {
	beforeEach(() => {
		getCachedProjectBacklog.mockReset();
		markTeamsChatMessagesAsSeen.mockReset();
		createMany.mockReset();
		create.mockReset();
		updateMany.mockReset();
		analyzeContextAndPropose.mockReset();

		getCachedProjectBacklog.mockResolvedValue(EMPTY_BACKLOG);
		markTeamsChatMessagesAsSeen.mockResolvedValue(undefined);
		createMany.mockResolvedValue({ count: 1 });
		create.mockResolvedValue({ id: "pbp-chat-1" });
		updateMany.mockResolvedValue({ count: 1 });
		analyzeContextAndPropose.mockResolvedValue({
			summary: "Mobile launch",
			changes: [
				{
					type: "feature",
					action: "create",
					title: "Mobile launch",
					description: "ship it",
				},
			],
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("invokes analyzeContextAndPropose with allowEpics:false (TEAMS_CHAT is feature/bug-only)", async () => {
		await analyzeChatThreadActivity({
			...BASE_INPUT,
			thread: buildThread(),
		});

		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
		const callArg = analyzeContextAndPropose.mock.calls[0][0] as {
			allowEpics?: boolean;
		};
		expect(callArg.allowEpics).toBe(false);
	});

	it("folds the proposal's decisionConflicts into sourceMetadata — omitted when the proposal carries none (finding #14)", async () => {
		// Run 1 — analyzer returns a proposal carrying a "conflicts" pre-check.
		analyzeContextAndPropose.mockResolvedValueOnce({
			summary: "Mobile launch",
			changes: [
				{
					type: "feature",
					action: "create",
					title: "Mobile launch",
					description: "ship it",
				},
			],
			decisionConflicts: DECISION_PRECHECK_CONFLICTS,
		});
		await analyzeChatThreadActivity({
			...BASE_INPUT,
			thread: buildThread(),
		});
		// This fold is the only link that makes the contradiction warning durable
		// and the override loggable for the Teams chat monitor surface.
		const withConflicts = create.mock.calls[0][0] as {
			data: { sourceMetadata: { decisionPrecheck?: unknown } };
		};
		expect(withConflicts.data.sourceMetadata.decisionPrecheck).toEqual(
			DECISION_PRECHECK_CONFLICTS,
		);

		// Run 2 — default proposal (no decisionConflicts).
		create.mockClear();
		await analyzeChatThreadActivity({
			...BASE_INPUT,
			thread: buildThread(),
		});
		const withoutConflicts = create.mock.calls[0][0] as {
			data: { sourceMetadata: { decisionPrecheck?: unknown } };
		};
		expect(
			withoutConflicts.data.sourceMetadata.decisionPrecheck,
		).toBeUndefined();
	});
});
