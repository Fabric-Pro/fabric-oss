import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Planning & Analysis persistence (Fizzy #1851, Phase 2A-2).
 *
 * Unit-level with a mocked `db`, matching `get-publishing-topic.test.ts` and
 * `list-publishing-topics-degrade.test.ts`: this exercises the transaction's
 * SHAPE — what is locked, in what order, what the CAS predicates are — not real
 * Postgres semantics. It therefore runs in the regular no-Postgres suite and is
 * NOT part of the `db-integration` real-PG count guard.
 *
 * What the mocks deliberately DO model, because these are the things that go
 * wrong: `$queryRaw` returns the locked Project row, and `updateMany` returns a
 * `count` the caller must respect.
 */

const {
	queryRaw,
	analysisFindFirst,
	analysisCreate,
	analysisUpdateMany,
	analysisAggregate,
	topicFindFirst,
	transaction,
} = vi.hoisted(() => ({
	queryRaw: vi.fn(),
	analysisFindFirst: vi.fn(),
	analysisCreate: vi.fn(),
	analysisUpdateMany: vi.fn(),
	analysisAggregate: vi.fn(),
	topicFindFirst: vi.fn(),
	transaction: vi.fn(),
}));

const tx = {
	$queryRaw: queryRaw,
	publishingTopic: { findFirst: topicFindFirst },
	publishingTopicPlanningAnalysis: {
		findFirst: analysisFindFirst,
		create: analysisCreate,
		updateMany: analysisUpdateMany,
		aggregate: analysisAggregate,
	},
};

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: transaction,
		$queryRaw: queryRaw,
		publishingTopic: { findFirst: topicFindFirst },
		publishingTopicPlanningAnalysis: {
			findFirst: analysisFindFirst,
			create: analysisCreate,
			updateMany: analysisUpdateMany,
			aggregate: analysisAggregate,
		},
	},
	Prisma: {},
}));

import {
	completePlanningAnalysis,
	failPlanningAnalysis,
	getLatestPlanningAnalysis,
	startPlanningAnalysisAttempt,
} from "../prisma/queries/projects/publishing-planning";

const ORG_PROJECT = {
	organizationId: "org-1",
	userId: "owner-1",
	status: "ACTIVE",
	deletedAt: null,
};
const PERSONAL_PROJECT = {
	organizationId: null,
	userId: "owner-1",
	status: "ACTIVE",
	deletedAt: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) =>
		fn(tx),
	);
	queryRaw.mockResolvedValue([ORG_PROJECT]);
	topicFindFirst.mockResolvedValue({ id: "topic-1", projectId: "proj-1" });
	analysisFindFirst.mockResolvedValue(null);
	analysisAggregate.mockResolvedValue({ _max: { version: null } });
	analysisUpdateMany.mockResolvedValue({ count: 1 });
	analysisCreate.mockImplementation(
		async ({ data }: { data: Record<string, unknown> }) => ({
			id: "analysis-1",
			...data,
		}),
	);
});

