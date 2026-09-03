import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Short Post draft writers (Fizzy #1853, Phase 2B-2).
 *
 * Unit-level with a mocked `db`, matching `publishing-planning-analysis.test.ts`:
 * this exercises the SHAPE of each transaction — what it locks, what it scopes
 * by, what it refuses — not real Postgres semantics. The constraints themselves,
 * the cascades and the RLS policy are proved against a real server in
 * `publishing-suite-constraints.test.ts` and `rls-isolation.test.ts`, and the
 * `P2002` discrimination is proved there too, because only a real server can
 * produce the error this code reads.
 */

const h = vi.hoisted(() => ({
	queryRaw: vi.fn(),
	topicFindFirst: vi.fn(),
	draftFindFirst: vi.fn(),
	draftCreate: vi.fn(),
	draftUpdateMany: vi.fn(),
	draftAggregate: vi.fn(),
	workingUpsert: vi.fn(),
	workingFindUnique: vi.fn(),
	workingFindFirst: vi.fn(),
	workingCreate: vi.fn(),
	workingUpdate: vi.fn(),
	workingUpdateMany: vi.fn(),
	workingFindUniqueOrThrow: vi.fn(),
}));

vi.mock("../prisma/client", () => {
	const tx = {
		$queryRaw: h.queryRaw,
		publishingTopic: { findFirst: h.topicFindFirst },
		publishingTopicDraft: {
			findFirst: h.draftFindFirst,
			create: h.draftCreate,
			updateMany: h.draftUpdateMany,
			aggregate: h.draftAggregate,
		},
		publishingTopicWorkingDraft: {
			findUnique: h.workingFindUnique,
			findFirst: h.workingFindFirst,
			upsert: h.workingUpsert,
			create: h.workingCreate,
			update: h.workingUpdate,
			updateMany: h.workingUpdateMany,
			findUniqueOrThrow: h.workingFindUniqueOrThrow,
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
	completeTopicDraft,
	failTopicDraft,
	saveWorkingDraft,
	seedWorkingDraftIfAbsent,
	startTopicDraftAttempt,
	updateWorkingDraftBody,
} from "../prisma/queries/projects/publishing-drafts";

const ORG_PROJECT = [
	{
		organizationId: "org-1",
		userId: "owner-1",
		status: "ACTIVE",
		deletedAt: null,
	},
];

const START = {
	topicId: "topic-1",
	projectId: "project-1",
	postType: "TWEET" as const,
	requestedById: "user-1",
	guidance: null,
};

/**
 * A `P2002` shaped the way this repo's driver adapter ACTUALLY produces one.
 *
 * Copied field-for-field from a real Postgres run, not composed from what the
 * shape ought to be. That distinction cost a bug: the first version of this
 * fixture put the constraint name in `cause.constraint` as a string, which is
 * where it seemed like it should live, and every case below passed against a
 * discriminator that in reality matched nothing and returned null for every
 * conflict — so a routine double-click would have 500'd. The real server puts
 * the name only inside `originalMessage`, and `constraint` is an object holding
 * the column list.
 *
 * A mock is a claim about the world. This one is now a measured claim, and the
 * real-Postgres cases 2B-2 G/H/I in `publishing-suite-constraints.test.ts` are
 * what keep it honest — they are the only thing that can notice if the adapter's
 * shape changes under it.
 */
function uniqueViolation(constraint: string, fields: string[]) {
	return Object.assign(new Error("Unique constraint failed"), {
		code: "P2002",
		meta: {
			modelName: "PublishingTopicDraft",
			driverAdapterError: {
				name: "DriverAdapterError",
				cause: {
					originalCode: "23505",
					originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
					kind: "UniqueConstraintViolation",
					constraint: { fields: fields.map((f) => `"${f}"`) },
				},
			},
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	h.queryRaw.mockResolvedValue(ORG_PROJECT);
	h.topicFindFirst.mockResolvedValue({ id: "topic-1" });
	h.draftFindFirst.mockResolvedValue(null);
	h.draftAggregate.mockResolvedValue({ _max: { version: 0 } });
	h.draftCreate.mockResolvedValue({ id: "draft-1", version: 1 });
	h.draftUpdateMany.mockResolvedValue({ count: 1 });
	h.workingUpsert.mockResolvedValue({ updatedAt: new Date() });
	h.workingFindUnique.mockResolvedValue(null);
	h.workingFindFirst.mockResolvedValue(null);
	h.workingCreate.mockResolvedValue({ updatedAt: new Date() });
	h.workingUpdate.mockResolvedValue({ updatedAt: new Date() });
	h.workingUpdateMany.mockResolvedValue({ count: 1 });
	h.workingFindUniqueOrThrow.mockResolvedValue({ updatedAt: new Date() });
});

describe("startTopicDraftAttempt — tenancy", () => {
	it("locks the project row FOR UPDATE before anything else", async () => {
		await startTopicDraftAttempt(START);

		// `FOR UPDATE` blocks a concurrent org transfer from committing until
		// this transaction does, which CLOSES the window rather than detecting it
		// afterwards.
		const sql = h.queryRaw.mock.calls[0][0].join("?");
		expect(sql).toMatch(/FOR UPDATE/);
	});

	it("stamps tenancy from the LOCKED row, never from the caller", async () => {
		await startTopicDraftAttempt(START);

		const data = h.draftCreate.mock.calls[0][0].data;
		expect(data.organizationId).toBe("org-1");
		// XOR: an org project's row carries a null userId. `requestedById` is
		// authorship and a different column on purpose — conflating the two is
		// what the tenant CHECK would reject.
		expect(data.userId).toBeNull();
		expect(data.requestedById).toBe("user-1");
	});

	it("normalises a PERSONAL project to userId, org null", async () => {
		h.queryRaw.mockResolvedValue([
			{
				organizationId: null,
				userId: "owner-1",
				status: "ACTIVE",
				deletedAt: null,
			},
		]);

		await startTopicDraftAttempt(START);

		const data = h.draftCreate.mock.calls[0][0].data;
		expect(data.organizationId).toBeNull();
		expect(data.userId).toBe("owner-1");
	});

	it("refuses an archived project without touching the topic", async () => {
		h.queryRaw.mockResolvedValue([
			{
				organizationId: "org-1",
				userId: "owner-1",
				status: "ARCHIVED",
				deletedAt: null,
			},
		]);

		const result = await startTopicDraftAttempt(START);

		expect(result).toEqual({ status: "project_ineligible" });
		expect(h.draftCreate).not.toHaveBeenCalled();
	});

	it("scopes the topic by BOTH ids", async () => {
		await startTopicDraftAttempt(START);

		// DV16: a valid topic id from another project must resolve to the same
		// nothing a missing one does, never to a distinguishable error.
		expect(h.topicFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "topic-1", projectId: "project-1" },
			}),
		);
	});

	it("reports a topic from another project as not_found", async () => {
		h.topicFindFirst.mockResolvedValue(null);

		const result = await startTopicDraftAttempt(START);

		expect(result).toEqual({ status: "not_found" });
	});
});

describe("startTopicDraftAttempt — the in-flight index", () => {
	it("looks for a blocker of the SAME content type only", async () => {
		await startTopicDraftAttempt(START);

		// The index is per (topic, content type): generating a short post while a
		// blog post generates is legitimate, so a blog blocker must not stop this.
		expect(h.draftFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					postType: "TWEET",
					status: "GENERATING",
				}),
			}),
		);
	});

	it("does NOT tenant-scope the blocker lookup", async () => {
		await startTopicDraftAttempt(START);

		// A row stamped with an OLD tenant still holds the index slot. Scoping
		// this lookup by tenant would miss that blocker and leave the content type
		// stuck on it forever; the tenant decision belongs in the reclaim RULE.
		const where = h.draftFindFirst.mock.calls[0][0].where;
		expect(where.organizationId).toBeUndefined();
		expect(where.userId).toBeUndefined();
	});

	it("reclaims an EXPIRED blocker so the content type is not locked forever", async () => {
		h.draftFindFirst.mockResolvedValue({
			id: "stranded",
			organizationId: "org-1",
			userId: null,
			executionTimeoutAt: new Date(Date.now() - 60_000),
		});

		await startTopicDraftAttempt(START);

		expect(h.draftUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "stranded",
					status: "GENERATING",
				}),
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
		expect(h.draftCreate).toHaveBeenCalled();
	});

	it("leaves a LIVE blocker alone", async () => {
		h.draftFindFirst.mockResolvedValue({
			id: "live",
			organizationId: "org-1",
			userId: null,
			executionTimeoutAt: new Date(Date.now() + 600_000),
		});

		await startTopicDraftAttempt(START);

		expect(h.draftUpdateMany).not.toHaveBeenCalled();
	});

	it("reclaims a CROSS-TENANT blocker unconditionally, deadline or not", async () => {
		// The tenant fence in `completeTopicDraft` guarantees such a row can never
		// legitimately finish, so making the content type wait out ten minutes for
		// a row that is already dead would be a lock with no purpose.
		h.draftFindFirst.mockResolvedValue({
			id: "from-old-org",
			organizationId: "org-OTHER",
			userId: null,
			executionTimeoutAt: new Date(Date.now() + 600_000),
		});

		await startTopicDraftAttempt(START);

		expect(h.draftUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "FAILED",
					error: expect.stringContaining("transfer"),
				}),
			}),
		);
	});
});

