import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindFirst: vi.fn(),
	sessionFindMany: vi.fn(),
	sessionUpdate: vi.fn(),
	segmentDeleteMany: vi.fn(),
	receiptDeleteMany: vi.fn(),
	actionDeleteMany: vi.fn(),
	turnDeleteMany: vi.fn(),
	turnUpdateMany: vi.fn(),
	suggestionDeleteMany: vi.fn(),
	suggestionUpdateMany: vi.fn(),
	contextUpdateMany: vi.fn(),
	cleanupCreate: vi.fn(),
	queryRaw: vi.fn(),
}));

vi.mock("../../../client", () => {
	const tx = {
		parlumeMeetingSession: {
			findFirst: mocks.sessionFindFirst,
			update: mocks.sessionUpdate,
		},
		parlumeMeetingSegment: { deleteMany: mocks.segmentDeleteMany },
		parlumeWebhookReceipt: { deleteMany: mocks.receiptDeleteMany },
		parlumeAction: { deleteMany: mocks.actionDeleteMany },
		parlumeMeetingTurn: {
			deleteMany: mocks.turnDeleteMany,
			updateMany: mocks.turnUpdateMany,
		},
		parlumeSuggestion: {
			deleteMany: mocks.suggestionDeleteMany,
			updateMany: mocks.suggestionUpdateMany,
		},
		projectContext: { updateMany: mocks.contextUpdateMany },
		projectContextPendingVectorCleanup: { create: mocks.cleanupCreate },
	};
	return {
		db: {
			parlumeMeetingSession: { findMany: mocks.sessionFindMany },
			$queryRaw: mocks.queryRaw,
			$transaction: (run: (client: typeof tx) => Promise<unknown>) =>
				run(tx),
		},
	};
});

import {
	dropParlumeTranscriptVectors,
	listParlumeSessionsPastRetention,
	PARLUME_TRANSCRIPT_RETENTION_DAYS,
	purgeParlumeSessionContent,
} from "../parlume-retention";

const now = new Date("2026-11-19T12:00:00Z");
const childScope = {
	sessionId: "session-1",
	projectId: "project-1",
	organizationId: "example-org",
};
const settledSession = {
	id: "session-1",
	projectId: "project-1",
	organizationId: "example-org",
	userId: "inviter-1",
	transcriptContextId: "context-1",
	transcriptDeletedAt: null,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.sessionFindFirst.mockResolvedValue(settledSession);
	mocks.contextUpdateMany.mockResolvedValue({ count: 1 });
	mocks.cleanupCreate.mockResolvedValue({ id: "cleanup-1" });
	mocks.sessionFindMany.mockResolvedValue([]);
	mocks.queryRaw.mockResolvedValue([]);
});

describe("purgeParlumeSessionContent — a member's delete", () => {
	it("deletes the segments, requests, proposed changes, suggestions and receipts, and empties the transcript", async () => {
		const result = await purgeParlumeSessionContent({
			sessionId: "session-1",
			projectId: "project-1",
			scope: "SESSION",
			now,
		});

		for (const deleteMany of [
			mocks.segmentDeleteMany,
			mocks.receiptDeleteMany,
			mocks.actionDeleteMany,
			mocks.turnDeleteMany,
			mocks.suggestionDeleteMany,
		]) {
			expect(deleteMany).toHaveBeenCalledWith({ where: childScope });
		}
		expect(mocks.turnUpdateMany).not.toHaveBeenCalled();
		expect(mocks.sessionUpdate).toHaveBeenCalledWith({
			where: { id: "session-1" },
			// The speaker marks name participants and go with the segments.
			data: {
				transcriptDeletedAt: now,
				memberSpeakerIds: [],
				guestSpeakerIds: [],
			},
		});
		// The context row stays for its notes, without its text or vectors.
		expect(mocks.contextUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "context-1",
				projectId: "project-1",
				organizationId: "example-org",
				NOT: { content: "", embeddedAt: null, qdrantId: null },
			},
			data: { content: "", embeddedAt: null, qdrantId: null },
		});
		expect(mocks.cleanupCreate).toHaveBeenCalledWith({
			data: {
				projectId: "project-1",
				contextIds: ["context-1"],
				userId: null,
				organizationId: "example-org",
			},
			select: { id: true },
		});
		expect(result).toEqual({
			purged: true,
			vectorCleanup: {
				id: "cleanup-1",
				projectId: "project-1",
				contextIds: ["context-1"],
				userId: null,
				organizationId: "example-org",
			},
		});
	});

	it("only touches a settled session in the caller's project", async () => {
		await purgeParlumeSessionContent({
			sessionId: "session-1",
			projectId: "project-1",
			scope: "SESSION",
			now,
		});

		const { where } = mocks.sessionFindFirst.mock.calls[0][0];
		expect(where).toMatchObject({
			id: "session-1",
			projectId: "project-1",
		});
		expect(where.OR).toEqual([
			{ status: "ENDED" },
			{ status: "FAILED", finalizedAt: { not: null } },
			{ status: "FAILED", providerBotId: null },
		]);
		// A member may delete what the sweep already emptied.
		expect(where).not.toHaveProperty("transcriptDeletedAt");
	});

	it("deletes nothing while the session is live or still saving", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);

		await expect(
			purgeParlumeSessionContent({
				sessionId: "session-1",
				projectId: "project-1",
				scope: "SESSION",
				now,
			}),
		).resolves.toEqual({ purged: false, vectorCleanup: null });
		expect(mocks.segmentDeleteMany).not.toHaveBeenCalled();
		expect(mocks.turnDeleteMany).not.toHaveBeenCalled();
		expect(mocks.sessionUpdate).not.toHaveBeenCalled();
		expect(mocks.contextUpdateMany).not.toHaveBeenCalled();
	});

	it("keeps the first deletion time and queues no cleanup for an already-empty transcript", async () => {
		const earlier = new Date("2026-10-01T10:00:00Z");
		mocks.sessionFindFirst.mockResolvedValue({
			...settledSession,
			transcriptDeletedAt: earlier,
		});
		mocks.contextUpdateMany.mockResolvedValue({ count: 0 });

		const result = await purgeParlumeSessionContent({
			sessionId: "session-1",
			projectId: "project-1",
			scope: "SESSION",
			now,
		});

		expect(mocks.sessionUpdate).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: {
				transcriptDeletedAt: earlier,
				memberSpeakerIds: [],
				guestSpeakerIds: [],
			},
		});
		expect(mocks.cleanupCreate).not.toHaveBeenCalled();
		expect(result).toEqual({ purged: true, vectorCleanup: null });
	});
});

