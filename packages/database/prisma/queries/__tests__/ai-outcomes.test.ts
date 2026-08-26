import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertMock = vi.hoisted(() => vi.fn());
const deleteManyMock = vi.hoisted(() => vi.fn());
const findManyMock = vi.hoisted(() => vi.fn());
const groupByMock = vi.hoisted(() => vi.fn());

vi.mock("../../client", () => ({
	db: {
		aiOutcomeEvent: {
			upsert: upsertMock,
			deleteMany: deleteManyMock,
			findMany: findManyMock,
			groupBy: groupByMock,
		},
	},
	Prisma: {},
}));

import {
	clearAiOutcome,
	getAiOutcomeBreakdown,
	getAiOutcomesForSubjects,
	recordAiOutcome,
} from "../ai-outcomes";

const SUBJECT = {
	featureKey: "chat-agent",
	subjectType: "chat-message",
	subjectId: "msg-1",
	userId: "user-1",
};

describe("recordAiOutcome", () => {
	beforeEach(() => {
		upsertMock.mockReset().mockResolvedValue({ outcome: "RATED_UP" });
	});

	/**
	 * The whole table is "one verdict per person per thing" — a user changing
	 * their mind must update their row, never add a second contradictory one.
	 */
	it("upserts on the (feature, subject, user) key", async () => {
		await recordAiOutcome({ ...SUBJECT, outcome: "RATED_UP" });

		const arg = upsertMock.mock.calls[0][0];
		expect(arg.where).toEqual({
			featureKey_subjectType_subjectId_userId: SUBJECT,
		});
		expect(arg.update).toMatchObject({ outcome: "RATED_UP" });
	});

	it("refreshes the model/prompt snapshot on re-rating", async () => {
		await recordAiOutcome({
			...SUBJECT,
			outcome: "RATED_DOWN",
			modelCanonicalName: "claude-sonnet-5",
			promptVersionId: "pv-9",
		});

		expect(upsertMock.mock.calls[0][0].update).toMatchObject({
			outcome: "RATED_DOWN",
			modelCanonicalName: "claude-sonnet-5",
			promptVersionId: "pv-9",
		});
	});

	it("normalizes absent tenant scope to null rather than undefined", async () => {
		await recordAiOutcome({ ...SUBJECT, outcome: "RATED_UP" });

		expect(upsertMock.mock.calls[0][0].create).toMatchObject({
			organizationId: null,
			projectId: null,
			modelCanonicalName: null,
			promptVersionId: null,
			comment: null,
		});
	});
});

describe("clearAiOutcome", () => {
	beforeEach(() => deleteManyMock.mockReset());

	it("reports whether anything was actually removed", async () => {
		deleteManyMock.mockResolvedValue({ count: 1 });
		expect(await clearAiOutcome(SUBJECT)).toBe(1);

		deleteManyMock.mockResolvedValue({ count: 0 });
		expect(await clearAiOutcome(SUBJECT)).toBe(0);
	});

	it("scopes the delete to the calling user", async () => {
		deleteManyMock.mockResolvedValue({ count: 1 });
		await clearAiOutcome(SUBJECT);
		expect(deleteManyMock.mock.calls[0][0].where).toEqual(SUBJECT);
	});
});

describe("getAiOutcomesForSubjects", () => {
	beforeEach(() => findManyMock.mockReset());

	it("short-circuits an empty id list without querying", async () => {
		expect(
			await getAiOutcomesForSubjects({
				featureKey: "chat-agent",
				subjectType: "chat-message",
				subjectIds: [],
				userId: "user-1",
			}),
		).toEqual({});
		expect(findManyMock).not.toHaveBeenCalled();
	});

	it("keys results by subject id", async () => {
		findManyMock.mockResolvedValue([
			{ subjectId: "msg-1", outcome: "RATED_UP" },
			{ subjectId: "msg-2", outcome: "RATED_DOWN" },
		]);

		expect(
			await getAiOutcomesForSubjects({
				featureKey: "chat-agent",
				subjectType: "chat-message",
				subjectIds: ["msg-1", "msg-2"],
				userId: "user-1",
			}),
		).toEqual({ "msg-1": "RATED_UP", "msg-2": "RATED_DOWN" });
	});
});

describe("getAiOutcomeBreakdown", () => {
	beforeEach(() => groupByMock.mockReset());

	it("folds groups into per-feature counts, busiest feature first", async () => {
		groupByMock.mockResolvedValue([
			{
				featureKey: "chat-agent",
				outcome: "RATED_UP",
				_count: { _all: 3 },
			},
			{
				featureKey: "chat-agent",
				outcome: "RATED_DOWN",
				_count: { _all: 1 },
			},
			{
				featureKey: "maturation",
				outcome: "ACCEPTED_AS_IS",
				_count: { _all: 10 },
			},
		]);

		const result = await getAiOutcomeBreakdown({
			from: new Date("2026-08-01"),
			to: new Date("2026-08-19"),
		});

		expect(result.map((row) => row.featureKey)).toEqual([
			"maturation",
			"chat-agent",
		]);
		expect(result[1]).toMatchObject({
			featureKey: "chat-agent",
			total: 4,
		});
		expect(result[1].counts.RATED_UP).toBe(3);
		// Outcomes nobody recorded still report zero rather than undefined, so
		// a rate computed off them cannot come out NaN.
		expect(result[1].counts.ACCEPTED_AS_IS).toBe(0);
	});
});