describe("startPlanningAnalysisAttempt — tenancy", () => {
	it("derives the tenant tuple from a Project row it locked FOR UPDATE", async () => {
		// C-High (tenant TOCTOU). `createManualPublishingTopic` exists because the
		// two-step `resolveProjectTenant` + create was found to stamp a stale org
		// when a project transferred mid-window. This helper must lock the same
		// way, or it reintroduces the bug one table over.
		await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		expect(queryRaw).toHaveBeenCalled();
		const sql = String(queryRaw.mock.calls[0]?.[0]);
		expect(sql).toMatch(/FOR UPDATE/i);
	});

	it("locks the Project before touching any analysis row", async () => {
		// Fixed lock order — Project first, then the analysis rows — so two
		// concurrent attempts on one topic cannot deadlock against each other.
		const order: string[] = [];
		queryRaw.mockImplementation(async () => {
			order.push("lock");
			return [ORG_PROJECT];
		});
		analysisUpdateMany.mockImplementation(async () => {
			order.push("reclaim");
			return { count: 0 };
		});
		analysisCreate.mockImplementation(async () => {
			order.push("create");
			return { id: "analysis-1" };
		});

		await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		expect(order[0]).toBe("lock");
		expect(order.at(-1)).toBe("create");
	});

	it("writes userId NULL for an organization project (XOR)", async () => {
		// PublishingTopic is XOR-normalised and the DB CHECK enforces exactly one
		// of (organizationId, userId). Copying DecisionLogEntry's required userId
		// would make every org write fail the constraint.
		await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		const data = analysisCreate.mock.calls[0]?.[0]?.data;
		expect(data.organizationId).toBe("org-1");
		expect(data.userId).toBeNull();
	});

	it("writes organizationId NULL for a personal project (XOR)", async () => {
		queryRaw.mockResolvedValue([PERSONAL_PROJECT]);

		await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		const data = analysisCreate.mock.calls[0]?.[0]?.data;
		expect(data.organizationId).toBeNull();
		expect(data.userId).toBe("owner-1");
	});

	it("records the requester as authorship, never as tenancy", async () => {
		await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "requester-9",
		});

		const data = analysisCreate.mock.calls[0]?.[0]?.data;
		expect(data.requestedById).toBe("requester-9");
		expect(data.userId).not.toBe("requester-9");
	});

	it("refuses an archived or soft-deleted project", async () => {
		// Mirrors persistCycleTerminal's eligibility check on the locked row: a
		// project archived after the request must not receive new work.
		queryRaw.mockResolvedValue([{ ...ORG_PROJECT, status: "ARCHIVED" }]);

		const result = await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		// `project_ineligible`, not `not_found`: this test used to assert the very
		// conflation Copilot flagged on #61, where an archived project was
		// reported to the user as a missing TOPIC. What it is really here to pin
		// is that no work is created either way.
		expect(result.status).toBe("project_ineligible");
		expect(analysisCreate).not.toHaveBeenCalled();
	});

	it("refuses a topic that belongs to another project (DV16)", async () => {
		topicFindFirst.mockResolvedValue(null);

		const result = await startPlanningAnalysisAttempt({
			topicId: "topic-from-elsewhere",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		expect(result.status).toBe("not_found");
		expect(analysisCreate).not.toHaveBeenCalled();
	});
});

describe("startPlanningAnalysisAttempt — lifecycle", () => {
	it("always stamps a liveness deadline on a GENERATING row", async () => {
		// The DB CHECK requires it, but the point is the reclaim: a partial unique
		// index with no deadline is a permanent lock on the topic if a worker dies
		// between insert and marker.
		await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		const data = analysisCreate.mock.calls[0]?.[0]?.data;
		expect(data.status).toBe("GENERATING");
		expect(data.executionTimeoutAt).toBeInstanceOf(Date);
		expect((data.executionTimeoutAt as Date).getTime()).toBeGreaterThan(
			Date.now(),
		);
	});

	it("reclaims an expired GENERATING attempt and proceeds", async () => {
		// The precondition is asserted, not just the outcome: a test that only
		// checked "the second attempt succeeded" would pass against an
		// implementation with no partial index at all.
		//
		// The expiry decision moved out of the WHERE clause and into application
		// code when the cross-tenant fence landed — a stale-tenant row must be
		// reclaimed whether or not it has expired, which one SQL predicate cannot
		// express. So the precondition is now asserted on the LOOKUP (it must
		// match the index's own key, not the tenant) and on the reclaim targeting
		// that exact row.
		analysisFindFirst.mockResolvedValue({
			id: "stale-1",
			organizationId: "org-1",
			userId: null,
			executionTimeoutAt: new Date(Date.now() - 1000),
		});
		analysisUpdateMany.mockResolvedValue({ count: 1 }); // one stale row reclaimed

		const result = await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		const lookup = analysisFindFirst.mock.calls[0]?.[0];
		expect(lookup.where).toEqual({
			topicId: "topic-1",
			projectId: "proj-1",
			status: "GENERATING",
		});

		const reclaim = analysisUpdateMany.mock.calls[0]?.[0];
		expect(reclaim.where.id).toBe("stale-1");
		expect(reclaim.where.status).toBe("GENERATING");
		expect(reclaim.data.status).toBe("FAILED");
		expect(result.status).toBe("started");
	});

	it("allocates the next version rather than reusing one", async () => {
		analysisAggregate.mockResolvedValue({ _max: { version: 4 } });

		await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		expect(analysisCreate.mock.calls[0]?.[0]?.data.version).toBe(5);
	});

	it("reports in_flight instead of throwing when the guard index fires", async () => {
		// A double-click is routine. The partial unique index is the enforcement;
		// this turns its violation into an answer rather than a 500.
		analysisCreate.mockRejectedValue(
			Object.assign(new Error("unique"), { code: "P2002" }),
		);

		const result = await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		expect(result.status).toBe("in_flight");
	});
});

