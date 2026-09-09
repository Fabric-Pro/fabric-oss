import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `setTopicQuestionAssignees` — per-question routing for the Publishing Suite
 * (Fizzy #1851).
 *
 * Unit-level with a mocked `db`, matching `list-topic-decisions.test.ts`: what
 * is under test is the write's SHAPE — the diff it computes, where the child
 * row's tenant columns come from, and what it hands back for notification —
 * not real Postgres semantics.
 *
 * The tenancy assertions are the ones that matter. The child's `userId` /
 * `organizationId` are copied from the QUESTION, and the table's XOR check
 * compares those two columns to each other rather than to the parent — so a
 * row stamped with the caller's own tenant would satisfy the constraint and
 * still be invisible to every reader of the thread it belongs to. Only a test
 * that reads the arguments can catch that.
 */

const { findFirst, findMany, createMany, deleteMany, transaction } = vi.hoisted(
	() => ({
		findFirst: vi.fn(),
		findMany: vi.fn(),
		createMany: vi.fn(),
		deleteMany: vi.fn(),
		transaction: vi.fn(),
	}),
);

vi.mock("../prisma/client", () => ({
	db: {
		publishingTopicDecisionEntry: { findFirst },
		publishingTopicQuestionAssignee: { findMany },
		$transaction: transaction,
	},
}));

import { setTopicQuestionAssignees } from "../prisma/queries/projects/publishing-decisions";

/** The question the assignment hangs off, in an organization. */
const ORG_QUESTION = {
	id: "root-1",
	userId: null,
	organizationId: "org-1",
	subject: "the named customer",
	content: null,
};

const INPUT = {
	topicId: "topic-1",
	projectId: "proj-1",
	entryId: "root-1",
	assignedByUserId: "asker-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	findFirst.mockResolvedValue(ORG_QUESTION);
	findMany.mockResolvedValue([]);
	// Run the callback against a tx that records what it was asked to write.
	transaction.mockImplementation(
		async (fn: (tx: unknown) => Promise<unknown>) =>
			fn({
				publishingTopicQuestionAssignee: { createMany, deleteMany },
			}),
	);
});

describe("setTopicQuestionAssignees", () => {
	it("only ever writes a QUESTION ROOT in this topic and project", async () => {
		await setTopicQuestionAssignees({ ...INPUT, assigneeUserIds: ["u1"] });

		// A reply carries no assignees, and a question in another topic is
		// another tenant's business. Both are excluded by the lookup rather
		// than by the caller, so no call site can forget.
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "root-1",
					topicId: "topic-1",
					projectId: "proj-1",
					parentId: null,
					kind: "QUESTION",
					deletedAt: null,
				}),
			}),
		);
	});

	it("takes the row's tenant from the QUESTION, never from the caller", async () => {
		await setTopicQuestionAssignees({ ...INPUT, assigneeUserIds: ["u1"] });

		expect(createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					{
						decisionEntryId: "root-1",
						assigneeUserId: "u1",
						assignedByUserId: "asker-1",
						projectId: "proj-1",
						userId: null,
						organizationId: "org-1",
					},
				],
				skipDuplicates: true,
			}),
		);
	});

	it("returns only the people it ADDED, so a re-save notifies nobody", async () => {
		findMany.mockResolvedValue([{ assigneeUserId: "u1" }]);

		const result = await setTopicQuestionAssignees({
			...INPUT,
			assigneeUserIds: ["u1", "u2"],
		});

		// u1 was already there. Notifying them again is how a picker whose
		// avatars people toggle turns into a source of noise.
		expect(result?.added).toEqual(["u2"]);
	});

	it("leaves an existing row untouched rather than rewriting it", async () => {
		findMany.mockResolvedValue([{ assigneeUserId: "u1" }]);

		await setTopicQuestionAssignees({
			...INPUT,
			assigneeUserIds: ["u1", "u2"],
		});

		// Re-picking somebody already assigned must not transfer who is
		// recorded as having asked — that record is what makes "tell the person
		// who asked" resolve to one person after a re-assignment.
		const written = createMany.mock.calls[0][0].data as Array<{
			assigneeUserId: string;
		}>;
		expect(written.map((row) => row.assigneeUserId)).toEqual(["u2"]);
	});

	it("clears the question when the desired set is empty", async () => {
		findMany.mockResolvedValue([
			{ assigneeUserId: "u1" },
			{ assigneeUserId: "u2" },
		]);

		const result = await setTopicQuestionAssignees({
			...INPUT,
			assigneeUserIds: [],
		});

		expect(deleteMany).toHaveBeenCalledWith({
			where: {
				decisionEntryId: "root-1",
				assigneeUserId: { in: ["u1", "u2"] },
			},
		});
		expect(createMany).not.toHaveBeenCalled();
		expect(result?.added).toEqual([]);
	});

	it("writes nothing at all when the set is unchanged", async () => {
		findMany.mockResolvedValue([{ assigneeUserId: "u1" }]);

		const result = await setTopicQuestionAssignees({
			...INPUT,
			assigneeUserIds: ["u1"],
		});

		// Not merely "writes the same rows again": the picker submits the whole
		// list on every interaction, so an unchanged save must not open a
		// transaction at all.
		expect(transaction).not.toHaveBeenCalled();
		expect(result).toEqual({ added: [], summary: "the named customer" });
	});

	it("collapses a duplicated id instead of writing it twice", async () => {
		await setTopicQuestionAssignees({
			...INPUT,
			assigneeUserIds: ["u1", "u1"],
		});

		const written = createMany.mock.calls[0][0].data as unknown[];
		expect(written).toHaveLength(1);
	});

	it("returns null for a question that is not in this topic", async () => {
		findFirst.mockResolvedValue(null);

		const result = await setTopicQuestionAssignees({
			...INPUT,
			assigneeUserIds: ["u1"],
		});

		// NOT an empty added-list: the caller has to be able to tell "nobody
		// new was added" from "there is no such question", or the picker keeps
		// showing avatars the server never stored.
		expect(result).toBeNull();
		expect(transaction).not.toHaveBeenCalled();
	});

	it("hands back the question's own wording for the notification", async () => {
		findFirst.mockResolvedValue({
			...ORG_QUESTION,
			subject: null,
			content: "May we name the customer?",
		});

		const result = await setTopicQuestionAssignees({
			...INPUT,
			assigneeUserIds: ["u1"],
		});

		// Falls back to `content` when there is no subject, so a question
		// minted without one still gives the bell row something to say.
		expect(result?.summary).toBe("May we name the customer?");
	});
});
