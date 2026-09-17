import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The refinement-proposal writers (Fizzy #1851 follow-up).
 *
 * Unit-level with a mocked `db`, matching `publishing-draft-writers.test.ts`:
 * this exercises the SHAPE of each transaction — what it locks, what it scopes
 * by, what it refuses, and which columns it is careful NOT to move — not real
 * Postgres semantics.
 *
 * The two properties here that a reviewer cannot get from reading the types:
 *
 *  1. `updatedAt` is PINNED by every proposal write. It is the BODY's
 *     concurrency token, and Prisma's `@updatedAt` moves it on any update to the
 *     row — so a proposal write that forgot to pin it would tell every open
 *     editor their draft had changed underneath them, twice per refine, for a
 *     change to a column they are not editing. Nothing in the type system says
 *     so; only this does.
 *  2. Accept distinguishes `baseline_changed` from `stale`. Two branches, two
 *     different client messages, and a refactor that collapsed them would pass
 *     type-check while silently destroying the edit that moved the body.
 */

const h = vi.hoisted(() => ({
	queryRaw: vi.fn(),
	topicFindFirst: vi.fn(),
	draftFindFirst: vi.fn(),
	workingFindFirst: vi.fn(),
	workingUpdateMany: vi.fn(),
	workingFindUniqueOrThrow: vi.fn(),
	revisionAggregate: vi.fn(),
	revisionCreate: vi.fn(),
	revisionFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => {
	const tx = {
		$queryRaw: h.queryRaw,
		publishingTopic: { findFirst: h.topicFindFirst },
		publishingTopicDraft: { findFirst: h.draftFindFirst },
		publishingTopicWorkingDraft: {
			findFirst: h.workingFindFirst,
			updateMany: h.workingUpdateMany,
			findUniqueOrThrow: h.workingFindUniqueOrThrow,
		},
		publishingTopicDraftRevision: {
			aggregate: h.revisionAggregate,
			create: h.revisionCreate,
			findFirst: h.revisionFindFirst,
		},
	};
	return {
		db: {
			$transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
			...tx,
		},
		Prisma: {},
	};
});

import {
	acceptRefinement,
	completeRefinement,
	failRefinement,
	rejectRefinement,
	startRefinement,
} from "../prisma/queries/projects/publishing-drafts";

const ORG_PROJECT = [
	{
		organizationId: "org-1",
		userId: null,
		status: "ACTIVE",
		deletedAt: null,
	},
];

const SCOPE = {
	topicId: "topic-1",
	projectId: "project-1",
	postType: "TWEET" as const,
};

/** The row's `updatedAt` as every caller below last saw it. */
const SEEN = new Date("2026-09-17T10:00:00Z");

beforeEach(() => {
	vi.clearAllMocks();
	h.queryRaw.mockResolvedValue(ORG_PROJECT);
	h.topicFindFirst.mockResolvedValue({ id: "topic-1" });
	h.workingUpdateMany.mockResolvedValue({ count: 1 });
	h.workingFindUniqueOrThrow.mockResolvedValue({ updatedAt: SEEN });
	h.revisionAggregate.mockResolvedValue({ _max: { version: 3 } });
	h.revisionCreate.mockResolvedValue({});
	// A revision already exists, so the one-shot "capture the body that predates
	// the history table" backstop does not fire and each case below sees exactly
	// the revision its own write appended.
	h.revisionFindFirst.mockResolvedValue({ id: "rev-1" });
	h.draftFindFirst.mockResolvedValue({ version: 7 });
});

/** The `data` of the one proposal write a case issued. */
function writtenData() {
	return h.workingUpdateMany.mock.calls[0]?.[0]?.data as Record<
		string,
		unknown
	>;
}

describe("startRefinement", () => {
	beforeEach(() => {
		h.workingFindFirst.mockResolvedValue({
			id: "wd-1",
			body: "A saved draft.",
			updatedAt: SEEN,
			refinementStatus: null,
			refinementExpiresAt: null,
		});
	});

	it("claims the slot and returns the baseline it stored", async () => {
		const result = await startRefinement({
			...SCOPE,
			instruction: "Remove the last line.",
			requestedById: "user-1",
		});

		expect(result).toMatchObject({
			status: "started",
			baseline: "A saved draft.",
		});
		// The baseline returned and the baseline stored are the SAME string —
		// the whole reason the caller does not re-read the body. The path this
		// replaced read it in one query and opened the attempt in another, so an
		// edit between them produced a run that revised one version while
		// recording another.
		expect(writtenData().refinedFromBody).toBe("A saved draft.");
		expect(writtenData().refinementStatus).toBe("GENERATING");
	});

	it("PINS updatedAt, so an open editor's token stays valid", async () => {
		await startRefinement({
			...SCOPE,
			instruction: "Tighten it.",
			requestedById: "user-1",
		});
		expect(writtenData().updatedAt).toEqual(SEEN);
	});

	it("compare-and-sets on updatedAt rather than comparing in JS", async () => {
		await startRefinement({
			...SCOPE,
			instruction: null,
			requestedById: "user-1",
		});
		expect(h.workingUpdateMany.mock.calls[0]?.[0]?.where).toEqual({
			id: "wd-1",
			updatedAt: SEEN,
		});
	});

	it("refuses while a live run holds the slot", async () => {
		h.workingFindFirst.mockResolvedValue({
			id: "wd-1",
			body: "A saved draft.",
			updatedAt: SEEN,
			refinementStatus: "GENERATING",
			refinementExpiresAt: new Date(Date.now() + 60_000),
		});
		const result = await startRefinement({
			...SCOPE,
			instruction: "Again.",
			requestedById: "user-1",
		});
		expect(result.status).toBe("in_flight");
		expect(h.workingUpdateMany).not.toHaveBeenCalled();
	});

	it("reclaims a run whose deadline passed", async () => {
		h.workingFindFirst.mockResolvedValue({
			id: "wd-1",
			body: "A saved draft.",
			updatedAt: SEEN,
			refinementStatus: "GENERATING",
			refinementExpiresAt: new Date(Date.now() - 60_000),
		});
		const result = await startRefinement({
			...SCOPE,
			instruction: "Again.",
			requestedById: "user-1",
		});
		expect(result.status).toBe("started");
	});

	it("reclaims a GENERATING run carrying NO deadline — the rule is fail-open", async () => {
		// This is why the table needs no `status <> 'GENERATING' OR expiresAt IS
		// NOT NULL` CHECK where its sibling does. There, exclusion is a partial
		// unique index in the database and a null deadline is a permanent lock.
		// Here the rule is in this function, and it reads a null deadline as
		// "nothing proves this run is alive".
		h.workingFindFirst.mockResolvedValue({
			id: "wd-1",
			body: "A saved draft.",
			updatedAt: SEEN,
			refinementStatus: "GENERATING",
			refinementExpiresAt: null,
		});
		const result = await startRefinement({
			...SCOPE,
			instruction: "Again.",
			requestedById: "user-1",
		});
		expect(result.status).toBe("started");
	});

	it("has nothing to refine when the body is whitespace", async () => {
		h.workingFindFirst.mockResolvedValue({
			id: "wd-1",
			body: "   \n ",
			updatedAt: SEEN,
			refinementStatus: null,
			refinementExpiresAt: null,
		});
		const result = await startRefinement({
			...SCOPE,
			instruction: "Tighten it.",
			requestedById: "user-1",
		});
		expect(result.status).toBe("not_found");
	});

	it("does not trust a topic id from another project", async () => {
		h.topicFindFirst.mockResolvedValue(null);
		const result = await startRefinement({
			...SCOPE,
			instruction: "Tighten it.",
			requestedById: "user-1",
		});
		expect(result.status).toBe("not_found");
		expect(h.workingUpdateMany).not.toHaveBeenCalled();
	});
});

describe("completeRefinement", () => {
	beforeEach(() => {
		h.workingFindFirst.mockResolvedValue({
			id: "wd-1",
			updatedAt: SEEN,
			organizationId: "org-1",
			userId: null,
		});
	});

	it("commits the proposal without moving the body's updatedAt", async () => {
		const result = await completeRefinement({
			...SCOPE,
			runId: "run-1",
			body: "A revised draft.",
			note: null,
		});
		expect(result.persisted).toBe(true);
		expect(writtenData().refinedBody).toBe("A revised draft.");
		// Nothing the reader is editing has changed — and will not until they
		// accept.
		expect(writtenData().updatedAt).toEqual(SEEN);
	});

	it("CASes on the RUN ID, not merely on status", async () => {
		// The hole `refinementRunId` exists for: once a stranded run's deadline
		// passes, the next start sets GENERATING again for a DIFFERENT run, and a
		// status-only predicate would let the first run commit into the second
		// run's slot.
		await completeRefinement({
			...SCOPE,
			runId: "run-1",
			body: "x",
			note: null,
		});
		expect(h.workingUpdateMany.mock.calls[0]?.[0]?.where).toMatchObject({
			refinementRunId: "run-1",
			refinementStatus: "GENERATING",
		});
	});

	it("reports a lost CAS as superseded rather than throwing", async () => {
		h.workingUpdateMany.mockResolvedValue({ count: 0 });
		const result = await completeRefinement({
			...SCOPE,
			runId: "stale-run",
			body: "x",
			note: null,
		});
		expect(result).toEqual({ persisted: false, reason: "superseded" });
	});

	it("fences a run whose project changed tenant mid-flight", async () => {
		h.workingFindFirst.mockResolvedValue({
			id: "wd-1",
			updatedAt: SEEN,
			organizationId: "org-OTHER",
			userId: null,
		});
		const result = await completeRefinement({
			...SCOPE,
			runId: "run-1",
			body: "x",
			note: null,
		});
		expect(result).toEqual({ persisted: false, reason: "tenant_changed" });
		expect(h.workingUpdateMany).not.toHaveBeenCalled();
	});

	it("carries the model's safety note onto the proposal", async () => {
		await completeRefinement({
			...SCOPE,
			runId: "run-1",
			body: "x",
			note: "Wrote around the customer name; it is not approved yet.",
		});
		expect(writtenData().refinementNote).toBe(
			"Wrote around the customer name; it is not approved yet.",
		);
	});
});

describe("failRefinement", () => {
	beforeEach(() => {
		h.workingFindFirst.mockResolvedValue({
			id: "wd-1",
			updatedAt: SEEN,
			organizationId: "org-1",
			userId: null,
		});
	});

	it("records the error, keeps the body's token, and CASes on the run", async () => {
		const result = await failRefinement({
			...SCOPE,
			runId: "run-1",
			error: "The model timed out.",
		});
		expect(result.persisted).toBe(true);
		expect(writtenData().refinementStatus).toBe("FAILED");
		expect(writtenData().refinementError).toBe("The model timed out.");
		expect(writtenData().updatedAt).toEqual(SEEN);
		expect(h.workingUpdateMany.mock.calls[0]?.[0]?.where).toMatchObject({
			refinementRunId: "run-1",
		});
	});
});

describe("acceptRefinement", () => {
	const READY = {
		id: "wd-1",
		body: "A saved draft.",
		updatedById: "user-9",
		sourceDraftId: "draft-7",
		refinementStatus: "READY",
		refinedBody: "A revised draft.",
		refinedFromBody: "A saved draft.",
		refinementInstruction: "Remove the last line.",
	};

	it("adopts the proposal and clears it in ONE write", async () => {
		h.workingFindFirst.mockResolvedValue(READY);
		const result = await acceptRefinement({
			...SCOPE,
			acceptedById: "user-1",
			expectedUpdatedAt: SEEN,
		});

		expect(result).toMatchObject({ status: "accepted", version: 4 });
		expect(writtenData().body).toBe("A revised draft.");
		// Cleared in the SAME statement that consumes it: there is no state in
		// which the body is accepted and the proposal is still offered.
		expect(writtenData().refinementStatus).toBeNull();
		expect(writtenData().refinedBody).toBeNull();
		expect(writtenData().refinementRunId).toBeNull();
	});

	it("appends a REFINED revision carrying the author's instruction", async () => {
		h.workingFindFirst.mockResolvedValue(READY);
		await acceptRefinement({
			...SCOPE,
			acceptedById: "user-1",
			expectedUpdatedAt: SEEN,
		});

		// Through the same revision machinery every other body writer uses —
		// writing `body` directly would reopen the gap the draft-revision slice
		// closed, leaving an accepted refinement unrecoverable.
		expect(h.revisionCreate).toHaveBeenCalledTimes(1);
		expect(h.revisionCreate.mock.calls[0]?.[0]?.data).toMatchObject({
			kind: "REFINED",
			body: "A revised draft.",
			version: 4,
			// The ASK, not a description of the result: a history that records
			// only what changed cannot answer why.
			changeSummary: "Remove the last line.",
			// The candidate the draft STARTED as. A refinement revises the
			// working copy; it does not re-seed it from a generation.
			sourceDraftVersion: 7,
		});
	});

	it("refuses with baseline_changed when the body moved under the proposal", async () => {
		// The distinction that matters: the caller's view is fine, the PROPOSAL
		// is behind. Refreshing changes nothing — the refinement has to be run
		// again — and accepting would discard whoever edited the body.
		h.workingFindFirst.mockResolvedValue({
			...READY,
			body: "Someone else edited this.",
		});
		const result = await acceptRefinement({
			...SCOPE,
			acceptedById: "user-1",
			expectedUpdatedAt: SEEN,
		});

		expect(result.status).toBe("baseline_changed");
		// Refused BEFORE the compare-and-set, so nothing is touched.
		expect(h.workingUpdateMany).not.toHaveBeenCalled();
	});

	it("refuses with stale when the CALLER's own token is behind", async () => {
		h.workingFindFirst.mockResolvedValue(READY);
		h.workingUpdateMany.mockResolvedValue({ count: 0 });
		const result = await acceptRefinement({
			...SCOPE,
			acceptedById: "user-1",
			expectedUpdatedAt: SEEN,
		});

		expect(result.status).toBe("stale");
		// A losing compare-and-set writes no history either.
		expect(h.revisionCreate).not.toHaveBeenCalled();
	});

	it("has nothing to accept while the run is still going", async () => {
		h.workingFindFirst.mockResolvedValue({
			...READY,
			refinementStatus: "GENERATING",
			refinedBody: null,
		});
		const result = await acceptRefinement({
			...SCOPE,
			acceptedById: "user-1",
			expectedUpdatedAt: SEEN,
		});
		expect(result.status).toBe("no_proposal");
	});
});

describe("rejectRefinement", () => {
	it("clears the proposal, leaves the body, and PINS updatedAt", async () => {
		h.workingFindFirst.mockResolvedValue({
			id: "wd-1",
			updatedAt: SEEN,
			refinementStatus: "FAILED",
		});
		const result = await rejectRefinement(SCOPE);

		expect(result).toEqual({ status: "rejected", updatedAt: SEEN });
		expect(writtenData().refinementStatus).toBeNull();
		expect(writtenData().body).toBeUndefined();
		// Rejecting changes nothing a reader is editing, so invalidating their
		// token would make a dismissed error look like someone else's save.
		expect(writtenData().updatedAt).toEqual(SEEN);
	});

	it("dismissing nothing is not an error", async () => {
		h.workingFindFirst.mockResolvedValue({
			id: "wd-1",
			updatedAt: SEEN,
			refinementStatus: null,
		});
		const result = await rejectRefinement(SCOPE);
		expect(result.status).toBe("no_proposal");
		expect(h.workingUpdateMany).not.toHaveBeenCalled();
	});
});
