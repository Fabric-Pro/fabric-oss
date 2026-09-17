import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Amending an already-answered question on a publishing topic
 * (Fizzy #1851, UI-review follow-up).
 *
 * Unit-level with a mocked `db`, matching `publishing-topic-decisions.test.ts`:
 * what this exercises is the transaction's SHAPE — which row is read, which
 * refusal each precondition produces, and what is written on the one path that
 * writes. Real Postgres semantics (the partial unique index, the CHECK
 * constraints) live in the migration and in the RUN_DB_INTEGRATION suites, so
 * this file runs in the regular no-Postgres run.
 *
 * The thing most worth pinning here is that `answerTopicQuestion` was NOT
 * loosened to make this work. Its refusal to answer a settled root is what
 * stops a double-submit minting two replies for one act, and its own docstring
 * records that. Amending is a different act with the opposite precondition —
 * there must already BE an answer — so it is a second function with its own
 * guard, and the last group below asserts the original guard still holds.
 */

const { findFirst, findUnique, updateMany, create, transaction } = vi.hoisted(
	() => ({
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		updateMany: vi.fn(),
		create: vi.fn(),
		transaction: vi.fn(),
	}),
);

const tx = {
	publishingTopicDecisionEntry: {
		findFirst,
		findUnique,
		updateMany,
		create,
	},
};

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: transaction,
		publishingTopicDecisionEntry: {
			findFirst,
			findUnique,
			updateMany,
			create,
		},
	},
	Prisma: {},
}));

import { currentAnswerReply } from "@repo/utils/publishing-restrictions";
import {
	amendTopicQuestionAnswer,
	answerTopicQuestion,
} from "../prisma/queries/projects/publishing-decisions";

const ROOT_UPDATED_AT = new Date("2026-09-01T10:00:00Z");

const ROOT = {
	id: "root-1",
	status: "RESOLVED",
	updatedAt: ROOT_UPDATED_AT,
	organizationId: "org-1",
	userId: null,
};

const LIVE_REPLY = { id: "reply-1", content: "Yes, name them." };

const INPUT = {
	topicId: "topic-1",
	projectId: "proj-1",
	questionId: "q-customer-name",
	supersedesId: LIVE_REPLY.id,
	answer: "No — legal has not signed off yet.",
	answerSource: "MANUAL" as const,
	authorUserId: "user-1",
};

/**
 * One `findFirst` mock serves two different reads: the QUESTION root
 * (`parentId: null`) and the live answering reply (`parentId: <root id>`).
 * Dispatching on the argument rather than queueing two `Once` values keeps each
 * test readable AND catches a swap — a function that read the reply first would
 * get the wrong row back rather than silently passing.
 */
function stubReads(
	root: typeof ROOT | null,
	live: typeof LIVE_REPLY | null,
): void {
	findFirst.mockImplementation(
		async (args: { where: { parentId: string | null } }) =>
			args.where.parentId === null ? root : live,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	transaction.mockImplementation(
		async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
	);
	findUnique.mockResolvedValue({ ...ROOT, kind: "QUESTION" });
	updateMany.mockResolvedValue({ count: 1 });
	create.mockResolvedValue({ id: "reply-2" });
});

