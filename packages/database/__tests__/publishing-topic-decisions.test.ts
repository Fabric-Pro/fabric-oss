import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Question reconciliation on a READY analysis (Publishing Suite Phase 2A-3,
 * Fizzy #1851).
 *
 * Unit-level with a mocked `db`, matching `publishing-planning-analysis.test.ts`:
 * this exercises the transaction's SHAPE — what is read, what is written, and
 * under which branch — not real Postgres semantics (the partial unique index
 * and the two CHECK constraints live in the migration, not here). It therefore
 * runs in the regular no-Postgres suite.
 *
 * The four-way branch under test (OPEN refresh / RESOLVED no-op /
 * POSSIBLY_RESOLVED reactivate / soft-close) is not what the design spec says —
 * the spec describes three branches. The plan corrects it to four because the
 * `POSSIBLY_RESOLVED` value in `enum DecisionStatus` documents itself as
 * "auto-reactivated to OPEN if it reappears in a later refresh": a
 * three-way branch that treats it as settled, the way RESOLVED is treated,
 * would leave that question permanently unanswerable once the partial unique
 * index refuses a second root for the same `(topicId, questionId)`.
 */

const {
	queryRaw,
	analysisFindFirst,
	analysisUpdateMany,
	findManyRoots,
	findRoot,
	findEntry,
	claimRoot,
	createEntry,
	updateEntry,
	dbFindManyRoots,
	dbCreateEntry,
	dbUpdateEntry,
	transaction,
} = vi.hoisted(() => ({
	queryRaw: vi.fn(),
	analysisFindFirst: vi.fn(),
	analysisUpdateMany: vi.fn(),
	findManyRoots: vi.fn(),
	// answerTopicQuestion's own lookups: `findFirst` locates the live QUESTION
	// root by questionId, `findUnique` re-reads the full row on the dedupe path
	// and after a successful claim (the first lookup is narrowly `select`-ed
	// and can't stand in for either). `updateMany` is the claim-before-write:
	// its `count` tells a winner from a loser of a concurrent answer race.
	findRoot: vi.fn(),
	findEntry: vi.fn(),
	claimRoot: vi.fn(),
	createEntry: vi.fn(),
	updateEntry: vi.fn(),
	// A DISTINCT set of fns behind the top-level `db` mock's
	// `publishingTopicDecisionEntry`, deliberately NOT shared with `tx`'s below.
	// If `completePlanningAnalysis` ever reconciled on `db` instead of on the
	// `tx` its own CAS runs on — i.e. outside the transaction that flips the
	// analysis row READY — these are the fns that call would land on, and the
	// "reconciles inside the same transaction" test can then tell the two
	// apart. Sharing one set of fns between `tx` and `db`, as this file
	// originally did, makes that test pass regardless of which handle the code
	// actually used.
	dbFindManyRoots: vi.fn(),
	dbCreateEntry: vi.fn(),
	dbUpdateEntry: vi.fn(),
	transaction: vi.fn(),
}));

const tx = {
	$queryRaw: queryRaw,
	publishingTopicPlanningAnalysis: {
		findFirst: analysisFindFirst,
		updateMany: analysisUpdateMany,
	},
	publishingTopicDecisionEntry: {
		findMany: findManyRoots,
		findFirst: findRoot,
		findUnique: findEntry,
		updateMany: claimRoot,
		create: createEntry,
		update: updateEntry,
	},
};

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: transaction,
		$queryRaw: queryRaw,
		publishingTopicPlanningAnalysis: {
			findFirst: analysisFindFirst,
			updateMany: analysisUpdateMany,
		},
		publishingTopicDecisionEntry: {
			findMany: dbFindManyRoots,
			create: dbCreateEntry,
			update: dbUpdateEntry,
		},
	},
	Prisma: {},
}));

import {
	completePlanningAnalysis,
	failPlanningAnalysis,
} from "../prisma/queries/projects/publishing-planning";
import {
	answerTopicQuestion,
	reconcileTopicQuestions,
} from "../prisma/queries/projects/publishing-decisions";

const ORG_PROJECT = {
	organizationId: "org-1",
	userId: "owner-1",
	status: "ACTIVE",
	deletedAt: null,
};

