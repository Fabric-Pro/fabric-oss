import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `listTopicDecisions` — the decision thread read (Publishing Suite Phase
 * 2A-3, Fizzy #1851).
 *
 * Unit-level with a mocked `db`, matching `publishing-planning-analysis.test.ts`:
 * this exercises the query's SHAPE — the scoping args it sends to Prisma, and
 * how the flat row set is assembled into roots-with-replies — not real
 * Postgres semantics.
 */

const { findMany } = vi.hoisted(() => ({
	findMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		publishingTopicDecisionEntry: { findMany },
	},
}));

import { listTopicDecisions } from "../prisma/queries/projects/publishing-decisions";

function row(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "row-1",
		parentId: null,
		kind: "QUESTION",
		status: "OPEN",
		authorType: "AGENT",
		authorUserId: null,
		questionId: "q1",
		decisionKind: "ASSET_APPROVAL",
		subject: null,
		summary: "Which asset?",
		content: null,
		recommendedResponse: null,
		answerSource: null,
		analysisVersion: 1,
		createdAt: new Date("2026-08-01T00:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("listTopicDecisions", () => {
	it("scopes the read by topicId AND projectId (DV16), not topicId alone", async () => {
		findMany.mockResolvedValue([]);

		await listTopicDecisions({ topicId: "topic-1", projectId: "proj-1" });

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					topicId: "topic-1",
					projectId: "proj-1",
					deletedAt: null,
				},
			}),
		);
	});

	it("assembles roots with their replies", async () => {
		const root = row({ id: "root-1", parentId: null });
		const reply = row({
			id: "reply-1",
			parentId: "root-1",
			kind: "AI_UPDATE",
			questionId: null,
			content: "Note.",
		});
		findMany.mockResolvedValue([root, reply]);

		const threads = await listTopicDecisions({
			topicId: "topic-1",
			projectId: "proj-1",
		});

		expect(threads).toEqual([{ root, replies: [reply] }]);
	});

	it("gives a root with no replies an empty replies array", async () => {
		const root = row({ id: "root-1", parentId: null });
		findMany.mockResolvedValue([root]);

		const threads = await listTopicDecisions({
			topicId: "topic-1",
			projectId: "proj-1",
		});

		expect(threads).toEqual([{ root, replies: [] }]);
	});

	it("returns no threads when nothing matches the scope", async () => {
		findMany.mockResolvedValue([]);

		const threads = await listTopicDecisions({
			topicId: "elsewhere",
			projectId: "proj-1",
		});

		expect(threads).toEqual([]);
	});

	it("orders by createdAt, then id, so rows sharing a millisecond keep one order", async () => {
		// A regeneration writes its whole question set in one transaction, and
		// two amendments can share a millisecond, so createdAt ties are
		// ordinary. `amendTopicQuestionAnswer` already breaks them by id; this
		// read must agree with it, or two reads of unchanged data can disagree.
		findMany.mockResolvedValue([]);

		await listTopicDecisions({ topicId: "topic-1", projectId: "proj-1" });

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
			}),
		);
	});
});