describe("amendTopicQuestionAnswer — what it refuses", () => {
	it("returns not_found when the question does not exist", async () => {
		stubReads(null, null);

		const result = await amendTopicQuestionAnswer(INPUT);

		expect(result.status).toBe("not_found");
		expect(create).not.toHaveBeenCalled();
	});

	it("returns not_found for an OPEN question — that one is answered, not amended", async () => {
		stubReads({ ...ROOT, status: "OPEN" }, LIVE_REPLY);

		const result = await amendTopicQuestionAnswer(INPUT);

		expect(result.status).toBe("not_found");
		expect(create).not.toHaveBeenCalled();
	});

	it("returns not_found for POSSIBLY_RESOLVED, which is still awaiting a first answer", async () => {
		// Soft-closed by a regeneration that stopped raising it, not settled by
		// anyone. `answerTopicQuestion` deliberately keeps it answerable; there
		// is nothing here to supersede.
		stubReads({ ...ROOT, status: "POSSIBLY_RESOLVED" }, LIVE_REPLY);

		expect((await amendTopicQuestionAnswer(INPUT)).status).toBe(
			"not_found",
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("returns stale when supersedesId no longer names the live answer", async () => {
		// A colleague amended first. Applying this would silently discard their
		// correction on behalf of someone who never read it.
		stubReads(ROOT, { id: "reply-9", content: "A newer answer." });

		const result = await amendTopicQuestionAnswer(INPUT);

		expect(result.status).toBe("stale");
		expect(create).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("returns stale when the claim loses a concurrent race", async () => {
		// Both amenders read the same live reply, so the read-check above passes
		// for both. The conditional update on the root's `updatedAt` is what
		// actually serializes them.
		stubReads(ROOT, LIVE_REPLY);
		updateMany.mockResolvedValue({ count: 0 });

		const result = await amendTopicQuestionAnswer(INPUT);

		expect(result.status).toBe("stale");
		expect(create).not.toHaveBeenCalled();
	});

	it("returns deduped when the submitted text already IS the live answer", async () => {
		// What a double-click on Save produces. An amendment that changes no
		// words is not a decision, so nothing is appended.
		stubReads(ROOT, LIVE_REPLY);

		const result = await amendTopicQuestionAnswer({
			...INPUT,
			answer: `  ${LIVE_REPLY.content}  `,
		});

		expect(result.status).toBe("deduped");
		expect(create).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});
});

describe("amendTopicQuestionAnswer — what it writes", () => {
	beforeEach(() => {
		stubReads(ROOT, LIVE_REPLY);
	});

	it("appends a reply instead of editing the superseded one", async () => {
		const result = await amendTopicQuestionAnswer(INPUT);

		expect(result.status).toBe("amended");
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					parentId: ROOT.id,
					content: INPUT.answer,
					kind: "QUESTION",
					status: "RESOLVED",
					authorType: "USER",
				}),
			}),
		);
		// Nothing rewrites the turn being replaced: the log's history is the
		// whole reason an amendment supersedes rather than edits.
		const updatedIds = updateMany.mock.calls.map(
			(c) => (c[0] as { where: { id: string } }).where.id,
		);
		expect(updatedIds).not.toContain(LIVE_REPLY.id);
	});

	it("attributes the amendment to the session user, never to the request body", async () => {
		await amendTopicQuestionAnswer(INPUT);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					authorUserId: INPUT.authorUserId,
				}),
			}),
		);
	});

	it("inherits tenancy from the root rather than stamping the amender's own", async () => {
		// Stamping the amending user's tenant would break the XOR the moment
		// someone amends inside an org topic — and would file the row under the
		// wrong tenant besides.
		await amendTopicQuestionAnswer(INPUT);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					organizationId: ROOT.organizationId,
					userId: ROOT.userId,
				}),
			}),
		);
	});

	it("scopes every read and the claim to BOTH projectId and topicId (DV16)", async () => {
		await amendTopicQuestionAnswer(INPUT);

		for (const call of findFirst.mock.calls) {
			const where = (call[0] as { where: Record<string, unknown> }).where;
			expect(where.projectId).toBe(INPUT.projectId);
			expect(where.topicId).toBe(INPUT.topicId);
		}
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: INPUT.projectId,
					topicId: INPUT.topicId,
				}),
			}),
		);
	});

	it("claims on the root's own updatedAt, and leaves it RESOLVED", async () => {
		await amendTopicQuestionAnswer(INPUT);

		const claim = updateMany.mock.calls[0][0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};
		expect(claim.where.updatedAt).toBe(ROOT_UPDATED_AT);
		expect(claim.where.status).toBe("RESOLVED");
		// Amending changes the answer, not whether the question is settled.
		expect(claim.data.status).toBeUndefined();
	});

	it("moves answerSource onto the root with the answer it now describes", async () => {
		// The column measures recommendation acceptance. Leaving the superseded
		// answer's source behind would report it for text that no longer says
		// what it said.
		await amendTopicQuestionAnswer({ ...INPUT, answerSource: "MANUAL" });

		expect(updateMany.mock.calls[0][0]).toMatchObject({
			data: { answerSource: "MANUAL" },
		});
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ answerSource: "MANUAL" }),
			}),
		);
	});

	it("reads the live answer newest-first, so the chain's last turn is the one superseded", async () => {
		await amendTopicQuestionAnswer(INPUT);

		const replyRead = findFirst.mock.calls
			.map((c) => c[0] as { where: { parentId: string | null } })
			.find((args) => args.where.parentId !== null) as unknown as {
			orderBy: { createdAt?: string; id?: string }[];
		};
		expect(replyRead.orderBy).toEqual([
			{ createdAt: "desc" },
			{ id: "desc" },
		]);
	});
});

