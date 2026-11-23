import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	transcriptFindMany: vi.fn(),
	transcriptCount: vi.fn(),
	sessionFindMany: vi.fn(),
	contextFindMany: vi.fn(),
	contextCount: vi.fn(),
	contextFindFirst: vi.fn(),
	summaryUpdateMany: vi.fn(),
	summaryFindUnique: vi.fn(),
	summaryFindFirst: vi.fn(),
	summaryUpdate: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		projectMeetingTranscript: {
			findMany: mocks.transcriptFindMany,
			count: mocks.transcriptCount,
		},
		parlumeMeetingSession: { findMany: mocks.sessionFindMany },
		projectContext: {
			findMany: mocks.contextFindMany,
			count: mocks.contextCount,
			findFirst: mocks.contextFindFirst,
		},
		projectContextSummary: {
			updateMany: mocks.summaryUpdateMany,
			findUnique: mocks.summaryFindUnique,
		},
		$transaction: (run: (tx: unknown) => Promise<unknown>) =>
			run({
				projectContextSummary: {
					findFirst: mocks.summaryFindFirst,
					updateMany: mocks.summaryUpdateMany,
					update: mocks.summaryUpdate,
				},
			}),
	},
}));

import {
	completeContextSummary,
	countRawContextRows,
	fetchProjectContextBatch,
	retireContextSummariesCoveringSeries,
} from "../../project-context-summaries";
import {
	findConfidentialTranscriptContextIds,
	listMeetingTranscriptsByDate,
} from "../meeting-transcripts";

const tenancy = { userId: null, organizationId: "example-org" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.transcriptFindMany.mockResolvedValue([]);
	mocks.transcriptCount.mockResolvedValue(0);
	mocks.sessionFindMany.mockResolvedValue([]);
	mocks.contextFindMany.mockResolvedValue([]);
	mocks.contextCount.mockResolvedValue(0);
});

describe("findConfidentialTranscriptContextIds", () => {
	it("finds the synced transcripts of the project's confidential series and every Parlume transcript among the candidates", async () => {
		mocks.transcriptFindMany.mockResolvedValue([
			{ contextId: "ctx-synced" },
		]);
		mocks.sessionFindMany.mockResolvedValue([
			{ transcriptContextId: "ctx-parlume" },
		]);

		const ids = await findConfidentialTranscriptContextIds({
			projectId: "project-1",
			contextIds: ["ctx-synced", "ctx-parlume", "ctx-prd"],
		});

		expect(ids).toEqual(new Set(["ctx-synced", "ctx-parlume"]));
		expect(mocks.transcriptFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				contextId: { in: ["ctx-synced", "ctx-parlume", "ctx-prd"] },
				linkedMeeting: { confidential: true },
			},
			select: { contextId: true },
		});
		// A Parlume transcript is left out whether or not its series is
		// confidential: answers read its notes, not what the meeting said.
		expect(mocks.sessionFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				transcriptContextId: {
					in: ["ctx-synced", "ctx-parlume", "ctx-prd"],
				},
			},
			select: { transcriptContextId: true },
		});
	});

	it("checks every transcript of the project when given no candidates to narrow to", async () => {
		await findConfidentialTranscriptContextIds({ projectId: "project-1" });

		expect(mocks.transcriptFindMany.mock.calls[0]?.[0].where).toEqual({
			projectId: "project-1",
			contextId: { not: null },
			linkedMeeting: { confidential: true },
		});
		expect(mocks.sessionFindMany.mock.calls[0]?.[0].where).toEqual({
			projectId: "project-1",
			transcriptContextId: { not: null },
		});
	});

	it("reads nothing when there are no candidates", async () => {
		await expect(
			findConfidentialTranscriptContextIds({
				projectId: "project-1",
				contextIds: [],
			}),
		).resolves.toEqual(new Set());
		expect(mocks.transcriptFindMany).not.toHaveBeenCalled();
		expect(mocks.sessionFindMany).not.toHaveBeenCalled();
	});
});

describe("listMeetingTranscriptsByDate", () => {
	it("leaves a confidential series' transcripts out of the listing and its total", async () => {
		await listMeetingTranscriptsByDate({ projectId: "project-1" });

		const confidentialFilter = expect.objectContaining({
			projectId: "project-1",
			linkedMeeting: { confidential: false },
		});
		expect(mocks.transcriptFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: confidentialFilter }),
		);
		expect(mocks.transcriptCount).toHaveBeenCalledWith({
			where: confidentialFilter,
		});
	});
});