const QUESTION_A = {
	questionId: "q-customer-name",
	decisionKind: "CUSTOMER_NAME",
	subject: "the named customer",
	question: "May we name the customer?",
	recommendedResponse: "Ask their marketing contact first.",
	whyItMatters: "A case study without the name is a different piece.",
};
const BASE = {
	topicId: "topic-1",
	projectId: "proj-1",
	organizationId: "org-1" as string | null,
	userId: null as string | null,
	analysisVersion: 2,
};
const COMPLETE_INPUT = {
	id: "pa-1",
	projectId: "proj-1",
	content: {},
	sourceRefs: {},
	model: "test-model",
	promptSource: "BOUND" as const,
};
const ANSWER_INPUT = {
	topicId: "topic-1",
	projectId: "proj-1",
	questionId: "q-customer-name",
	answer: "Yes, marketing cleared it.",
	answerSource: "AI_EDITED" as const,
	authorUserId: "user-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) =>
		fn(tx),
	);
	queryRaw.mockResolvedValue([ORG_PROJECT]);
	analysisFindFirst.mockResolvedValue({
		organizationId: "org-1",
		userId: null,
		topicId: "topic-1",
		version: 2,
	});
	analysisUpdateMany.mockResolvedValue({ count: 1 });
	findManyRoots.mockResolvedValue([]);
	findRoot.mockResolvedValue(null);
	findEntry.mockResolvedValue({});
	claimRoot.mockResolvedValue({ count: 1 });
	createEntry.mockResolvedValue({});
	updateEntry.mockResolvedValue({});
	dbFindManyRoots.mockResolvedValue([]);
	dbCreateEntry.mockResolvedValue({});
	dbUpdateEntry.mockResolvedValue({});
});