describe("completePlanningAnalysis", () => {
	it("commits only a still-GENERATING attempt", async () => {
		// The terminal CAS. Once a deadline reclaim marks attempt A FAILED and lets
		// B through the index, A's activity is still running and would otherwise
		// resurrect A to READY — two terminal rows for one topic, the older one
		// silently newer.
		// The tenant fence reads the stored tuple first; it must match the locked
		// project or the CAS is never reached (see the cross-tenant fence tests).
		analysisFindFirst.mockResolvedValue({
			organizationId: "org-1",
			userId: null,
		});

		await completePlanningAnalysis({
			id: "analysis-1",
			projectId: "proj-1",
			content: { topicAngle: "x" },
			sourceRefs: {},
			model: "test-model",
			promptSource: "BOUND",
		});

		const where = analysisUpdateMany.mock.calls[0]?.[0]?.where;
		expect(where.id).toBe("analysis-1");
		expect(where.projectId).toBe("proj-1");
		expect(where.status).toBe("GENERATING");
	});

	it("writes no content when the attempt was already reclaimed", async () => {
		analysisUpdateMany.mockResolvedValue({ count: 0 });

		const result = await completePlanningAnalysis({
			id: "analysis-1",
			projectId: "proj-1",
			content: { topicAngle: "x" },
			sourceRefs: {},
			model: "test-model",
			promptSource: "BOUND",
		});

		expect(result.persisted).toBe(false);
	});

	it("re-validates the project tuple under lock before committing", async () => {
		// The activity checks the tuple before a multi-minute model call. A
		// project can transfer org during it, and content generated under a stale
		// tenant is exactly what must not be committed.
		await completePlanningAnalysis({
			id: "analysis-1",
			projectId: "proj-1",
			content: { topicAngle: "x" },
			sourceRefs: {},
			model: "test-model",
			promptSource: "BOUND",
		});

		expect(String(queryRaw.mock.calls[0]?.[0])).toMatch(/FOR UPDATE/i);
	});

	it("no-ops when the project has transferred away", async () => {
		queryRaw.mockResolvedValue([]); // project gone or not lockable

		const result = await completePlanningAnalysis({
			id: "analysis-1",
			projectId: "proj-1",
			content: { topicAngle: "x" },
			sourceRefs: {},
			model: "test-model",
			promptSource: "BOUND",
		});

		expect(result.persisted).toBe(false);
		expect(analysisUpdateMany).not.toHaveBeenCalled();
	});
});

describe("failPlanningAnalysis", () => {
	it("marks only a still-GENERATING attempt failed", async () => {
		// Same CAS as the success path: writing an error into a reclaimed row —
		// or another org's row — is still a wrong write, even though it is only a
		// string.
		analysisFindFirst.mockResolvedValue({
			organizationId: "org-1",
			userId: null,
		});

		await failPlanningAnalysis({
			id: "analysis-1",
			projectId: "proj-1",
			error: "model refused",
		});

		const where = analysisUpdateMany.mock.calls[0]?.[0]?.where;
		expect(where.status).toBe("GENERATING");
		expect(where.projectId).toBe("proj-1");
		expect(analysisUpdateMany.mock.calls[0]?.[0]?.data.status).toBe(
			"FAILED",
		);
	});
});