describe("startTopicDraftAttempt — P2002 discrimination", () => {
	it("reports the IN-FLIGHT index as in_flight", async () => {
		h.draftCreate.mockRejectedValue(
			uniqueViolation("publishing_topic_draft_active", [
				"topicId",
				"postType",
			]),
		);

		const result = await startTopicDraftAttempt(START);

		expect(result).toEqual({ status: "in_flight" });
	});

	it("RETHROWS a version-unique violation instead of calling it in_flight", async () => {
		// This table has TWO unique constraints where the planning table has one.
		// A catch-all would report a version collision as an in-flight run: the UI
		// would spin for a generation that does not exist and will never report,
		// and the underlying allocation bug would never surface. Failing loudly on
		// a conflict we cannot explain is the only safe direction.
		h.draftCreate.mockRejectedValue(
			uniqueViolation(
				"publishing_topic_draft_topicId_postType_version_key",
				["topicId", "postType", "version"],
			),
		);

		await expect(startTopicDraftAttempt(START)).rejects.toThrow();
	});

	it("RETHROWS a P2002 whose constraint cannot be named", async () => {
		h.draftCreate.mockRejectedValue(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
				meta: {},
			}),
		);

		await expect(startTopicDraftAttempt(START)).rejects.toThrow();
	});

	it("RETHROWS a non-unique database error", async () => {
		h.draftCreate.mockRejectedValue(
			Object.assign(new Error("connection lost"), { code: "P1001" }),
		);

		await expect(startTopicDraftAttempt(START)).rejects.toThrow(
			"connection lost",
		);
	});
});

