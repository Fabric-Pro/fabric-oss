/**
 * Revisits: an already-analyzed thread that came back because a reply was
 * created after its last analysis (`thread.previouslyAnalyzedThrough` set).
 *
 * The analyzer sees the earlier messages as already-reviewed context and the
 * new replies as the thing to analyze; the thread's existing seen row has its
 * watermark moved forward instead of a second row being inserted, and on the
 * proposal path that conditional advance is the idempotency fence.
 *
 * Mirrors the mocking setup in `analyze-channel-messages.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCachedProjectBacklog = vi.fn();
const markTeamsMessagesAsSeen = vi.fn();
const advanceTeamsThreadWatermark = vi.fn();
const createMany = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();
const transaction = vi.fn();
const realHelpers = vi.hoisted(() => ({
	advanceTeamsThreadWatermark: undefined as unknown as (
		...a: unknown[]
	) => Promise<number>,
}));

// One stable transaction client, so a test can assert the fence ran on it.
const TX = {
	projectLinkedTeamsChannelSeenMessage: {
		createMany: (...a: unknown[]) => createMany(...a),
		updateMany: (...a: unknown[]) => updateMany(...a),
	},
	pendingBacklogProposal: {
		create: (...a: unknown[]) => create(...a),
	},
};

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	realHelpers.advanceTeamsThreadWatermark =
		actual.advanceTeamsThreadWatermark as typeof realHelpers.advanceTeamsThreadWatermark;
	return {
		...actual,
		markTeamsMessagesAsSeen: (...a: unknown[]) =>
			markTeamsMessagesAsSeen(...a),
		advanceTeamsThreadWatermark: (...a: unknown[]) =>
			advanceTeamsThreadWatermark(...a),
		db: {
			// Capture finds no ProjectContext row in these fixtures and writes
			// nothing; capture's own per-message dedup is covered in
			// `__tests__/conversation-bundle-capture.test.ts`.
			projectContext: { findMany: async () => [] },
			$transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
				transaction();
				return fn(TX);
			},
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
	formatTeamsThreadForBacklog,
	formatTeamsThreadRevisitForBacklog,
	hasOnlyAppAuthoredNewReplies,
	selectNewReplies,
} from "../analyze-channel-messages";
import type { FetchedThread } from "../fetch-new-messages";

const BASE_INPUT_WITHOUT_THREAD = {
	projectId: "p1",
	userId: "u1",
	organizationId: "o1",
	linkedChannelId: "lc1",
	teamId: "team-graph-id",
	channelId: "19:example-channel-id",
	channelDisplayName: "engineering",
	channelWebUrl: "https://teams.example.com/engineering",
};

const EMPTY_BACKLOG = { stories: [] };

const PREVIOUSLY_ANALYZED_THROUGH = "2026-05-23T10:01:00.000Z";
const THREAD_LAST_ACTIVITY = "2026-05-23T14:00:00.000Z";

/** A human thread analyzed once through R1, since joined by a new reply R2. */
function revisitThread(overrides: Partial<FetchedThread> = {}): FetchedThread {
	return {
		rootMessageId: "M1",
		rootCreatedAt: "2026-05-23T10:00:00.000Z",
		rootAuthor: "Alice",
		rootFromKind: "user",
		rootContent: "Export to CSV drops the header row",
		rootWebLink: "https://teams.example.com/M1",
		repliesComplete: true,
		replies: [
			{
				messageId: "M1-R1",
				author: "Bob",
				fromKind: "user",
				createdAt: PREVIOUSLY_ANALYZED_THROUGH,
				content: "Confirmed on the latest build",
			},
			{
				messageId: "M1-R2",
				author: "Carol",
				fromKind: "user",
				createdAt: THREAD_LAST_ACTIVITY,
				content: "Also: the XLSX export needs a date-format option",
			},
		],
		threadLastActivity: THREAD_LAST_ACTIVITY,
		pendingAttachments: [],
		previouslyAnalyzedThrough: PREVIOUSLY_ANALYZED_THROUGH,
		...overrides,
	};
}

const ONE_CHANGE = {
	summary: "XLSX date format option",
	changes: [
		{
			type: "feature",
			action: "create",
			title: "XLSX export date-format option",
			description: "let users pick the date format for XLSX exports",
		},
	],
};