describe("getLatestPlanningAnalysis", () => {
	it("returns the latest READY separately from the latest attempt", async () => {
		// Two rows, not one. A failed regeneration must not blank a good previous
		// analysis, and a GENERATING attempt must not hide it — returning "the
		// newest row" would do both.
		const ready = { id: "a1", version: 1, status: "READY" };
		const attempt = { id: "a2", version: 2, status: "FAILED" };
		analysisFindFirst
			.mockResolvedValueOnce(attempt) // newest, any status
			.mockResolvedValueOnce(ready); // newest READY

		const result = await getLatestPlanningAnalysis({
			topicId: "topic-1",
			projectId: "proj-1",
		});

		// Each row is returned intact plus the server-computed `isExpired` flag —
		// the escape hatch for a GENERATING row nothing terminalised.
		expect(result.latestAttempt).toEqual({ ...attempt, isExpired: false });
		expect(result.latestReady).toEqual({ ...ready, isExpired: false });
	});

	it("scopes every read by projectId, never topicId alone (DV16)", async () => {
		await getLatestPlanningAnalysis({
			topicId: "topic-1",
			projectId: "proj-1",
		});

		for (const call of analysisFindFirst.mock.calls) {
			expect(call[0].where.projectId).toBe("proj-1");
			expect(call[0].where.topicId).toBe("topic-1");
		}
	});

	it("returns nulls for a topic with no analysis", async () => {
		analysisFindFirst.mockResolvedValue(null);

		const result = await getLatestPlanningAnalysis({
			topicId: "topic-1",
			projectId: "proj-1",
		});

		expect(result.latestAttempt).toBeNull();
		expect(result.latestReady).toBeNull();
	});
});

/**
 * Cross-tenant fencing on the terminal writes and on the reclaim.
 *
 * Codex adversarial review of the 2A-2 branch, and confirmed against this
 * repository's own precedent rather than taken on faith:
 * `dispatch-suggestion.ts:435-478` already reads a leftover GENERATING cycle's
 * STORED tenant tuple and reclaims it unconditionally when it differs from the
 * project's fresh one. This slice locked the project and derived the tuple, then
 * used it only for an eligibility null-check and threw the value away — so the
 * same defence the sibling table has was missing here.
 *
 * `Project.organizationId` is a mutable column. No transfer procedure exists in
 * the app today, which is exactly why the invariant is worth enforcing at the
 * write rather than assumed at the caller.
 */