describe("reconcileTopicQuestions", () => {
	it("mints an OPEN root for a question the topic has never seen", async () => {
		findManyRoots.mockResolvedValue([]);

		const outcome = await reconcileTopicQuestions(tx, {
			topicId: "topic-1",
			projectId: "proj-1",
			organizationId: "org-1",
			userId: null,
			analysisVersion: 1,
			questions: [QUESTION_A],
		});

		expect(outcome).toEqual({
			minted: 1,
			refreshed: 0,
			softClosed: 0,
			reactivated: 0,
		});
		expect(createEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					topicId: "topic-1",
					projectId: "proj-1",
					organizationId: "org-1",
					// XOR: an org topic's children carry a NULL userId. Copying
					// `DecisionLogEntry`'s required-userId convention here would
					// violate the table's own CHECK.
					userId: null,
					kind: "QUESTION",
					status: "OPEN",
					authorType: "AGENT",
					questionId: QUESTION_A.questionId,
					// Provenance the question is written with — pinned so a write
					// that silently dropped one of these would fail here rather than
					// only in production. `analysisVersion` in particular is what
					// lets an answered question keep its grouping after a later
					// analysis version supersedes the one that raised it.
					decisionKind: QUESTION_A.decisionKind,
					subject: QUESTION_A.subject,
					summary: QUESTION_A.question,
					recommendedResponse: QUESTION_A.recommendedResponse,
					whyItMatters: QUESTION_A.whyItMatters,
					analysisVersion: 1,
				}),
			}),
		);
	});

	it("refreshes an OPEN root in place rather than minting a second one", async () => {
		// The whole point of the derived questionId: a regeneration that rephrases
		// the same decision must land on the SAME row, or the user is asked twice.
		findManyRoots.mockResolvedValue([
			{ id: "root-1", questionId: QUESTION_A.questionId, status: "OPEN" },
		]);

		const outcome = await reconcileTopicQuestions(tx, {
			...BASE,
			questions: [
				{ ...QUESTION_A, question: "Reworded, same decision?" },
			],
		});

		expect(outcome).toEqual({
			minted: 0,
			refreshed: 1,
			softClosed: 0,
			reactivated: 0,
		});
		// No second QUESTION root — the whole point of this test. `createEntry`
		// is called exactly once, for the FR47 AI Update the refresh also
		// produces (BASE.analysisVersion is 2, so this counts as a changed
		// regeneration); see the "AI Updates" describe block below.
		expect(createEntry).toHaveBeenCalledTimes(1);
		expect(createEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ kind: "AI_UPDATE" }),
			}),
		);
		// A conditional `updateMany`, not the plain `update` — scoped by
		// projectId/topicId (spec §4.7) AND gated on `status: "OPEN"`, the
		// status this test's `findManyRoots` observed. The gate is what stops a
		// concurrent `answerTopicQuestion` claim from being stomped (Codex
		// finding); see the lost-race test below for the other side of it.
		expect(claimRoot).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "root-1",
					projectId: BASE.projectId,
					topicId: BASE.topicId,
					status: "OPEN",
				},
				data: expect.objectContaining({
					summary: "Reworded, same decision?",
					// Pinned alongside summary: a refresh writes the whole question,
					// not just its wording, and `analysisVersion` is the column that
					// keeps an answered question's grouping stable across a later
					// regeneration.
					decisionKind: QUESTION_A.decisionKind,
					subject: QUESTION_A.subject,
					recommendedResponse: QUESTION_A.recommendedResponse,
					whyItMatters: QUESTION_A.whyItMatters,
					analysisVersion: BASE.analysisVersion,
				}),
			}),
		);
	});

	it("loses a concurrent answer race on refresh — the write does not land, and it is not counted", async () => {
		// Codex adversarial review: the reconciler's refresh write used to be
		// unconditional on `{ id }` alone. A concurrent `answerTopicQuestion`
		// claiming this same root RESOLVED between the read above and this write
		// would otherwise be stomped — reopening a just-answered question. The
		// conditional `updateMany` mirrors `answerTopicQuestion`'s own
		// claim-before-write: a lost race (`count: 0`) must leave the root
		// untouched and must NOT be counted as a refresh.
		findManyRoots.mockResolvedValue([
			{ id: "root-1", questionId: QUESTION_A.questionId, status: "OPEN" },
		]);
		claimRoot.mockResolvedValue({ count: 0 });

		const outcome = await reconcileTopicQuestions(tx, {
			...BASE,
			questions: [
				{ ...QUESTION_A, question: "Reworded, same decision?" },
			],
		});

		expect(outcome).toEqual({
			minted: 0,
			refreshed: 0,
			softClosed: 0,
			reactivated: 0,
		});
		// The attempt happens exactly once — no retry, no fallback to an
		// unconditional write.
		expect(claimRoot).toHaveBeenCalledTimes(1);
		// Nothing changed, so no AI Update is written either — a note claiming
		// "1 updated" for a write that never landed would be a lie.
		expect(createEntry).not.toHaveBeenCalled();
	});

	it("leaves a RESOLVED root completely alone", async () => {
		// Idempotence, and more: re-opening a decision the user already made would
		// silently discard their answer from the open list.
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: QUESTION_A.questionId,
				status: "RESOLVED",
			},
		]);

		const outcome = await reconcileTopicQuestions(tx, {
			...BASE,
			questions: [QUESTION_A],
		});

		expect(outcome).toEqual({
			minted: 0,
			refreshed: 0,
			softClosed: 0,
			reactivated: 0,
		});
		expect(claimRoot).not.toHaveBeenCalled();
		expect(createEntry).not.toHaveBeenCalled();
	});

	it("reactivates a POSSIBLY_RESOLVED root when the question comes back", async () => {
		// The `POSSIBLY_RESOLVED` value in `enum DecisionStatus`'s own contract: a
		// soft-closed question is "auto-reactivated to OPEN if it reappears in a
		// later refresh". Treating POSSIBLY_RESOLVED as settled — the way a RESOLVED root
		// is treated — would leave a decision the analysis is asking for AGAIN
		// invisible on the questions tab, and the unique index means no second root
		// can ever be minted for it. Permanently unanswerable, silently.
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: QUESTION_A.questionId,
				status: "POSSIBLY_RESOLVED",
			},
		]);

		const outcome = await reconcileTopicQuestions(tx, {
			...BASE,
			questions: [QUESTION_A],
		});

		expect(outcome).toEqual({
			minted: 0,
			refreshed: 0,
			softClosed: 0,
			reactivated: 1,
		});
		// No second QUESTION root is minted for the reactivated one — pinned the
		// same way as the plain-refresh test. `createEntry` is called exactly
		// once, for the FR47 AI Update this changed regeneration also produces;
		// see the "AI Updates" describe block below.
		expect(createEntry).toHaveBeenCalledTimes(1);
		expect(createEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ kind: "AI_UPDATE" }),
			}),
		);
		// Conditional on `status: "POSSIBLY_RESOLVED"` — the status this test's
		// `findManyRoots` observed — same reasoning as the refresh path above.
		expect(claimRoot).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "root-1",
					projectId: BASE.projectId,
					topicId: BASE.topicId,
					status: "POSSIBLY_RESOLVED",
				},
				data: expect.objectContaining({
					status: "OPEN",
					// Same shared write as the plain-refresh path — pinned here too,
					// since reactivation must also refresh the question's content,
					// not just flip its status.
					decisionKind: QUESTION_A.decisionKind,
					subject: QUESTION_A.subject,
					summary: QUESTION_A.question,
					recommendedResponse: QUESTION_A.recommendedResponse,
					whyItMatters: QUESTION_A.whyItMatters,
					analysisVersion: BASE.analysisVersion,
				}),
			}),
		);
	});

	it("loses a concurrent answer race on reactivation — stays POSSIBLY_RESOLVED, no false reactivation", async () => {
		// The mirror of the refresh lost-race test, for the branch that matters
		// most: without the fix, this path would flip a just-RESOLVED root back
		// to OPEN, undoing the answer that just landed on it and offering
		// answer controls for a question someone already answered.
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: QUESTION_A.questionId,
				status: "POSSIBLY_RESOLVED",
			},
		]);
		claimRoot.mockResolvedValue({ count: 0 });

		const outcome = await reconcileTopicQuestions(tx, {
			...BASE,
			questions: [QUESTION_A],
		});

		expect(outcome).toEqual({
			minted: 0,
			refreshed: 0,
			softClosed: 0,
			reactivated: 0,
		});
		expect(claimRoot).toHaveBeenCalledTimes(1);
		// No AI Update claiming a reactivation that never happened.
		expect(createEntry).not.toHaveBeenCalled();
	});

	it("soft-closes an OPEN root the new analysis no longer raises", async () => {
		// POSSIBLY_RESOLVED, never deleted: the analysis dropping a question is
		// weak evidence, and a user who answered around it needs the row back.
		//
		// A single scoped `updateMany`, not the singular `update` — and scoped by
		// projectId/topicId as well as id (spec §4.7), not just `{ id }`.
		findManyRoots.mockResolvedValue([
			{ id: "root-gone", questionId: "stale-id", status: "OPEN" },
		]);

		const outcome = await reconcileTopicQuestions(tx, {
			...BASE,
			questions: [],
		});

		expect(outcome).toEqual({
			minted: 0,
			refreshed: 0,
			softClosed: 1,
			reactivated: 0,
		});
		expect(claimRoot).toHaveBeenCalledWith({
			where: {
				id: { in: ["root-gone"] },
				projectId: BASE.projectId,
				topicId: BASE.topicId,
				status: "OPEN",
			},
			data: { status: "POSSIBLY_RESOLVED" },
		});
		expect(updateEntry).not.toHaveBeenCalled();
	});

	it("soft-closes multiple stale roots in ONE batched call, not N", async () => {
		// The whole point of moving off the per-row loop: a topic that drops
		// several questions in one regeneration must not cost several
		// round-trips inside a transaction holding a row lock.
		findManyRoots.mockResolvedValue([
			{ id: "root-a", questionId: "stale-a", status: "OPEN" },
			{ id: "root-b", questionId: "stale-b", status: "OPEN" },
		]);
		claimRoot.mockResolvedValue({ count: 2 });

		const outcome = await reconcileTopicQuestions(tx, {
			...BASE,
			questions: [],
		});

		expect(outcome.softClosed).toBe(2);
		expect(claimRoot).toHaveBeenCalledTimes(1);
		expect(claimRoot).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: { in: ["root-a", "root-b"] },
				}),
			}),
		);
	});

	it("does not soft-close a RESOLVED root that the new analysis dropped", async () => {
		findManyRoots.mockResolvedValue([
			{ id: "root-1", questionId: "stale-id", status: "RESOLVED" },
		]);

		const outcome = await reconcileTopicQuestions(tx, {
			...BASE,
			questions: [],
		});

		expect(outcome.softClosed).toBe(0);
		expect(updateEntry).not.toHaveBeenCalled();
		expect(claimRoot).not.toHaveBeenCalled();
	});
});

