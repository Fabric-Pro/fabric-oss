import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Restoring a set-aside question (Fizzy #1988).
 *
 * Unit-level with a mocked `db`, like `publishing-question-assignee.test.ts`:
 * what is under test is the write's SHAPE. `answerTopicQuestion` keeps a
 * POSSIBLY_RESOLVED root answerable and flips it to RESOLVED, so an answer can
 * land between the restore's read and its write. The write therefore claims
 * the status it read, and losing the claim is `null` — the same result as a
 * question that was never set aside.
 */

const { findFirst, update, updateMany } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
	updateMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		publishingTopicDecisionEntry: { findFirst, update, updateMany },
	},
	Prisma: {},
}));

import { restoreTopicQuestion } from "../prisma/queries/projects/publishing-decisions";

const INPUT = {
	topicId: "topic-1",
	projectId: "proj-1",
	entryId: "root-1",
};

const SET_ASIDE = {
	id: "root-1",
	subject: "the named customer",
	content: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	findFirst.mockResolvedValue(SET_ASIDE);
	updateMany.mockResolvedValue({ count: 1 });
});

describe("restoreTopicQuestion", () => {
	it("claims the set-aside status it read, in one conditional write", async () => {
		await restoreTopicQuestion(INPUT);

		expect(updateMany).toHaveBeenCalledTimes(1);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "root-1",
				topicId: "topic-1",
				projectId: "proj-1",
				parentId: null,
				kind: "QUESTION",
				status: "POSSIBLY_RESOLVED",
				deletedAt: null,
			},
			data: { status: "OPEN" },
		});
		expect(update).not.toHaveBeenCalled();
	});

	it("reports the restore when the claim wins", async () => {
		expect(await restoreTopicQuestion(INPUT)).toEqual({
			restored: true,
			summary: "the named customer",
		});
	});

	it("returns null when an answer reached the question first", async () => {
		updateMany.mockResolvedValue({ count: 0 });

		expect(await restoreTopicQuestion(INPUT)).toBeNull();
	});

	it("returns null without writing when the question is not set aside", async () => {
		findFirst.mockResolvedValue(null);

		expect(await restoreTopicQuestion(INPUT)).toBeNull();
		expect(updateMany).not.toHaveBeenCalled();
	});
});