describe("terminal writes — cross-tenant fence", () => {
	const STALE_TENANT = { organizationId: "org-OLD", userId: null };
	const CURRENT_TENANT = { organizationId: "org-1", userId: null };

	it("refuses to publish a result onto a row stamped with a different tenant", async () => {
		// The row was opened while the project belonged to org-OLD. By the time
		// the model returned, the project had moved. Marking it READY would put
		// content generated under the old tenant's identity in front of the new
		// tenant's members, on a row whose own columns disagree with its project.
		analysisFindFirst.mockResolvedValue(STALE_TENANT);

		const result = await completePlanningAnalysis({
			id: "analysis-1",
			projectId: "proj-1",
			content: { topicAngle: "..." },
			sourceRefs: {},
			model: "m",
			promptSource: "BOUND",
		});

		expect(result).toEqual({ persisted: false });
		expect(analysisUpdateMany).not.toHaveBeenCalled();
	});

	it("publishes when the stored tenant still matches the locked project", async () => {
		analysisFindFirst.mockResolvedValue(CURRENT_TENANT);

		const result = await completePlanningAnalysis({
			id: "analysis-1",
			projectId: "proj-1",
			content: { topicAngle: "..." },
			sourceRefs: {},
			model: "m",
			promptSource: "BOUND",
		});

		expect(result).toEqual({ persisted: true });
		expect(analysisUpdateMany).toHaveBeenCalled();
	});

	it("compares the personal-project tuple on userId, not only on the org", async () => {
		// Both tuples have organizationId null. Comparing only the org would call
		// a row owned by a different person a match — the XOR normalisation makes
		// `userId` the discriminating half for personal projects.
		queryRaw.mockResolvedValue([PERSONAL_PROJECT]);
		analysisFindFirst.mockResolvedValue({
			organizationId: null,
			userId: "someone-else",
		});

		const result = await completePlanningAnalysis({
			id: "analysis-1",
			projectId: "proj-1",
			content: {},
			sourceRefs: {},
			model: "m",
			promptSource: "BOUND",
		});

		expect(result).toEqual({ persisted: false });
		expect(analysisUpdateMany).not.toHaveBeenCalled();
	});

	it("fences the failure marker the same way, under the same lock", async () => {
		// A cheap payload does not make an unscoped write safe, and the failure
		// path is the one that runs when things are already going wrong.
		analysisFindFirst.mockResolvedValue(STALE_TENANT);

		const result = await failPlanningAnalysis({
			id: "analysis-1",
			projectId: "proj-1",
			error: "model timeout",
		});

		expect(result).toEqual({ persisted: false });
		expect(analysisUpdateMany).not.toHaveBeenCalled();
		// It must LOCK, not merely filter: without the lock the tuple it compares
		// can change between the read and the write.
		expect(String(queryRaw.mock.calls[0]?.[0])).toMatch(/FOR UPDATE/i);
	});

	it("marks failed when the tenant still matches", async () => {
		analysisFindFirst.mockResolvedValue(CURRENT_TENANT);

		await expect(
			failPlanningAnalysis({
				id: "analysis-1",
				projectId: "proj-1",
				error: "model timeout",
			}),
		).resolves.toEqual({ persisted: true });
	});
});

describe("startPlanningAnalysisAttempt — cross-tenant reclaim", () => {
	it("reclaims a stale cross-tenant row immediately, without waiting for its deadline", async () => {
		// The partial unique index is scoped by topicId ONLY, so a row stamped
		// with the old tenant still holds the slot. It can never legitimately
		// complete — the terminal fence above guarantees that — so making the
		// topic wait out a ten-minute deadline for a row that is already dead
		// would be a lock with no purpose.
		//
		// Mirrors dispatch-suggestion.ts's F2 cross-tenant supersede.
		analysisFindFirst.mockResolvedValue({
			id: "old-1",
			organizationId: "org-OLD",
			userId: null,
			// Deliberately NOT expired: the deadline is minutes away.
			executionTimeoutAt: new Date(Date.now() + 9 * 60 * 1000),
		});

		await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		const reclaim = analysisUpdateMany.mock.calls.find(
			(c) => c[0]?.data?.status === "FAILED",
		);
		expect(reclaim).toBeDefined();
		expect(reclaim?.[0]?.where?.id).toBe("old-1");
		expect(String(reclaim?.[0]?.data?.error)).toMatch(/transfer/i);
		expect(analysisCreate).toHaveBeenCalled();
	});

	it("leaves a live same-tenant row alone", async () => {
		// The ordinary in-flight case. Reclaiming here would let a double-click
		// cancel the run it is racing.
		analysisFindFirst.mockResolvedValue({
			id: "live-1",
			organizationId: "org-1",
			userId: null,
			executionTimeoutAt: new Date(Date.now() + 9 * 60 * 1000),
		});
		analysisCreate.mockRejectedValue(
			Object.assign(new Error("unique"), { code: "P2002" }),
		);

		const result = await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		expect(result).toEqual({ status: "in_flight" });
		expect(
			analysisUpdateMany.mock.calls.some(
				(c) => c[0]?.data?.status === "FAILED",
			),
		).toBe(false);
	});

	it("still reclaims an expired same-tenant row", async () => {
		analysisFindFirst.mockResolvedValue({
			id: "stuck-1",
			organizationId: "org-1",
			userId: null,
			executionTimeoutAt: new Date(Date.now() - 1000),
		});

		await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		const reclaim = analysisUpdateMany.mock.calls.find(
			(c) => c[0]?.data?.status === "FAILED",
		);
		expect(reclaim?.[0]?.where?.id).toBe("stuck-1");
		expect(String(reclaim?.[0]?.data?.error)).toMatch(/timed out/i);
	});
});

