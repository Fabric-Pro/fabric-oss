/**
 * Legacy seen rows (NULL `analyzedThroughAt`) through the REAL
 * `getSeenThreadWatermarks`, end to end through the fetch activity.
 *
 * Such a row was written by a worker that fetched the thread, analyzed it, and
 * only then inserted the row, so every reply it analyzed predates `createdAt`.
 * The fallback watermark is therefore `createdAt`: a reply created after it is
 * new and comes back as a revisit. A reply created before it does not — that
 * includes one that arrived while the old run was still going, which stays
 * unanalyzed exactly as it did before this change (documented legacy limit).
 *
 * Only the Prisma client is faked; the database helper itself is the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMicrosoftTeamsToolMock = vi.fn();
const seenRows: Array<{
	linkedChannelId: string;
	messageId: string;
	analyzedThroughAt: Date | null;
	createdAt: Date;
}> = [];

vi.mock("@repo/database/prisma/client", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@repo/database/prisma/client")>();
	return {
		...actual,
		db: {
			projectLinkedTeamsChannelSeenMessage: {
				findMany: async (args: {
					where: {
						linkedChannelId: string;
						messageId: { in: string[] };
					};
				}) =>
					seenRows.filter(
						(row) =>
							row.linkedChannelId ===
								args.where.linkedChannelId &&
							args.where.messageId.in.includes(row.messageId),
					),
			},
		},
	};
});

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...args: unknown[]) =>
		executeMicrosoftTeamsToolMock(...args),
	truncateContent: (content: string | undefined) =>
		(content ?? "").replace(/<[^>]*>/g, " ").trim(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

import { fetchNewChannelThreadsActivity } from "../fetch-new-messages";

const MINUTE_MS = 60 * 1000;
const QUIET_WINDOW_MINUTES = 60;

function minutesAgo(minutes: number): string {
	return new Date(Date.now() - minutes * MINUTE_MS).toISOString();
}

function rawThread(id: string, replyAt: string) {
	return {
		id,
		createdDateTime: minutesAgo(600),
		lastModifiedDateTime: minutesAgo(600),
		webUrl: `https://teams.example.com/${id}`,
		from: "Alice",
		fromKind: "user",
		bodyContent: `<p>root ${id}</p>`,
		repliesComplete: true,
		replies: [
			{
				id: `${id}-R1`,
				createdDateTime: replyAt,
				lastModifiedDateTime: replyAt,
				webUrl: `https://teams.example.com/${id}-R1`,
				from: "Bob",
				fromKind: "user",
				bodyContent: "<p>reply</p>",
			},
		],
	};
}

describe("fetchNewChannelThreadsActivity — legacy seen rows", () => {
	beforeEach(() => {
		executeMicrosoftTeamsToolMock.mockReset();
		seenRows.length = 0;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("revisits a reply created after a legacy row's insert, and not one created before it", async () => {
		// Both rows inserted 3h ago by an old worker (NULL analyzedThroughAt).
		const insertedAt = new Date(Date.now() - 180 * MINUTE_MS);
		for (const messageId of ["LATE", "DURING_OLD_RUN"]) {
			seenRows.push({
				linkedChannelId: "lc1",
				messageId,
				analyzedThroughAt: null,
				createdAt: insertedAt,
			});
		}
		executeMicrosoftTeamsToolMock.mockResolvedValue({
			threads: [
				// 5 min after the insert: a genuine late reply.
				rawThread("LATE", minutesAgo(175)),
				// 5 min before the insert: arrived during the old run. The row
				// cannot tell it from one that run analyzed, so it stays
				// unanalyzed (documented legacy limit, same as before).
				rawThread("DURING_OLD_RUN", minutesAgo(185)),
			],
			count: 2,
			fetchedAllPages: true,
		});

		const result = await fetchNewChannelThreadsActivity({
			projectId: "p1",
			linkedChannelId: "lc1",
			teamId: "T1",
			channelId: "C1",
			userId: "u1",
			organizationId: "o1",
			sinceIso: null,
			quietWindowMinutes: QUIET_WINDOW_MINUTES,
		});

		expect(result.success).toBe(true);
		expect(result.threads.map((t) => t.rootMessageId)).toEqual(["LATE"]);
		expect(result.threads[0].previouslyAnalyzedThrough).toBe(
			insertedAt.toISOString(),
		);
	});
});
