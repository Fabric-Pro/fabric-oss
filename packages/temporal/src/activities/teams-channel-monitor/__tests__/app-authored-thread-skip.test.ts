/**
 * Tests for the app-authored-thread skip.
 *
 * A Teams channel monitor linked to an automated alerts/bot channel ran one
 * COMPLEX-tier `analyzeContextAndPropose` call per mature thread and got zero
 * changes back every time — thousands of wasted LLM calls. `isAppAuthoredOnly`
 * lets `analyzeChannelThreadActivity` skip the analyzer for a thread where
 * root AND every reply are positively known to be application-authored, while
 * failing OPEN (still analyzing) on any user- or unknown-authored message.
 *
 * Mirrors the mocking setup in `analyze-channel-messages.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCachedProjectBacklog = vi.fn();
const markTeamsMessagesAsSeen = vi.fn();
const createMany = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();
const findManyProjectContext = vi.fn();

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		markTeamsMessagesAsSeen: (...a: unknown[]) =>
			markTeamsMessagesAsSeen(...a),
		db: {
			// Conversation capture (Fizzy #2228) runs ahead of the skip
			// decision and looks the channel's ProjectContext row up through
			// this. No row is registered in these fixtures, so capture finds
			// no parent and writes nothing — this suite is about the skip
			// decision, not capture's own behaviour. The assertion below
			// still confirms the lookup itself runs unconditionally, i.e.
			// capture is NOT skipped alongside the analyzer.
			projectContext: {
				findMany: (...a: unknown[]) => findManyProjectContext(...a),
			},
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
	analyzeChannelThreadActivity,
	isAppAuthoredOnly,
} from "../analyze-channel-messages";
import type { FetchedThread } from "../fetch-new-messages";

const BASE_INPUT_WITHOUT_THREAD = {
	projectId: "p1",
	userId: "u1",
	organizationId: "o1",
	linkedChannelId: "lc1",
	teamId: "team-graph-id",
	channelId: "19:example-channel-id",
	channelDisplayName: "alerts",
	channelWebUrl: "https://teams/alerts",
};

const EMPTY_BACKLOG = { stories: [] };

function buildThread(overrides: Partial<FetchedThread> = {}): FetchedThread {
	return {
		rootMessageId: "M1",
		rootCreatedAt: "2026-05-23T10:00:00.000Z",
		rootAuthor: "Alerts Bot",
		rootContent: "Deploy alert fired",
		rootWebLink: "https://teams/M1",
		rootFromKind: "application",
		// Graph's reply page was complete by default; the repliesComplete
		// gate itself is exercised by the dedicated tests below.
		repliesComplete: true,
		replies: [],
		threadLastActivity: "2026-05-23T10:00:00.000Z",
		pendingAttachments: [],
		...overrides,
	};
}

describe("isAppAuthoredOnly", () => {
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
		});
		expect(isAppAuthoredOnly(thread)).toBe(false);
	});

	it("is false when the root's fromKind is missing (older fetch result — fails open)", () => {
		const thread = buildThread();
		delete (thread as { rootFromKind?: string }).rootFromKind;
		expect(isAppAuthoredOnly(thread)).toBe(false);
	});

	it("is false when repliesComplete is false, even with only application-authored replies visible (Graph truncated the reply page — fails open)", () => {
		const thread = buildThread({
			repliesComplete: false,
			replies: [
				{
					messageId: "M1-R1",
					author: "Alerts Bot",
					fromKind: "application",
					createdAt: "2026-05-23T10:01:00.000Z",
					content: "Still firing",
				},
			],
		});
		expect(isAppAuthoredOnly(thread)).toBe(false);
	});

	it("is false when repliesComplete is missing (older fetch result — fails open)", () => {
		const thread = buildThread();
		delete (thread as { repliesComplete?: boolean }).repliesComplete;
		expect(isAppAuthoredOnly(thread)).toBe(false);
	});
});

describe("analyzeChannelThreadActivity — app-authored thread skip", () => {
	beforeEach(() => {
		getCachedProjectBacklog.mockReset();
		markTeamsMessagesAsSeen.mockReset();
		createMany.mockReset();
		create.mockReset();
		updateMany.mockReset();
		analyzeContextAndPropose.mockReset();
		findManyProjectContext.mockReset();

		getCachedProjectBacklog.mockResolvedValue(EMPTY_BACKLOG);
		markTeamsMessagesAsSeen.mockResolvedValue(undefined);
		createMany.mockResolvedValue({ count: 1 });
		create.mockResolvedValue({ id: "pbp-teams-1" });
		updateMany.mockResolvedValue({ count: 1 });
		findManyProjectContext.mockResolvedValue([]);
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

	it("skips analyzeContextAndPropose and marks the root seen for an all-application thread", async () => {
		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: buildThread(),
		});

		expect(analyzeContextAndPropose).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: true,
			changeCount: 0,
			skippedReason: "app_authored_thread",
		});
		// The seen row records the watermark this pass analyzed through (the
		// thread's threadLastActivity), so only a later reply revisits it.
		expect(markTeamsMessagesAsSeen).toHaveBeenCalledWith(
			"lc1",
			["M1"],
			null,
			new Date("2026-05-23T10:00:00.000Z"),
		);
		// No proposal is written on the skip path.
		expect(create).not.toHaveBeenCalled();
		// Capture (Fizzy #2228) still runs unconditionally ahead of the skip
		// decision — the lookup for the channel's ProjectContext row must
		// still have happened even though the analyzer was skipped.
		expect(findManyProjectContext).toHaveBeenCalled();
	});

	it("still analyzes a thread with an application root and a user reply", async () => {
		analyzeContextAndPropose.mockResolvedValue({
			summary: "",
			changes: [],
		});

		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
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
			}),
		});

		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
		expect(result.skippedReason).toBe("no_relevant_content");
	});

	it("still analyzes a thread with an application root and an unknown-authored reply (fails open)", async () => {
		analyzeContextAndPropose.mockResolvedValue({
			summary: "",
			changes: [],
		});

		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
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
			}),
		});

		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
		expect(result.skippedReason).toBe("no_relevant_content");
	});

	it("still analyzes a thread whose visible messages are all application-authored but whose reply page Graph truncated", async () => {
		analyzeContextAndPropose.mockResolvedValue({
			summary: "",
			changes: [],
		});

		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: buildThread({
				repliesComplete: false,
				replies: [
					{
						messageId: "M1-R1",
						author: "Alerts Bot",
						fromKind: "application",
						createdAt: "2026-05-23T10:01:00.000Z",
						content: "Still firing",
					},
				],
			}),
		});

		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
		expect(result.skippedReason).toBe("no_relevant_content");
	});
});