describe("completePlanningAnalysis — question reconciliation", () => {
	it("reconciles inside the same transaction that flips the row READY", async () => {
		const result = await completePlanningAnalysis({
			id: "pa-1",
			projectId: "proj-1",
			content: {},
			sourceRefs: {},
			model: "test-model",
			promptSource: "BOUND",
			questions: [QUESTION_A],
		});

		expect(result.persisted).toBe(true);
		expect(result.reconciled).toEqual({
			minted: 1,
			refreshed: 0,
			softClosed: 0,
			reactivated: 0,
		});
		// The tx handle the reconciler used must be the SAME one the CAS used —
		// a reconcile on `db` outside the transaction would commit questions for
		// an analysis whose READY flip then rolled back. `tx` and `db` are wired
		// to DISTINCT fns (see the harness above), so this actually tells the
		// two apart rather than just checking a call happened.
		//
		// Two calls, not one: the mint above, plus the FR47 AI Update this
		// changed regeneration also produces (the mocked analysis is version 2,
		// so `analysisVersion > 1` holds) — see the "AI Updates" describe block
		// below. Both must land on `tx`.
		expect(createEntry).toHaveBeenCalledTimes(2);
		expect(dbCreateEntry).not.toHaveBeenCalled();
	});

	it("reconciles nothing when the CAS refuses", async () => {
		// A reclaimed attempt must not mint questions: its analysis is not the one
		// the topic will show.
		analysisUpdateMany.mockResolvedValue({ count: 0 });

		const result = await completePlanningAnalysis({
			...COMPLETE_INPUT,
			questions: [QUESTION_A],
		});

		expect(result.persisted).toBe(false);
		expect(result.reconciled).toBeNull();
		expect(createEntry).not.toHaveBeenCalled();
	});

	it("reconciles nothing when the tenant fence refuses", async () => {
		analysisFindFirst.mockResolvedValue({
			organizationId: "org-OTHER",
			userId: null,
		});

		const result = await completePlanningAnalysis({
			...COMPLETE_INPUT,
			questions: [QUESTION_A],
		});

		expect(result.persisted).toBe(false);
		expect(result.reconciled).toBeNull();
		expect(createEntry).not.toHaveBeenCalled();
	});
});