describe("startTopicDraftAttempt — versioning", () => {
	it("allocates versions PER content type", async () => {
		await startTopicDraftAttempt(START);

		// A short post and a blog post on one topic each count from 1, because a
		// reader compares versions within a content type and never across two.
		expect(h.draftAggregate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ postType: "TWEET" }),
			}),
		);
	});

	it("continues from the highest existing version", async () => {
		h.draftAggregate.mockResolvedValue({ _max: { version: 4 } });

		await startTopicDraftAttempt(START);

		expect(h.draftCreate.mock.calls[0][0].data.version).toBe(5);
	});

	it("records the run's guidance on the attempt row", async () => {
		await startTopicDraftAttempt({ ...START, guidance: "Keep it short" });

		expect(h.draftCreate.mock.calls[0][0].data.guidance).toBe(
			"Keep it short",
		);
	});

	it("sets a liveness deadline so a dead worker cannot lock the type", async () => {
		await startTopicDraftAttempt(START);

		const at = h.draftCreate.mock.calls[0][0].data.executionTimeoutAt;
		expect(at).toBeInstanceOf(Date);
		expect(at.getTime()).toBeGreaterThan(Date.now());
	});
});

describe("completeTopicDraft", () => {
	beforeEach(() => {
		// The stored row's tenant tuple. The suite default is `null`, which is
		// the "blocker lookup found nothing" answer `startTopicDraftAttempt`
		// wants — here the same mock is the tenant fence's read, and a null makes
		// it refuse. That refusal is itself asserted below.
		h.draftFindFirst.mockResolvedValue({
			organizationId: "org-1",
			userId: null,
		});
	});

	it("CASes on GENERATING", async () => {
		await completeTopicDraft({
			id: "d1",
			projectId: "project-1",
			content: { options: [] },
			sourceRefs: {},
			model: "m",
			promptSource: "BOUND",
			promptId: null,
			promptVersion: null,
		});

		// Once a deadline reclaim marked this attempt FAILED and let a newer one
		// through the partial index, this attempt's activity is still running.
		// Without the CAS it would resurrect itself to READY, leaving two terminal
		// rows for one content type with the older one silently newer.
		expect(h.draftUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: "GENERATING" }),
			}),
		);
	});

	it("clears the deadline so a finished draft stops reading as stranded", async () => {
		await completeTopicDraft({
			id: "d1",
			projectId: "project-1",
			content: {},
			sourceRefs: {},
			model: null,
			promptSource: "BOUND",
			promptId: null,
			promptVersion: null,
		});

		expect(
			h.draftUpdateMany.mock.calls[0][0].data.executionTimeoutAt,
		).toBeNull();
	});

	it("REFUSES to commit an attempt whose tenant no longer matches the project", async () => {
		// An attempt opened under org A and completed after a transfer to org B
		// would otherwise be marked READY, putting content generated under A's
		// identity in front of B's members on a row whose own columns contradict
		// its project.
		h.draftFindFirst.mockResolvedValue({
			organizationId: "org-OTHER",
			userId: null,
		});

		const result = await completeTopicDraft({
			id: "d1",
			projectId: "project-1",
			content: {},
			sourceRefs: {},
			model: null,
			promptSource: "BOUND",
			promptId: null,
			promptVersion: null,
		});

		// The REASON, not just the refusal. All three refusals used to be
		// the same bare `{ persisted: false }`, and every caller in the
		// suite logged all three as "superseded" — which sent an operator
		// looking for a newer attempt that in two of the three cases does
		// not exist.
		expect(result).toEqual({
			persisted: false,
			reason: "tenant_changed",
		});
		expect(h.draftUpdateMany).not.toHaveBeenCalled();
	});

	it("reports a lost CAS as not persisted rather than throwing", async () => {
		h.draftUpdateMany.mockResolvedValue({ count: 0 });

		const result = await completeTopicDraft({
			id: "d1",
			projectId: "project-1",
			content: {},
			sourceRefs: {},
			model: null,
			promptSource: "BOUND",
			promptId: null,
			promptVersion: null,
		});

		// Supersession is a normal outcome, not an error — and it is the ONE
		// refusal that word is true of.
		expect(result).toEqual({ persisted: false, reason: "superseded" });
	});

	it("names an archived project as such, not as a supersession", async () => {
		// The case that had no name before this. Somebody archives a project
		// while a generation is in flight; the lock refuses, and the caller used
		// to log "attempt superseded" — sending whoever read that line looking
		// for a newer attempt that does not exist. The row stays GENERATING on
		// purpose, for the expiry reclaim to pick up if the project comes back.
		h.queryRaw.mockResolvedValue([
			{
				organizationId: "org-1",
				userId: "owner-1",
				status: "ARCHIVED",
				deletedAt: null,
			},
		]);

		const result = await completeTopicDraft({
			id: "d1",
			projectId: "project-1",
			content: {},
			sourceRefs: {},
			model: null,
			promptSource: "BOUND",
			promptId: null,
			promptVersion: null,
		});

		expect(result).toEqual({
			persisted: false,
			reason: "project_ineligible",
		});
		expect(h.draftUpdateMany).not.toHaveBeenCalled();
	});

	it("distinguishes a soft-deleted project from an archived one only by the log", async () => {
		// Both are `project_ineligible`: the lock's eligibility rule is one
		// predicate, and splitting the reason further would promise a
		// distinction the query does not make.
		h.queryRaw.mockResolvedValue([
			{
				organizationId: "org-1",
				userId: "owner-1",
				status: "ACTIVE",
				deletedAt: new Date(),
			},
		]);

		const result = await completeTopicDraft({
			id: "d1",
			projectId: "project-1",
			content: {},
			sourceRefs: {},
			model: null,
			promptSource: "BOUND",
			promptId: null,
			promptVersion: null,
		});

		expect(result).toEqual({
			persisted: false,
			reason: "project_ineligible",
		});
	});
});