beforeEach(() => {
	getCachedProjectBacklog.mockReset();
	markTeamsMessagesAsSeen.mockReset();
	advanceTeamsThreadWatermark.mockReset();
	createMany.mockReset();
	create.mockReset();
	updateMany.mockReset();
	transaction.mockReset();
	analyzeContextAndPropose.mockReset();

	getCachedProjectBacklog.mockResolvedValue(EMPTY_BACKLOG);
	markTeamsMessagesAsSeen.mockResolvedValue({ count: 1 });
	advanceTeamsThreadWatermark.mockResolvedValue(1);
	createMany.mockResolvedValue({ count: 1 });
	create.mockResolvedValue({ id: "pbp-revisit-1" });
	updateMany.mockResolvedValue({ count: 1 });
	analyzeContextAndPropose.mockResolvedValue(ONE_CHANGE);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("selectNewReplies / hasOnlyAppAuthoredNewReplies", () => {
	it("treats a reply created exactly at the watermark as already reviewed", () => {
		const thread = revisitThread();
		expect(
			selectNewReplies(thread.replies, PREVIOUSLY_ANALYZED_THROUGH).map(
				(r) => r.messageId,
			),
		).toEqual(["M1-R2"]);
	});

	it("is true when every NEW reply is application-authored, whatever the root and older replies are", () => {
		const thread = revisitThread({
			replies: [
				revisitThread().replies[0],
				{
					messageId: "M1-R2",
					author: "Deploy Bot",
					fromKind: "application",
					createdAt: THREAD_LAST_ACTIVITY,
					content: "Deployed to staging",
				},
			],
		});
		expect(hasOnlyAppAuthoredNewReplies(thread)).toBe(true);
	});

	it("is false when a new reply is human or unattributed (fails open)", () => {
		expect(hasOnlyAppAuthoredNewReplies(revisitThread())).toBe(false);
		const unknown = revisitThread();
		unknown.replies[1] = { ...unknown.replies[1], fromKind: "unknown" };
		expect(hasOnlyAppAuthoredNewReplies(unknown)).toBe(false);
	});

	it("is false when the reply list is not known complete (fails open)", () => {
		const thread = revisitThread({ repliesComplete: false });
		thread.replies[1] = { ...thread.replies[1], fromKind: "application" };
		expect(hasOnlyAppAuthoredNewReplies(thread)).toBe(false);
	});

	it("does not treat a reply with an unparseable createdAt as new (same rule as the fetch)", () => {
		const thread = revisitThread();
		thread.replies[1] = {
			...thread.replies[1],
			createdAt: "not-a-timestamp",
		};
		expect(
			selectNewReplies(thread.replies, PREVIOUSLY_ANALYZED_THROUGH),
		).toEqual([]);
	});

	it("is false on a first analysis", () => {
		const thread = revisitThread();
		delete thread.previouslyAnalyzedThrough;
		thread.replies[1] = { ...thread.replies[1], fromKind: "application" };
		expect(hasOnlyAppAuthoredNewReplies(thread)).toBe(false);
	});
});

describe("analyzeChannelThreadActivity — revisit", () => {
	it("separates already-reviewed context from the new replies in the formatted text and the prompt", async () => {
		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: revisitThread(),
		});

		const call = analyzeContextAndPropose.mock.calls[0][0] as {
			fetchedContext: { teamsMessages: string };
			userPrompt: string;
		};
		const text = call.fetchedContext.teamsMessages;
		const earlierAt = text.indexOf(
			"### Earlier messages (already reviewed",
		);
		const newAt = text.indexOf("### New replies since");
		expect(earlierAt).toBeGreaterThan(-1);
		expect(newAt).toBeGreaterThan(earlierAt);
		const earlier = text.slice(earlierAt, newAt);
		const fresh = text.slice(newAt);
		expect(earlier).toContain("context only");
		expect(earlier).toContain("Export to CSV drops the header row");
		expect(earlier).toContain("Confirmed on the latest build");
		expect(fresh).toContain("XLSX export needs a date-format option");
		expect(fresh).not.toContain("Confirmed on the latest build");
		expect(text).toBe(
			formatTeamsThreadRevisitForBacklog(
				revisitThread(),
				"engineering",
				PREVIOUSLY_ANALYZED_THROUGH,
			),
		);

		// The revisit prompt is the first-analysis prompt plus an addendum.
		expect(call.userPrompt).toContain("New replies");
		expect(call.userPrompt).toContain("return zero changes");

		// …and the first-analysis prompt/format are untouched by it.
		analyzeContextAndPropose.mockClear();
		const firstThread = revisitThread();
		delete firstThread.previouslyAnalyzedThrough;
		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: firstThread,
		});
		const first = analyzeContextAndPropose.mock.calls[0][0] as {
			fetchedContext: { teamsMessages: string };
			userPrompt: string;
		};
		expect(call.userPrompt.startsWith(first.userPrompt)).toBe(true);
		expect(first.userPrompt).not.toContain("New replies");
		expect(first.fetchedContext.teamsMessages).toBe(
			formatTeamsThreadForBacklog(firstThread, "engineering"),
		);
	});

	it("advances the watermark and inserts nothing on zero changes", async () => {
		analyzeContextAndPropose.mockResolvedValue({
			summary: "",
			changes: [],
		});

		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: revisitThread(),
		});

		expect(result).toMatchObject({
			success: true,
			changeCount: 0,
			skippedReason: "no_relevant_content",
		});
		expect(advanceTeamsThreadWatermark).toHaveBeenCalledTimes(1);
		expect(advanceTeamsThreadWatermark).toHaveBeenCalledWith(
			"lc1",
			"M1",
			new Date(PREVIOUSLY_ANALYZED_THROUGH),
			new Date(THREAD_LAST_ACTIVITY),
		);
		expect(markTeamsMessagesAsSeen).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it("creates a proposal through the conditional watermark fence inside the transaction", async () => {
		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: revisitThread(),
		});

		expect(result.success).toBe(true);
		expect(result.pendingProposalId).toBe("pbp-revisit-1");
		// The fence is the conditional advance, on the transaction client —
		// not an insert of a second seen row.
		expect(advanceTeamsThreadWatermark).toHaveBeenCalledWith(
			"lc1",
			"M1",
			new Date(PREVIOUSLY_ANALYZED_THROUGH),
			new Date(THREAD_LAST_ACTIVITY),
			TX,
		);
		expect(createMany).not.toHaveBeenCalled();
		expect(markTeamsMessagesAsSeen).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);

		const createArg = create.mock.calls[0][0] as {
			data: { sourceMetadata: Record<string, unknown> };
		};
		expect(createArg.data.sourceMetadata).toMatchObject({
			linkedChannelId: "lc1",
			threadRootId: "M1",
			threadLastActivity: THREAD_LAST_ACTIVITY,
			revisitOfAnalyzedThrough: PREVIOUSLY_ANALYZED_THROUGH,
			newReplyIds: ["M1-R2"],
		});

		// The root row keeps an existing proposal link; only an empty one is filled.
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				linkedChannelId: "lc1",
				messageId: "M1",
				pendingProposalId: null,
			},
			data: { pendingProposalId: "pbp-revisit-1" },
		});
	});

	it("logs and returns normally when the zero-change watermark CAS misses", async () => {
		analyzeContextAndPropose.mockResolvedValue({
			summary: "",
			changes: [],
		});
		advanceTeamsThreadWatermark.mockResolvedValue(0);

		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: revisitThread(),
		});

		expect(result).toMatchObject({
			success: true,
			changeCount: 0,
			skippedReason: "no_relevant_content",
		});
		expect(markTeamsMessagesAsSeen).not.toHaveBeenCalled();
	});

	it("lets only the first of two overlapping revisits that read the same watermark create a proposal", async () => {
		// The real helper, against one stateful seen row, via the tx client.
		const row = {
			analyzedThroughAt: new Date(
				PREVIOUSLY_ANALYZED_THROUGH,
			) as Date | null,
		};
		advanceTeamsThreadWatermark.mockImplementation((...a: unknown[]) =>
			realHelpers.advanceTeamsThreadWatermark(...a),
		);
		updateMany.mockImplementation(
			async (args: {
				where: {
					OR?: Array<{ analyzedThroughAt: Date | null }>;
					pendingProposalId?: null;
				};
				data: { analyzedThroughAt?: Date };
			}) => {
				if (!args.where.OR) {
					return { count: 1 }; // the pendingProposalId link
				}
				const current = row.analyzedThroughAt;
				const hit = args.where.OR.some((arm) =>
					arm.analyzedThroughAt === null
						? current === null
						: current !== null &&
							current.getTime() ===
								arm.analyzedThroughAt.getTime(),
				);
				if (!hit) {
					return { count: 0 };
				}
				row.analyzedThroughAt = args.data.analyzedThroughAt ?? current;
				return { count: 1 };
			},
		);
		const T1 = "2026-05-23T12:00:00.000Z";

		// Run A saw replies through T1; run B (same starting watermark) saw
		// through THREAD_LAST_ACTIVITY, which includes A's reply.
		const runA = revisitThread({
			replies: [
				revisitThread().replies[0],
				{ ...revisitThread().replies[1], createdAt: T1 },
			],
			threadLastActivity: T1,
		});
		const a = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: runA,
		});
		const b = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: revisitThread(),
		});

		expect(a.pendingProposalId).toBe("pbp-revisit-1");
		expect(b).toMatchObject({
			success: true,
			skippedReason: "already_claimed",
		});
		expect(create).toHaveBeenCalledTimes(1);
		expect(row.analyzedThroughAt).toEqual(new Date(T1));
	});

	it("returns already_claimed and writes no proposal when the fence matches nothing", async () => {
		advanceTeamsThreadWatermark.mockResolvedValue(0);

		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: revisitThread(),
		});

		expect(result).toMatchObject({
			success: true,
			changeCount: 0,
			skippedReason: "already_claimed",
		});
		expect(result.pendingProposalId).toBeUndefined();
		expect(create).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("skips the analyzer and advances the watermark when every new reply is application-authored", async () => {
		const thread = revisitThread();
		thread.replies[1] = {
			messageId: "M1-R2",
			author: "Deploy Bot",
			fromKind: "application",
			createdAt: THREAD_LAST_ACTIVITY,
			content: "Deployed build 42 to staging",
		};

		const result = await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread,
		});

		expect(analyzeContextAndPropose).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: true,
			changeCount: 0,
			skippedReason: "app_authored_thread",
		});
		expect(advanceTeamsThreadWatermark).toHaveBeenCalledWith(
			"lc1",
			"M1",
			new Date(PREVIOUSLY_ANALYZED_THROUGH),
			new Date(THREAD_LAST_ACTIVITY),
		);
		expect(markTeamsMessagesAsSeen).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it("analyzes a human new reply on an application-authored root", async () => {
		const thread = revisitThread({
			rootAuthor: "Alerts Bot",
			rootFromKind: "application",
			rootContent: "Disk usage above 90%",
			replies: [
				{
					messageId: "M1-R1",
					author: "Alerts Bot",
					fromKind: "application",
					createdAt: PREVIOUSLY_ANALYZED_THROUGH,
					content: "Still above 90%",
				},
				{
					messageId: "M1-R2",
					author: "Carol",
					fromKind: "user",
					createdAt: THREAD_LAST_ACTIVITY,
					content: "We need automatic log rotation on these hosts",
				},
			],
		});

		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread,
		});

		expect(analyzeContextAndPropose).toHaveBeenCalledTimes(1);
	});
});