describe("failPlanningAnalysis — questions are untouched", () => {
	it("never soft-closes or mints anything on a failed attempt", async () => {
		// This is the server-side home of the concern the 2A-2 page test carried:
		// a failed regeneration must not empty the question list. Enforced here it
		// is a durable guarantee rather than a client-side read preference.
		await failPlanningAnalysis({
			id: "pa-2",
			projectId: "proj-1",
			error: "Rate limited.",
		});

		expect(createEntry).not.toHaveBeenCalled();
		expect(updateEntry).not.toHaveBeenCalled();
	});
});

describe("reconcileTopicQuestions — AI Updates (FR47)", () => {
	it("records one AI Update describing what the regeneration changed", async () => {
		findManyRoots.mockResolvedValue([
			{ id: "root-1", questionId: "kept", status: "OPEN" },
			{ id: "root-2", questionId: "dropped", status: "OPEN" },
		]);

		await reconcileTopicQuestions(tx, {
			...BASE,
			analysisVersion: 2,
			questions: [
				{ ...QUESTION_A, questionId: "kept" },
				{ ...QUESTION_A, questionId: "new-one" },
			],
		});

		const update = createEntry.mock.calls
			.map((c) => c[0].data)
			.find((d) => d.kind === "AI_UPDATE");
		expect(update).toMatchObject({
			kind: "AI_UPDATE",
			authorType: "AGENT",
			status: "RESOLVED",
			analysisVersion: 2,
			// The version-change summary FR47 names, and the field
			// `TopicDecisionLog`'s `AiUpdateCard` now renders — asserted here
			// since nothing pinned it before.
			summary: "Planning analysis v2",
			// A note nobody has to act on is not an open item; leaving it OPEN
			// would inflate every open-question count in the product.
			topicId: BASE.topicId,
			projectId: BASE.projectId,
			// XOR, same as the QUESTION rows this reconciliation also writes: an
			// org topic's children carry a NULL userId, exactly one non-null.
			organizationId: BASE.organizationId,
			userId: BASE.userId,
			// The AGENT produced this note, not whoever clicked Generate — an
			// AI_UPDATE row must never carry a person's id here.
			authorUserId: null,
		});
		expect(update.content).toContain("1 new");
		expect(update.content).toContain("1 updated");
		expect(update.content).toContain("1 no longer raised");
	});

	it("writes no AI Update for the first analysis", async () => {
		// Version 1 has no delta to describe — everything is new, and saying so
		// duplicates the questions themselves.
		findManyRoots.mockResolvedValue([]);

		await reconcileTopicQuestions(tx, {
			...BASE,
			analysisVersion: 1,
			questions: [QUESTION_A],
		});

		const kinds = createEntry.mock.calls.map((c) => c[0].data.kind);
		expect(kinds).not.toContain("AI_UPDATE");
	});

	it("writes no AI Update when a regeneration changed nothing", async () => {
		// An identical re-run is common (a user regenerating to pick up new
		// context that turned out not to exist). A log full of "nothing changed"
		// is a log nobody reads.
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: QUESTION_A.questionId,
				status: "RESOLVED",
			},
		]);

		await reconcileTopicQuestions(tx, {
			...BASE,
			analysisVersion: 3,
			questions: [QUESTION_A],
		});

		const kinds = createEntry.mock.calls.map((c) => c[0].data.kind);
		expect(kinds).not.toContain("AI_UPDATE");
	});
});