describe("failTopicDraft", () => {
	beforeEach(() => {
		h.draftFindFirst.mockResolvedValue({
			organizationId: "org-1",
			userId: null,
		});
	});

	it("bounds the error text", async () => {
		// This string reaches a user-facing panel, and an unbounded provider
		// message can be kilobytes of stack.
		await failTopicDraft({
			id: "d1",
			projectId: "project-1",
			error: "x".repeat(9000),
		});

		expect(
			h.draftUpdateMany.mock.calls[0][0].data.error.length,
		).toBeLessThanOrEqual(2000);
	});

	it("CASes on GENERATING like the success path", async () => {
		await failTopicDraft({ id: "d1", projectId: "project-1", error: "e" });

		expect(h.draftUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: "GENERATING" }),
			}),
		);
	});

	it("refuses a cross-tenant attempt", async () => {
		h.draftFindFirst.mockResolvedValue({
			organizationId: "org-OTHER",
			userId: null,
		});

		const result = await failTopicDraft({
			id: "d1",
			projectId: "project-1",
			error: "e",
		});

		expect(result).toEqual({
			persisted: false,
			reason: "tenant_changed",
		});
		expect(h.draftUpdateMany).not.toHaveBeenCalled();
	});
});

describe("saveWorkingDraft", () => {
	const SAVE = {
		topicId: "topic-1",
		projectId: "project-1",
		postType: "TWEET" as const,
		sourceDraftId: "draft-1",
		sourceOptionLabel: "Direct",
		body: "Builds are faster now.",
		updatedById: "user-1",
		expectedUpdatedAt: null,
	};

	it("verifies the candidate by ALL FOUR ids and its READY status", async () => {
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });

		await saveWorkingDraft(SAVE);

		// Scoping by draft id alone would let a caller name a candidate from
		// another topic. The composite FK would reject it, but as an opaque
		// failure rather than an answer — and the round trip would have confirmed
		// that id exists somewhere.
		expect(h.draftFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "draft-1",
					topicId: "topic-1",
					projectId: "project-1",
					postType: "TWEET",
					status: "READY",
				},
			}),
		);
	});

	it("answers source_not_found rather than letting the FK throw", async () => {
		h.draftFindFirst.mockResolvedValue(null);

		const result = await saveWorkingDraft(SAVE);

		expect(result).toEqual({ status: "source_not_found" });
		expect(h.workingUpsert).not.toHaveBeenCalled();
	});

	it("re-stamps tenancy on UPDATE, not only on create", async () => {
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });

		await saveWorkingDraft(SAVE);

		// A row that predates an org transfer otherwise keeps the old tenant and,
		// under `policy`-mode RLS, becomes invisible to the project's current
		// members.
		const call = h.workingUpsert.mock.calls[0][0];
		expect(call.create.organizationId).toBe("org-1");
		expect(call.update.organizationId).toBe("org-1");
		expect(call.update.userId).toBeNull();
	});

	it("keys the upsert on (topic, content type)", async () => {
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });

		await saveWorkingDraft(SAVE);

		expect(h.workingUpsert.mock.calls[0][0].where).toEqual({
			topicId_postType: { topicId: "topic-1", postType: "TWEET" },
		});
	});

	it("refuses an archived project", async () => {
		h.queryRaw.mockResolvedValue([
			{
				organizationId: "org-1",
				userId: "owner-1",
				status: "ACTIVE",
				deletedAt: new Date(),
			},
		]);

		const result = await saveWorkingDraft(SAVE);

		expect(result).toEqual({ status: "project_ineligible" });
	});

	it("refuses as STALE when the working draft has moved on", async () => {
		// Two people choosing different options seconds apart both used to
		// succeed, and the second silently erased the first: the project lock
		// serialises the writes but says nothing about whether the second writer
		// knew what it was overwriting. Raised in adversarial review.
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });
		h.workingFindUnique.mockResolvedValue({
			updatedAt: new Date("2026-09-01T12:00:00Z"),
		});

		const result = await saveWorkingDraft({
			...SAVE,
			expectedUpdatedAt: null,
		});

		expect(result).toEqual({ status: "stale" });
		expect(h.workingUpsert).not.toHaveBeenCalled();
	});

	it("proceeds when the caller's expectation matches", async () => {
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });
		h.workingFindUnique.mockResolvedValue({
			updatedAt: new Date("2026-09-01T12:00:00Z"),
		});

		const result = await saveWorkingDraft({
			...SAVE,
			expectedUpdatedAt: new Date("2026-09-01T12:00:00Z"),
		});

		expect(result).toMatchObject({ status: "saved" });
	});

	it("compares the INSTANT, not the Date object identity", async () => {
		// The caller's copy has been through JSON and back, so it is a different
		// object for the same instant. A `!==` on the objects would report every
		// save from a real client as stale.
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });
		const at = new Date("2026-09-01T12:00:00Z");
		h.workingFindUnique.mockResolvedValue({ updatedAt: at });

		const result = await saveWorkingDraft({
			...SAVE,
			expectedUpdatedAt: new Date(at.toISOString()),
		});

		expect(result).toMatchObject({ status: "saved" });
	});

	it("refuses a caller whose timestamp is merely CLOSE", async () => {
		// A millisecond apart is a different version. The column is
		// timestamp(3), so this is the finest distinction the store can make and
		// the check must not round past it.
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });
		h.workingFindUnique.mockResolvedValue({
			updatedAt: new Date("2026-09-01T12:00:00.001Z"),
		});

		const result = await saveWorkingDraft({
			...SAVE,
			expectedUpdatedAt: new Date("2026-09-01T12:00:00.000Z"),
		});

		expect(result).toEqual({ status: "stale" });
	});

	it("treats an absent row and a null expectation as agreeing", async () => {
		// The first selection on a topic. A check that called this a mismatch
		// would make the common case impossible.
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });
		h.workingFindUnique.mockResolvedValue(null);

		const result = await saveWorkingDraft({
			...SAVE,
			expectedUpdatedAt: null,
		});

		expect(result).toMatchObject({ status: "saved" });
	});

	it("reads the CAS value inside the locked transaction", async () => {
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });

		await saveWorkingDraft(SAVE);

		// Read after the project lock, so nothing else can commit a selection
		// for this project between the check and the write. A read taken before
		// the lock would be the same TOCTOU the lock exists to close.
		expect(h.queryRaw).toHaveBeenCalled();
		expect(h.workingFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					topicId_postType: {
						topicId: "topic-1",
						postType: "TWEET",
					},
				},
			}),
		);
	});
});