describe("answerTopicQuestion is unchanged by the amend path", () => {
	it("still refuses a RESOLVED root rather than answering it twice", async () => {
		// The guard that stops a double-submit minting two replies. If amending
		// had been built by relaxing this, this case would go green while that
		// bug came back.
		findFirst.mockResolvedValue({
			id: ROOT.id,
			status: "RESOLVED",
			organizationId: "org-1",
			userId: null,
		});

		const result = await answerTopicQuestion({
			topicId: INPUT.topicId,
			projectId: INPUT.projectId,
			questionId: INPUT.questionId,
			answer: "A second answer.",
			answerSource: "MANUAL",
			authorUserId: INPUT.authorUserId,
		});

		expect(result.status).toBe("deduped");
		expect(create).not.toHaveBeenCalled();
	});
});

/**
 * The amend guard reads the same reply the page shows and drafting uses.
 *
 * A query cannot call `currentAnswerReply`, so the rule lives twice: once in
 * the helper and once as the `where` of the guard's read. This fake serves that
 * read the way Postgres would — equality on every key it receives, the one
 * operator the guard ever used (`{ not: null }`), `undefined` ignored like
 * Prisma, the `orderBy` array — and THROWS on anything else, so a change to the
 * query that the fake cannot judge fails loudly instead of passing. Each case
 * compares the row the fake RETURNED with the helper's pick over the thread's
 * own replies, never infers it from the outcome.
 *
 * Every pool also holds four decoys that are answers in every other respect —
 * a person's, RESOLVED, with text, newer than any real reply — each outside the
 * thread by exactly one key: another root, soft-deleted, another topic, another
 * project. A query that drops that key returns the decoy.
 */
type ReplyRow = {
	id: string;
	parentId: string;
	projectId: string;
	topicId: string;
	deletedAt: Date | null;
	authorType: "USER" | "AGENT";
	status: string;
	content: string | null;
	createdAt: Date;
};

const minute = (m: number) => new Date(Date.UTC(2026, 8, 1, 10, m));

const replyRow = (
	over: Partial<ReplyRow> & Pick<ReplyRow, "id">,
): ReplyRow => ({
	parentId: ROOT.id,
	projectId: INPUT.projectId,
	topicId: INPUT.topicId,
	deletedAt: null,
	authorType: "USER",
	status: "RESOLVED",
	content: "Yes, name them.",
	createdAt: minute(0),
	...over,
});

const DECOYS: ReplyRow[] = [
	replyRow({
		id: "decoy-root",
		parentId: "root-2",
		content: "Another question's answer.",
		createdAt: minute(59),
	}),
	replyRow({
		id: "decoy-deleted",
		deletedAt: minute(58),
		content: "A deleted answer.",
		createdAt: minute(59),
	}),
	replyRow({
		id: "decoy-topic",
		topicId: "topic-2",
		content: "Another topic's answer.",
		createdAt: minute(59),
	}),
	replyRow({
		id: "decoy-project",
		projectId: "proj-2",
		content: "Another project's answer.",
		createdAt: minute(59),
	}),
];

const EARLIER_ANSWER = replyRow({ id: "answer-1", createdAt: minute(1) });

const NEWEST_FIRST = [{ createdAt: "desc" }, { id: "desc" }];

