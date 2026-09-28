/**
 * Tests for the app-authored-bundle skip — chat-monitor
 * sibling of `teams-channel-monitor/__tests__/app-authored-thread-skip.test.ts`.
 *
 * `isAppAuthoredOnly` lets `analyzeChatThreadActivity` skip the
 * `analyzeContextAndPropose` call for a bundle where root AND every reply are
 * positively known to be application-authored, while failing OPEN (still
 * analyzing) on any user- or unknown-authored message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const analyzeContextAndPropose = vi.fn();
vi.mock("../../backlog-context/analyze-context", () => ({
	analyzeContextAndPropose: (...a: unknown[]) =>
		analyzeContextAndPropose(...a),
}));

vi.mock("../../backlog-context/project-backlog-cache", () => ({
	getCachedProjectBacklog: (...a: unknown[]) => getCachedProjectBacklog(...a),
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	analyzeChatThreadActivity,
	isAppAuthoredOnly,
} from "../analyze-chat-messages";
import type { FetchedChatThread } from "../fetch-new-messages";

const BASE_INPUT = {
	projectId: "p1",
	userId: "u1",
	organizationId: "o1",
	linkedChatId: "lc1",
	chatTopic: "Alerts",
	chatWebUrl: "https://teams/chat",
};

const EMPTY_BACKLOG = { stories: [] };

function buildThread(
	overrides: Partial<FetchedChatThread> = {},
): FetchedChatThread {
	return {
		rootMessageId: "M1",
		rootCreatedAt: "2026-05-23T10:00:00.000Z",
		rootAuthor: "Alerts Bot",
		rootContent: "Deploy alert fired",
		rootWebLink: "https://teams/M1",
		rootFromKind: "application",
		replies: [],
		threadLastActivity: "2026-05-23T10:00:00.000Z",
		messageIds: ["M1"],
		...overrides,
	};
}

describe("isAppAuthoredOnly (chat)", () => {
	it("is true for an application-authored root with no replies", () => {
		expect(isAppAuthoredOnly(buildThread())).toBe(true);
	});

	it("is true when the root and every reply are application-authored", () => {
		const thread = buildThread({
			replies: [
				{
					messageId: "M1-R1",
					author: "Alerts Bot",
					fromKind: "application",
					createdAt: "2026-05-23T10:01:00.000Z",
					content: "Still firing",
				},
			],
			messageIds: ["M1", "M1-R1"],
		});
		expect(isAppAuthoredOnly(thread)).toBe(true);
	});

	it("is false when the root is user-authored", () => {
		const thread = buildThread({
			rootFromKind: "user",
			rootAuthor: "Alice",
		});
		expect(isAppAuthoredOnly(thread)).toBe(false);
	});

	it("is false when any reply is user-authored (fails open)", () => {
		const thread = buildThread({
			replies: [
				{
					messageId: "M1-R1",
					author: "Carol Oncall",
					fromKind: "user",
					createdAt: "2026-05-23T10:01:00.000Z",
					content: "Investigating",
				},
			],
			messageIds: ["M1", "M1-R1"],
		});
		expect(isAppAuthoredOnly(thread)).toBe(false);
	});

	it("is false when any reply is unknown-authored (fails open)", () => {
		const thread = buildThread({
			replies: [
				{
					messageId: "M1-R1",
					author: "Unknown",
					fromKind: "unknown",
					createdAt: "2026-05-23T10:01:00.000Z",
					content: "???",
				},
			],
			messageIds: ["M1", "M1-R1"],
		});
		expect(isAppAuthoredOnly(thread)).toBe(false);
	});

	it("is false when the root's fromKind is missing (older fetch result — fails open)", () => {
		const thread = buildThread();
		delete (thread as { rootFromKind?: string }).rootFromKind;
		expect(isAppAuthoredOnly(thread)).toBe(false);
	});
});

describe("analyzeChatThreadActivity — app-authored bundle skip", () => {
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
		// If the analyzer IS invoked (it must not be, on the skip path),
		// return a change so a missed skip fails loudly as a created
		// proposal rather than being masked by the zero-change branch.
		analyzeContextAndPropose.mockResolvedValue({
			summary: "should not be reached",
			changes: [
				{
					type: "bug",
					action: "create",
					title: "should not be reached",
					description: "should not be reached",
				},
			],
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("skips analyzeContextAndPropose and marks every message in the bundle seen for an all-application bundle", async () => {
		const result = await analyzeChatThreadActivity({
			...BASE_INPUT,
			thread: buildThread(),
		});

		expect(analyzeContextAndPropose).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: true,
			changeCount: 0,
			skippedReason: "app_authored_thread",
		});
		expect(markTeamsChatMessagesAsSeen).toHaveBeenCalledWith(
			"lc1",
			["M1"],
			null,
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("still analyzes a bundle with an application root and a user reply", async () => {
		analyzeContextAndPropose.mockResolvedValue({
			summary: "",
			changes: [],
		});

		const result = await analyzeChatThreadActivity({
			...BASE_INPUT,
			thread: buildThread({
				replies: [
					{
						messageId: "M1-R1",
						author: "Carol Oncall",
						fromKind: "user",
						createdAt: "2026-05-23T10:01:00.000Z",
						content: "Investigating, looks like a flaky probe",
					},
				],
				messageIds: ["M1", "M1-R1"],
			}),
		});

		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
		expect(result.skippedReason).toBe("no_relevant_content");
	});

	it("still analyzes a bundle with an application root and an unknown-authored reply (fails open)", async () => {
		analyzeContextAndPropose.mockResolvedValue({
			summary: "",
			changes: [],
		});

		const result = await analyzeChatThreadActivity({
			...BASE_INPUT,
			thread: buildThread({
				replies: [
					{
						messageId: "M1-R1",
						author: "Unknown",
						fromKind: "unknown",
						createdAt: "2026-05-23T10:01:00.000Z",
						content: "some reply Graph didn't attribute",
					},
				],
				messageIds: ["M1", "M1-R1"],
			}),
		});

		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
		expect(result.skippedReason).toBe("no_relevant_content");
	});
});