const SEED = {
	topicId: "topic-1",
	projectId: "project-1",
	postType: "BLOG_POST" as const,
	sourceDraftId: "draft-1",
	body: "# A post\n\nText.",
	updatedById: "user-1",
};

describe("seedWorkingDraftIfAbsent — the create-only writer (DV5/FR35)", () => {
	it("creates the working draft when the topic has none", async () => {
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });
		h.workingFindUnique.mockResolvedValue(null);

		const result = await seedWorkingDraftIfAbsent(SEED);

		expect(result).toMatchObject({ status: "seeded" });
		expect(h.workingCreate).toHaveBeenCalled();
	});

	it("REFUSES to touch an existing draft, and updates nothing", async () => {
		// FR35. This is the whole point of the helper: a regeneration reaches
		// this line every time after the first, and the saved body — which
		// someone may have spent an hour editing — must survive it.
		h.draftFindFirst.mockResolvedValue({ id: "draft-2" });
		h.workingFindUnique.mockResolvedValue({ id: "working-1" });

		const result = await seedWorkingDraftIfAbsent({
			...SEED,
			sourceDraftId: "draft-2",
		});

		expect(result).toEqual({ status: "already_exists" });
		expect(h.workingCreate).not.toHaveBeenCalled();
		expect(h.workingUpsert).not.toHaveBeenCalled();
		expect(h.workingUpdate).not.toHaveBeenCalled();
	});

	it("stamps tenancy from the LOCKED row, never from the caller", async () => {
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });

		await seedWorkingDraftIfAbsent(SEED);

		const data = h.workingCreate.mock.calls[0][0].data;
		expect(data.organizationId).toBe("org-1");
		// XOR: an org project's row carries a null userId.
		expect(data.userId).toBeNull();
	});

	it("locks the project row before reading anything", async () => {
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });

		await seedWorkingDraftIfAbsent(SEED);

		const sql = h.queryRaw.mock.calls[0][0].join("?");
		expect(sql).toMatch(/FOR UPDATE/);
	});

	it("saves a null option label — a blog generation has no options", async () => {
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });

		await seedWorkingDraftIfAbsent(SEED);

		expect(
			h.workingCreate.mock.calls[0][0].data.sourceOptionLabel,
		).toBeNull();
	});

	it("scopes the source lookup by all four ids and READY status", async () => {
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });

		await seedWorkingDraftIfAbsent(SEED);

		expect(h.draftFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "draft-1",
					topicId: "topic-1",
					projectId: "project-1",
					postType: "BLOG_POST",
					status: "READY",
				},
			}),
		);
	});

	it("answers source_not_found when the draft is not this topic's READY row", async () => {
		h.draftFindFirst.mockResolvedValue(null);

		const result = await seedWorkingDraftIfAbsent(SEED);

		expect(result).toEqual({ status: "source_not_found" });
		expect(h.workingCreate).not.toHaveBeenCalled();
	});

	it("refuses an archived project", async () => {
		h.queryRaw.mockResolvedValue([
			{
				organizationId: "org-1",
				userId: null,
				status: "ARCHIVED",
				deletedAt: null,
			},
		]);

		const result = await seedWorkingDraftIfAbsent(SEED);

		expect(result).toEqual({ status: "project_ineligible" });
		expect(h.workingCreate).not.toHaveBeenCalled();
	});

	it("treats a lost create race as already_exists, not as a crash", async () => {
		// The read and the write are both inside the project lock every other
		// writer takes, so losing this race needs a writer that does not. The
		// answer keeps that case on the same no-overwrite path.
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });
		h.workingFindUnique.mockResolvedValue(null);
		h.workingCreate.mockRejectedValue(
			uniqueViolation(
				"publishing_topic_working_draft_topicId_postType_key",
				["topicId", "postType"],
			),
		);

		const result = await seedWorkingDraftIfAbsent(SEED);

		expect(result).toEqual({ status: "already_exists" });
	});

	it("RETHROWS a unique violation it cannot name", async () => {
		// Failing loudly on a conflict we cannot explain is the only safe
		// direction — the alternative is a plausible-looking lie about state.
		h.draftFindFirst.mockResolvedValue({ id: "draft-1" });
		h.workingCreate.mockRejectedValue(
			uniqueViolation("some_other_constraint", ["id"]),
		);

		await expect(seedWorkingDraftIfAbsent(SEED)).rejects.toThrow();
	});
});