function strictReplyRead(
	pool: ReplyRow[],
	args: Record<string, unknown>,
): ReplyRow | null {
	for (const key of Object.keys(args)) {
		if (key !== "where" && key !== "orderBy" && key !== "select") {
			throw new Error(`fake findFirst: unhandled argument "${key}"`);
		}
	}
	if (JSON.stringify(args.orderBy) !== JSON.stringify(NEWEST_FIRST)) {
		throw new Error(
			`fake findFirst: unhandled orderBy ${JSON.stringify(args.orderBy)}`,
		);
	}
	const where = args.where as Record<string, unknown>;
	const matches = pool.filter((row) =>
		Object.entries(where).every(([key, value]) => {
			if (value === undefined) {
				return true;
			}
			if (!(key in row)) {
				throw new Error(`fake findFirst: unhandled where key "${key}"`);
			}
			const actual = row[key as keyof ReplyRow];
			if (
				value !== null &&
				typeof value === "object" &&
				!(value instanceof Date)
			) {
				const operator = value as Record<string, unknown>;
				if (
					Object.keys(operator).length === 1 &&
					"not" in operator &&
					operator.not === null
				) {
					return actual !== null;
				}
				throw new Error(
					`fake findFirst: unhandled operator on "${key}": ${JSON.stringify(value)}`,
				);
			}
			return actual === value;
		}),
	);
	matches.sort(
		(a, b) =>
			b.createdAt.getTime() - a.createdAt.getTime() ||
			(a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
	);
	return matches[0] ?? null;
}

/** Serve root reads from `ROOT` and reply reads from the strict fake; returns every row the fake handed back. */
function serveThread(pool: ReplyRow[]): (ReplyRow | null)[] {
	const returned: (ReplyRow | null)[] = [];
	findFirst.mockImplementation(
		async (args: { where: { parentId?: string | null } }) => {
			if (args.where.parentId === null) {
				return ROOT;
			}
			const row = strictReplyRead(
				pool,
				args as unknown as Record<string, unknown>,
			);
			returned.push(row);
			return row;
		},
	);
	return returned;
}

const PARITY_FIXTURES: { name: string; replies: ReplyRow[] }[] = [
	{
		name: "an answer, then a later note",
		replies: [
			EARLIER_ANSWER,
			replyRow({
				id: "note-1",
				status: "OPEN",
				content: "Can legal confirm this?",
				createdAt: minute(2),
			}),
		],
	},
	{
		name: "an answer, then a later AI reply marked RESOLVED",
		replies: [
			EARLIER_ANSWER,
			replyRow({
				id: "agent-1",
				authorType: "AGENT",
				content: "Analysis note.",
				createdAt: minute(2),
			}),
		],
	},
	{
		name: "an answer, then a later blank answer",
		replies: [
			EARLIER_ANSWER,
			replyRow({ id: "blank-1", content: "   ", createdAt: minute(2) }),
		],
	},
	{
		name: "an answer, then a later answer with no content",
		replies: [
			EARLIER_ANSWER,
			replyRow({ id: "null-1", content: null, createdAt: minute(2) }),
		],
	},
	{
		name: "two answers sharing a createdAt",
		replies: [
			replyRow({ id: "answer-b", createdAt: minute(1) }),
			replyRow({ id: "answer-a", content: "No.", createdAt: minute(1) }),
		],
	},
	{
		name: "a note only",
		replies: [
			replyRow({
				id: "note-only",
				status: "OPEN",
				content: "Can legal confirm this?",
				createdAt: minute(2),
			}),
		],
	},
];

describe("amendTopicQuestionAnswer — its live answer is the page's current answer", () => {
	it.each(PARITY_FIXTURES)(
		"reads the reply currentAnswerReply picks: $name",
		async ({ replies }) => {
			const returned = serveThread([...replies, ...DECOYS]);

			await amendTopicQuestionAnswer({
				...INPUT,
				supersedesId: "not-a-reply",
			});

			expect(returned).toHaveLength(1);
			// Fed only the thread's own replies — what `listTopicDecisions`
			// returns for it — never the decoys.
			expect(returned[0]?.id ?? null).toBe(
				currentAnswerReply(replies)?.id ?? null,
			);
		},
	);
});

describe("amendTopicQuestionAnswer — a current answer saved empty can be amended", () => {
	it.each([
		{
			name: "blank",
			current: replyRow({
				id: "blank-1",
				content: "   ",
				createdAt: minute(2),
			}),
		},
		{
			name: "with no content",
			current: replyRow({
				id: "null-1",
				content: null,
				createdAt: minute(2),
			}),
		},
	])(
		"amends a $name current answer named by its own id",
		async ({ current }) => {
			serveThread([EARLIER_ANSWER, current, ...DECOYS]);

			const result = await amendTopicQuestionAnswer({
				...INPUT,
				supersedesId: current.id,
			});

			expect(result.status).toBe("amended");
			expect(create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						parentId: ROOT.id,
						status: "RESOLVED",
						authorType: "USER",
						content: INPUT.answer,
					}),
				}),
			);
		},
	);

	it("refuses the older answer's id on such a thread as stale", async () => {
		serveThread([
			EARLIER_ANSWER,
			replyRow({ id: "blank-1", content: "   ", createdAt: minute(2) }),
			...DECOYS,
		]);

		const result = await amendTopicQuestionAnswer({
			...INPUT,
			supersedesId: EARLIER_ANSWER.id,
		});

		expect(result.status).toBe("stale");
		expect(create).not.toHaveBeenCalled();
	});
});