describe("purgeParlumeSessionContent — the retention sweep", () => {
	it("deletes the segments and receipts, and keeps the requests and suggestions without the meeting's words", async () => {
		await purgeParlumeSessionContent({
			sessionId: "session-1",
			projectId: "project-1",
			scope: "TRANSCRIPT",
			now,
		});

		expect(mocks.segmentDeleteMany).toHaveBeenCalledWith({
			where: childScope,
		});
		expect(mocks.receiptDeleteMany).toHaveBeenCalledWith({
			where: childScope,
		});
		expect(mocks.turnUpdateMany).toHaveBeenCalledWith({
			where: childScope,
			data: { requestText: "", responseText: null },
		});
		expect(mocks.suggestionUpdateMany).toHaveBeenCalledWith({
			where: childScope,
			data: { quote: null },
		});
		expect(mocks.actionDeleteMany).not.toHaveBeenCalled();
		expect(mocks.turnDeleteMany).not.toHaveBeenCalled();
		expect(mocks.suggestionDeleteMany).not.toHaveBeenCalled();
		expect(mocks.contextUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { content: "", embeddedAt: null, qdrantId: null },
			}),
		);
	});

	it("skips a session it already purged", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);

		await expect(
			purgeParlumeSessionContent({
				sessionId: "session-1",
				projectId: "project-1",
				scope: "TRANSCRIPT",
				now,
			}),
		).resolves.toEqual({ purged: false, vectorCleanup: null });
		expect(mocks.sessionFindFirst.mock.calls[0][0].where).toMatchObject({
			transcriptDeletedAt: null,
		});
		expect(mocks.segmentDeleteMany).not.toHaveBeenCalled();
	});
});

describe("listParlumeSessionsPastRetention", () => {
	it("lists settled, unpurged sessions older than 90 days, oldest first", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			{ id: "session-1", projectId: "project-1" },
		]);

		await expect(
			listParlumeSessionsPastRetention({ now, limit: 50 }),
		).resolves.toEqual([{ id: "session-1", projectId: "project-1" }]);

		expect(PARLUME_TRANSCRIPT_RETENTION_DAYS).toBe(90);
		const query = mocks.sessionFindMany.mock.calls[0][0];
		expect(query.where).toMatchObject({
			transcriptDeletedAt: null,
			createdAt: { lt: new Date("2026-08-21T12:00:00Z") },
		});
		expect(query.where.OR).toHaveLength(3);
		expect(query.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
		expect(query.take).toBe(50);
	});
});

describe("dropParlumeTranscriptVectors", () => {
	it("clears each embedded Parlume transcript's index marks and queues its vectors", async () => {
		mocks.queryRaw.mockResolvedValue([
			{
				contextId: "context-1",
				projectId: "project-1",
				organizationId: "example-org",
				userId: "inviter-1",
			},
		]);

		await expect(
			dropParlumeTranscriptVectors({ limit: 50 }),
		).resolves.toEqual([
			{
				id: "cleanup-1",
				projectId: "project-1",
				contextIds: ["context-1"],
				userId: null,
				organizationId: "example-org",
			},
		]);
		expect(mocks.contextUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "context-1",
				projectId: "project-1",
				organizationId: "example-org",
			},
			data: { embeddedAt: null, qdrantId: null },
		});
	});

	it("does nothing when no Parlume transcript is embedded", async () => {
		await expect(
			dropParlumeTranscriptVectors({ limit: 50 }),
		).resolves.toEqual([]);
		expect(mocks.contextUpdateMany).not.toHaveBeenCalled();
		expect(mocks.cleanupCreate).not.toHaveBeenCalled();
	});
});