describe("answerTopicQuestion", () => {
	it("appends the answer as a reply and flips the root resolved", async () => {
		// Non-destructive (FR11 + AC-2.6 precedent): the question text stays on the
		// root, so the Decision Log can show what was asked next to what was
		// decided. Overwriting the root would lose the question.
		findRoot.mockResolvedValue({
			id: "root-1",
			status: "OPEN",
			organizationId: "org-1",
			userId: null,
		});

		const result = await answerTopicQuestion({ ...ANSWER_INPUT });

		expect(result.status).toBe("resolved");
		expect(createEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					parentId: "root-1",
					kind: "QUESTION",
					status: "RESOLVED",
					authorType: "USER",
					authorUserId: "user-1",
					content: "Yes, marketing cleared it.",
					answerSource: "AI_EDITED",
					// Tenancy is INHERITED from the root, not from the answering
					// user — a reply carrying the author's own tenant would break the
					// table's XOR the moment a personal user answers in an org topic.
					organizationId: "org-1",
					userId: null,
				}),
			}),
		);
		// The root is flipped via a CONDITIONAL `updateMany` (the claim), not the
		// plain `update` — that is the whole point of the concurrency fix: a
		// second concurrent answer's claim must be able to match ZERO rows once
		// the first has landed. Re-scoped to {projectId, topicId} (DV16) as well
		// as id, and gated on the status still being OPEN/POSSIBLY_RESOLVED.
		expect(claimRoot).toHaveBeenCalledWith({
			where: {
				id: "root-1",
				projectId: "proj-1",
				topicId: "topic-1",
				status: { in: ["OPEN", "POSSIBLY_RESOLVED"] },
			},
			data: expect.objectContaining({ status: "RESOLVED" }),
		});
		expect(updateEntry).not.toHaveBeenCalled();
	});

	it("is idempotent on an already-resolved question", async () => {
		findRoot.mockResolvedValue({
			id: "root-1",
			status: "RESOLVED",
			organizationId: "org-1",
			userId: null,
		});

		const result = await answerTopicQuestion({ ...ANSWER_INPUT });

		expect(result.status).toBe("deduped");
		expect(createEntry).not.toHaveBeenCalled();
		expect(updateEntry).not.toHaveBeenCalled();
		// This is the settled-status branch, not the race-loss branch below — the
		// claim must never even be attempted for an already-RESOLVED root.
		expect(claimRoot).not.toHaveBeenCalled();
	});

	it("loses a concurrent answer race and dedupes without minting a second reply", async () => {
		// Both callers read the SAME OPEN root — this simulates the second one's
		// `updateMany` running after the first already flipped it to RESOLVED, so
		// the conditional claim matches zero rows. Without the claim-before-write
		// fix, this caller would also `create` a reply, leaving two for one
		// question on a double-click.
		findRoot.mockResolvedValue({
			id: "root-1",
			status: "OPEN",
			organizationId: "org-1",
			userId: null,
		});
		claimRoot.mockResolvedValue({ count: 0 });

		const result = await answerTopicQuestion({ ...ANSWER_INPUT });

		expect(result.status).toBe("deduped");
		expect(claimRoot).toHaveBeenCalled();
		expect(createEntry).not.toHaveBeenCalled();
	});

	it("reopens nothing and writes nothing for an unknown question", async () => {
		// A question id from another topic, or one soft-closed and pruned. Minting
		// a root here would create an answered question nobody asked.
		findRoot.mockResolvedValue(null);

		const result = await answerTopicQuestion({ ...ANSWER_INPUT });

		expect(result).toEqual({ status: "not_found", root: null });
		expect(createEntry).not.toHaveBeenCalled();
	});

	it("answers a POSSIBLY_RESOLVED root, restoring it", async () => {
		// Soft-closed by reconciliation but still on screen behind the "show
		// possibly resolved" affordance. Answering it is a real decision.
		findRoot.mockResolvedValue({
			id: "root-1",
			status: "POSSIBLY_RESOLVED",
			organizationId: null,
			userId: "user-9",
		});

		const result = await answerTopicQuestion({ ...ANSWER_INPUT });

		expect(result.status).toBe("resolved");
		// This root is PERSONAL (organizationId null, userId set), the mirror
		// image of the org-owned root the first test pins. Both halves of the
		// inherited-tenancy pair need their own case — a root's `organizationId`
		// and `userId` are exactly one non-null, and dropping either write here
		// (`userId: null` on a personal root) would violate the table's
		// `publishing_topic_decision_entry_tenant_xor` CHECK at runtime without
		// this table having covered it.
		expect(createEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					organizationId: null,
					userId: "user-9",
				}),
			}),
		);
	});

	it("treats a status this feature never writes as settled, not answerable", async () => {
		// The deny-list shape shared with `reconcileTopicQuestions`: only OPEN and
		// POSSIBLY_RESOLVED are awaiting a person. A status nothing in this
		// feature writes today (REJECTED, FORMATTING_ONLY) must default to
		// settled — the safe direction if the enum ever grows — not fall through
		// to being silently re-answered.
		findRoot.mockResolvedValue({
			id: "root-1",
			status: "REJECTED",
			organizationId: "org-1",
			userId: null,
		});

		const result = await answerTopicQuestion({ ...ANSWER_INPUT });

		expect(result.status).toBe("deduped");
		expect(createEntry).not.toHaveBeenCalled();
		expect(updateEntry).not.toHaveBeenCalled();
	});

	it("re-scopes the root lookup to the project, never the topic id alone", async () => {
		findRoot.mockResolvedValue({
			id: "root-1",
			status: "OPEN",
			organizationId: "org-1",
			userId: null,
		});

		await answerTopicQuestion({ ...ANSWER_INPUT });

		expect(findRoot).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					topicId: ANSWER_INPUT.topicId,
					projectId: ANSWER_INPUT.projectId,
					questionId: ANSWER_INPUT.questionId,
					parentId: null,
					kind: "QUESTION",
					deletedAt: null,
				}),
			}),
		);
	});
});