const EDIT = {
	topicId: "topic-1",
	projectId: "project-1",
	postType: "BLOG_POST" as const,
	body: "# Edited\n\nRewritten.",
	updatedById: "user-2",
	expectedUpdatedAt: new Date("2026-09-01T12:00:00Z"),
};

describe("updateWorkingDraftBody — the editor's writer", () => {
	it("writes the body when the caller's expectation still holds", async () => {
		h.workingFindFirst.mockResolvedValue({
			id: "working-1",
			updatedAt: new Date("2026-09-01T12:00:00Z"),
		});

		const result = await updateWorkingDraftBody(EDIT);

		expect(result).toMatchObject({ status: "saved" });
		expect(h.workingUpdateMany.mock.calls[0][0].data.body).toBe(
			"# Edited\n\nRewritten.",
		);
	});

	it("puts the expected version in the WHERE, not in a JS comparison", async () => {
		// The compare-and-set is the WRITE. An earlier version read `updatedAt`
		// and compared it in JS before an unconditional update, which is only
		// correct while every writer takes the project lock — a convention, not
		// a constraint. Raised by review. Postgres settles the comparison now,
		// which is also why this is a shape assertion: whether two instants are
		// equal is no longer this code's business.
		h.workingFindFirst.mockResolvedValue({ id: "working-1" });

		await updateWorkingDraftBody(EDIT);

		expect(h.workingUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "working-1",
					updatedAt: EDIT.expectedUpdatedAt,
				},
			}),
		);
	});

	it("REFUSES when the row moved under the caller", async () => {
		// The conditional write matches nothing, so nothing is written and the
		// count is what reports the loss.
		h.workingFindFirst.mockResolvedValue({ id: "working-1" });
		h.workingUpdateMany.mockResolvedValue({ count: 0 });

		const result = await updateWorkingDraftBody(EDIT);

		expect(result).toEqual({ status: "stale" });
	});

	it("leaves the draft's provenance alone", async () => {
		// `sourceDraftId` names where the text STARTED. An edit does not change
		// that, and it is also what makes the timestamp CAS necessary — a
		// source-based check would pass while the row HAD changed.
		h.workingFindFirst.mockResolvedValue({ id: "working-1" });

		await updateWorkingDraftBody(EDIT);

		const data = h.workingUpdateMany.mock.calls[0][0].data;
		expect(data).not.toHaveProperty("sourceDraftId");
		expect(data).not.toHaveProperty("sourceOptionLabel");
	});

	it("CREATES nothing when there is no working draft", async () => {
		// An editor that could conjure a row would let a body reach a topic
		// whose generation never ran.
		h.workingFindFirst.mockResolvedValue(null);

		const result = await updateWorkingDraftBody(EDIT);

		expect(result).toEqual({ status: "not_found" });
		expect(h.workingCreate).not.toHaveBeenCalled();
		expect(h.workingUpsert).not.toHaveBeenCalled();
	});

	it("scopes the lookup by projectId, not by the topic key alone", async () => {
		h.workingFindFirst.mockResolvedValue({ id: "working-1" });

		await updateWorkingDraftBody(EDIT);

		expect(h.workingFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					topicId: "topic-1",
					projectId: "project-1",
					postType: "BLOG_POST",
				},
			}),
		);
	});

	it("re-stamps tenancy so a transferred project's row stays visible", async () => {
		h.workingFindFirst.mockResolvedValue({ id: "working-1" });

		await updateWorkingDraftBody(EDIT);

		const data = h.workingUpdateMany.mock.calls[0][0].data;
		expect(data.organizationId).toBe("org-1");
		expect(data.userId).toBeNull();
	});

	it("refuses an archived project", async () => {
		h.queryRaw.mockResolvedValue([
			{
				organizationId: "org-1",
				userId: null,
				status: "ARCHIVED",
				deletedAt: null,
			},
		]);

		const result = await updateWorkingDraftBody(EDIT);

		expect(result).toEqual({ status: "project_ineligible" });
		expect(h.workingUpdateMany).not.toHaveBeenCalled();
	});
});
