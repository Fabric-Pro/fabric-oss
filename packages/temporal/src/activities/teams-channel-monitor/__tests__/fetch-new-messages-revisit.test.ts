/**
 * Late replies on an already-analyzed thread.
 *
 * The fetch activity used to drop every mature thread whose root was in the
 * seen-message table, so a reply posted after a thread's first analysis was
 * never analyzed — nor captured, since capture only runs for threads that pass
 * the fetch. The seen row now carries a per-thread watermark, and a seen
 * thread comes back as a revisit when one of its replies is strictly newer.
 *
 * Mirrors the mocking setup in `fetch-new-messages.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMicrosoftTeamsToolMock = vi.fn();
const getSeenThreadWatermarks = vi.fn();

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...args: unknown[]) =>
		executeMicrosoftTeamsToolMock(...args),
	truncateContent: (content: string | undefined) =>
		(content ?? "").replace(/<[^>]*>/g, " ").trim(),
}));

vi.mock("@repo/database", () => ({
	getSeenThreadWatermarks: (...args: unknown[]) =>
		getSeenThreadWatermarks(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

import { fetchNewChannelThreadsActivity } from "../fetch-new-messages";

const HOUR_MS = 60 * 60 * 1000;

/** An ISO timestamp `hoursAgo` hours before now — past the 60-min quiet window. */
function hoursAgo(hours: number): string {
	return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

const VALID_INPUT = {
	projectId: "p1",
	linkedChannelId: "lc1",
	teamId: "T1",
	channelId: "C1",
	userId: "u1",
	organizationId: "o1",
	sinceIso: null,
};

function rawThread(id: string, rootAt: string, replyAts: string[]) {
	return {
		id,
		createdDateTime: rootAt,
		lastModifiedDateTime: rootAt,
		webUrl: `https://teams.example.com/${id}`,
		from: "Alice",
		fromKind: "user",
		bodyContent: `<p>root ${id}</p>`,
		repliesComplete: true,
		replies: replyAts.map((at, index) => ({
			id: `${id}-R${index + 1}`,
			createdDateTime: at,
			lastModifiedDateTime: at,
			webUrl: `https://teams.example.com/${id}-R${index + 1}`,
			from: "Bob",
			fromKind: "user",
			bodyContent: `<p>reply ${index + 1}</p>`,
		})),
	};
}

function toolReturns(threads: ReturnType<typeof rawThread>[]) {
	executeMicrosoftTeamsToolMock.mockResolvedValue({
		threads,
		count: threads.length,
		fetchedAllPages: true,
	});
}

describe("fetchNewChannelThreadsActivity — seen-thread watermark", () => {
	beforeEach(() => {
		executeMicrosoftTeamsToolMock.mockReset();
		getSeenThreadWatermarks.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("passes an unseen thread as a first analysis (no previouslyAnalyzedThrough)", async () => {
		toolReturns([rawThread("M1", hoursAgo(10), [hoursAgo(9)])]);
		getSeenThreadWatermarks.mockResolvedValue(new Map());

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.success).toBe(true);
		expect(result.threads.map((t) => t.rootMessageId)).toEqual(["M1"]);
		expect(result.threads[0]).not.toHaveProperty(
			"previouslyAnalyzedThrough",
		);
		expect(getSeenThreadWatermarks).toHaveBeenCalledWith("lc1", ["M1"]);
	});

	it("drops a seen thread with no reply newer than its watermark", async () => {
		const lastReply = hoursAgo(9);
		toolReturns([rawThread("M1", hoursAgo(10), [lastReply])]);
		getSeenThreadWatermarks.mockResolvedValue(
			new Map([["M1", new Date(hoursAgo(8))]]),
		);

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.success).toBe(true);
		expect(result.threads).toEqual([]);
	});

	it("passes a seen thread with a reply newer than its watermark as a revisit", async () => {
		const watermark = new Date(hoursAgo(8));
		toolReturns([
			rawThread("M1", hoursAgo(10), [hoursAgo(9), hoursAgo(3)]),
		]);
		getSeenThreadWatermarks.mockResolvedValue(new Map([["M1", watermark]]));

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.success).toBe(true);
		expect(result.threads).toHaveLength(1);
		const thread = result.threads[0];
		expect(thread.rootMessageId).toBe("M1");
		expect(thread.previouslyAnalyzedThrough).toBe(watermark.toISOString());
		// The whole thread comes back: the analyzer needs the earlier
		// messages as context, and capture dedups per message on its own.
		expect(thread.replies.map((r) => r.messageId)).toEqual([
			"M1-R1",
			"M1-R2",
		]);
	});

	it("does not treat a reply created exactly at the watermark as new", async () => {
		const lastReply = hoursAgo(9);
		toolReturns([rawThread("M1", hoursAgo(10), [lastReply])]);
		getSeenThreadWatermarks.mockResolvedValue(
			new Map([["M1", new Date(lastReply)]]),
		);

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.threads).toEqual([]);
	});

	it("compares against whatever effective watermark the helper returns", async () => {
		const watermark = new Date(hoursAgo(7));
		toolReturns([
			rawThread("OLD", hoursAgo(12), [hoursAgo(8)]),
			rawThread("LATE", hoursAgo(12), [hoursAgo(8), hoursAgo(2)]),
		]);
		getSeenThreadWatermarks.mockResolvedValue(
			new Map([
				["OLD", watermark],
				["LATE", watermark],
			]),
		);

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.threads.map((t) => t.rootMessageId)).toEqual(["LATE"]);
		expect(result.threads[0].previouslyAnalyzedThrough).toBe(
			watermark.toISOString(),
		);
	});

	it("does not treat a reply with an unparseable createdDateTime as new", async () => {
		const thread = rawThread("M1", hoursAgo(10), [hoursAgo(9)]);
		thread.replies.push({
			...thread.replies[0],
			id: "M1-BAD",
			createdDateTime: "not-a-timestamp",
		});
		toolReturns([thread]);
		getSeenThreadWatermarks.mockResolvedValue(
			new Map([["M1", new Date(hoursAgo(8))]]),
		);

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		// Otherwise it could never pass any watermark and the thread would
		// come back as a revisit on every tick.
		expect(result.threads).toEqual([]);
	});

	it("does not send a revisit on a reply with no createdDateTime alone", async () => {
		const thread = rawThread("M1", hoursAgo(10), [hoursAgo(9)]);
		thread.replies.push({
			...thread.replies[0],
			id: "M1-NOTIME",
			createdDateTime: undefined as unknown as string,
		});
		toolReturns([thread]);
		getSeenThreadWatermarks.mockResolvedValue(
			new Map([["M1", new Date(hoursAgo(8))]]),
		);

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.threads).toEqual([]);
	});

	describe("against the channel cursor", () => {
		// The cursor lags and is set from fetched snapshots — including one
		// whose analysis lost the watermark compare-and-swap to an overlapping
		// run. Only the per-thread watermark decides for a seen thread.
		it("revisits a seen thread at or before the cursor when a reply is newer than its watermark", async () => {
			// Run A recorded the watermark through T1; overlapping run B,
			// whose snapshot ran through T2, lost the CAS — but the workflow
			// still set the cursor from B's threadLastActivity (T2).
			const t1 = hoursAgo(5);
			const t2 = hoursAgo(3);
			toolReturns([rawThread("M1", hoursAgo(10), [t1, t2])]);
			getSeenThreadWatermarks.mockResolvedValue(
				new Map([["M1", new Date(t1)]]),
			);

			const result = await fetchNewChannelThreadsActivity({
				...VALID_INPUT,
				sinceIso: t2,
			});

			expect(result.threads.map((t) => t.rootMessageId)).toEqual(["M1"]);
			expect(result.threads[0].previouslyAnalyzedThrough).toBe(
				new Date(t1).toISOString(),
			);
		});

		it("still drops an unseen thread at or before the cursor", async () => {
			const lastReply = hoursAgo(3);
			toolReturns([
				rawThread("AT", hoursAgo(10), [lastReply]),
				rawThread("BEFORE", hoursAgo(10), [hoursAgo(4)]),
			]);
			getSeenThreadWatermarks.mockResolvedValue(new Map());

			const result = await fetchNewChannelThreadsActivity({
				...VALID_INPUT,
				sinceIso: lastReply,
			});

			expect(result.threads).toEqual([]);
		});

		it("drops a seen thread at or before the cursor with no reply newer than its watermark", async () => {
			const lastReply = hoursAgo(3);
			toolReturns([
				rawThread("M1", hoursAgo(10), [hoursAgo(5), lastReply]),
			]);
			getSeenThreadWatermarks.mockResolvedValue(
				new Map([["M1", new Date(lastReply)]]),
			);

			const result = await fetchNewChannelThreadsActivity({
				...VALID_INPUT,
				sinceIso: lastReply,
			});

			expect(result.threads).toEqual([]);
		});
	});

	it("counts revisits toward maxThreads and clears the scan token like unseen threads", async () => {
		toolReturns([
			rawThread("NEW", hoursAgo(10), []),
			rawThread("REVISIT", hoursAgo(10), [hoursAgo(9), hoursAgo(2)]),
			rawThread("THIRD", hoursAgo(10), []),
		]);
		getSeenThreadWatermarks.mockResolvedValue(
			new Map([["REVISIT", new Date(hoursAgo(8))]]),
		);

		const result = await fetchNewChannelThreadsActivity({
			...VALID_INPUT,
			maxThreads: 2,
		});

		expect(result.threads.map((t) => t.rootMessageId)).toEqual([
			"NEW",
			"REVISIT",
		]);
		expect(result.updatedScanPageToken).toBeNull();
	});
});