describe("analyzeChannelThreadActivity — first analysis records its watermark", () => {
	function firstThread(): FetchedThread {
		const thread = revisitThread();
		delete thread.previouslyAnalyzedThrough;
		return thread;
	}

	it("writes analyzedThroughAt on the seen row the proposal transaction inserts", async () => {
		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: firstThread(),
		});

		expect(advanceTeamsThreadWatermark).not.toHaveBeenCalled();
		expect(createMany).toHaveBeenCalledWith({
			data: [
				{
					linkedChannelId: "lc1",
					messageId: "M1",
					pendingProposalId: null,
					analyzedThroughAt: new Date(THREAD_LAST_ACTIVITY),
				},
			],
			skipDuplicates: true,
		});
		const createArg = create.mock.calls[0][0] as {
			data: { sourceMetadata: Record<string, unknown> };
		};
		expect(createArg.data.sourceMetadata).not.toHaveProperty(
			"revisitOfAnalyzedThrough",
		);
		expect(createArg.data.sourceMetadata).not.toHaveProperty("newReplyIds");
		expect(updateMany).toHaveBeenCalledWith({
			where: { linkedChannelId: "lc1", messageId: "M1" },
			data: { pendingProposalId: "pbp-revisit-1" },
		});
	});

	it("writes analyzedThroughAt on the zero-change seen marker", async () => {
		analyzeContextAndPropose.mockResolvedValue({
			summary: "",
			changes: [],
		});

		await analyzeChannelThreadActivity({
			...BASE_INPUT_WITHOUT_THREAD,
			thread: firstThread(),
		});

		expect(markTeamsMessagesAsSeen).toHaveBeenCalledWith(
			"lc1",
			["M1"],
			null,
			new Date(THREAD_LAST_ACTIVITY),
		);
		expect(advanceTeamsThreadWatermark).not.toHaveBeenCalled();
	});
});