describe("getLatestPlanningAnalysis — the stranded-row escape hatch", () => {
	it("reports a GENERATING attempt past its deadline as expired", async () => {
		// Codex #2, and it is a genuine deadlock: the ONLY code that reclaims a
		// stranded row lives inside `startPlanningAnalysisAttempt`, and the panel
		// disables its generate button while an attempt reads GENERATING. A run
		// whose worker never started therefore locks the topic with no UI action
		// able to reach the reclaim. The read has to say so.
		analysisFindFirst.mockImplementation(async ({ where }) =>
			where.status === "READY"
				? null
				: {
						id: "stuck-1",
						version: 1,
						status: "GENERATING",
						executionTimeoutAt: new Date(Date.now() - 1000),
					},
		);

		const { latestAttempt } = await getLatestPlanningAnalysis({
			topicId: "topic-1",
			projectId: "proj-1",
		});

		expect(latestAttempt?.isExpired).toBe(true);
	});

	it("does not call a live attempt expired", async () => {
		analysisFindFirst.mockImplementation(async ({ where }) =>
			where.status === "READY"
				? null
				: {
						id: "live-1",
						version: 1,
						status: "GENERATING",
						executionTimeoutAt: new Date(Date.now() + 60_000),
					},
		);

		const { latestAttempt } = await getLatestPlanningAnalysis({
			topicId: "topic-1",
			projectId: "proj-1",
		});

		expect(latestAttempt?.isExpired).toBe(false);
	});

	it("never calls a terminal row expired", async () => {
		// Terminal rows may carry a NULL deadline, and a FAILED row is already
		// retryable — flagging it expired would put two different reasons on one
		// screen for the same state.
		analysisFindFirst.mockResolvedValue({
			id: "done-1",
			version: 1,
			status: "FAILED",
			executionTimeoutAt: null,
		});

		const { latestAttempt } = await getLatestPlanningAnalysis({
			topicId: "topic-1",
			projectId: "proj-1",
		});

		expect(latestAttempt?.isExpired).toBe(false);
	});
});

describe("startPlanningAnalysisAttempt — telling the two 'nothing happened' causes apart", () => {
	// Copilot review of #61: `not_found` was returned both when the topic does
	// not exist in the project AND when the project itself became ineligible
	// under the lock, and the procedure rendered both as "Topic not found". The
	// second is a lie — the topic may be perfectly fine and the project was
	// archived in another tab between the ratchet and this call.
	//
	// Splitting them leaks nothing: the caller has just passed a ratchet that
	// proved this project ACTIVE, so telling them it no longer is says nothing
	// they did not already know. Topic existence stays indistinguishable, which
	// is the part DV16 actually protects.
	it("reports an ineligible project as project_ineligible, not as a missing topic", async () => {
		queryRaw.mockResolvedValue([{ ...ORG_PROJECT, status: "ARCHIVED" }]);

		const result = await startPlanningAnalysisAttempt({
			topicId: "topic-1",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		expect(result).toEqual({ status: "project_ineligible" });
	});

	it("still reports a topic from another project as not_found", async () => {
		// The security-relevant half, unchanged: a real topic id belonging to
		// somewhere else must answer exactly as a deleted one does.
		topicFindFirst.mockResolvedValue(null);

		const result = await startPlanningAnalysisAttempt({
			topicId: "topic-elsewhere",
			projectId: "proj-1",
			requestedById: "user-1",
		});

		expect(result).toEqual({ status: "not_found" });
	});
});