describe("context summarization sources", () => {
	beforeEach(() => {
		mocks.transcriptFindMany.mockResolvedValue([
			{ contextId: "ctx-synced" },
		]);
		mocks.sessionFindMany.mockResolvedValue([
			{ transcriptContextId: "ctx-parlume" },
		]);
	});

	it("never folds a confidential series' transcript into the summary", async () => {
		await fetchProjectContextBatch({
			projectId: "project-1",
			tenancy,
			snapshotThrough: new Date("2026-11-18T00:00:00Z"),
			afterCreatedAt: null,
			afterId: null,
			maxChars: 10_000,
		});

		expect(mocks.contextFindMany.mock.calls[0]?.[0].where).toMatchObject({
			projectId: "project-1",
			id: { notIn: ["ctx-synced", "ctx-parlume"] },
		});
	});

	it("never counts one as context the summary should cover", async () => {
		await countRawContextRows({ projectId: "project-1", tenancy });

		expect(mocks.contextCount.mock.calls[0]?.[0].where).toMatchObject({
			projectId: "project-1",
			id: { notIn: ["ctx-synced", "ctx-parlume"] },
		});
	});

	it("adds no filter when no series is confidential", async () => {
		mocks.transcriptFindMany.mockResolvedValue([]);
		mocks.sessionFindMany.mockResolvedValue([]);

		await countRawContextRows({ projectId: "project-1", tenancy });

		expect(mocks.contextCount.mock.calls[0]?.[0].where).not.toHaveProperty(
			"id",
		);
	});
});

describe("retireContextSummariesCoveringSeries", () => {
	it("retires the runs in progress and the current summaries that reach the series' earliest transcript", async () => {
		const earliest = new Date("2026-11-01T10:00:00Z");
		mocks.transcriptFindMany.mockResolvedValue([
			{ contextId: "ctx-synced" },
		]);
		mocks.sessionFindMany.mockResolvedValue([
			{ transcriptContextId: "ctx-parlume" },
		]);
		mocks.contextFindFirst.mockResolvedValue({ createdAt: earliest });
		mocks.summaryUpdateMany.mockResolvedValue({ count: 1 });

		const retired = await retireContextSummariesCoveringSeries({
			projectId: "project-1",
			linkedMeetingId: "lm-1",
		});

		expect(retired).toBe(2);
		expect(mocks.summaryUpdateMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				status: { in: ["PENDING", "GENERATING"] },
			},
			data: expect.objectContaining({ status: "CANCELLED" }),
		});
		expect(mocks.contextFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "project-1",
					id: { in: ["ctx-synced", "ctx-parlume"] },
				},
			}),
		);
		expect(mocks.summaryUpdateMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				status: "COMPLETED",
				supersededById: null,
				coveredThrough: { gte: earliest },
			},
			data: expect.objectContaining({ status: "CANCELLED" }),
		});
	});

	it("leaves a run retired while it ran cancelled when it completes, superseding nothing", async () => {
		mocks.summaryFindUnique.mockResolvedValue({
			projectId: "project-1",
			userId: null,
			organizationId: "example-org",
		});
		mocks.summaryFindFirst.mockResolvedValue({ id: "summary-prior" });
		mocks.summaryUpdateMany.mockResolvedValue({ count: 0 });

		await completeContextSummary({
			id: "summary-run",
			content: "Digest",
			tokenCount: 10,
			coveredContextCount: 1,
			coveredThrough: new Date("2026-11-02T00:00:00Z"),
			model: "model",
			references: [],
			stats: {
				eligibleSourceCount: 1,
				processedSourceCount: 1,
				deferredSourceCount: 0,
				batchCount: 1,
				inputChars: 100,
				firstProcessedAt: null,
				lastProcessedAt: null,
				cursorId: null,
				cursorCreatedAt: null,
				markerSeq: 1,
				incompleteCoverage: false,
			},
		});

		expect(mocks.summaryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "summary-run",
					status: { in: ["PENDING", "GENERATING"] },
				},
			}),
		);
		expect(mocks.summaryUpdate).not.toHaveBeenCalled();
	});

	it("leaves every summary alone when the series has no transcript", async () => {
		const retired = await retireContextSummariesCoveringSeries({
			projectId: "project-1",
			linkedMeetingId: "lm-1",
		});

		expect(retired).toBe(0);
		expect(mocks.summaryUpdateMany).not.toHaveBeenCalled();
	});
});
