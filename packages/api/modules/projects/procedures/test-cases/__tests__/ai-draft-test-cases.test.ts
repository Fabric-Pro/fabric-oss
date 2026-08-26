import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		userStory: { findMany: vi.fn() },
		project: { findUnique: vi.fn() },
	},
	claimTestCaseDraftJob: vi.fn(),
	setTestCaseDraftJobWorkflowId: vi.fn(),
	failTestCaseDraftJob: vi.fn(),
}));
const workflowStart = vi.fn();
vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: workflowStart },
	})),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));
vi.mock("../../../lib/test-cases-feature", () => ({
	assertTestCasesFeatureEnabled: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		resolveOrganizationId: (orgId: unknown) => orgId ?? undefined,
		Permissions: { TEST_CASE_CREATE: "test-case:create" },
	};
});

import {
	claimTestCaseDraftJob,
	db,
	failTestCaseDraftJob,
	setTestCaseDraftJobWorkflowId,
} from "@repo/database";
import {
	aiDraftTestCasesProcedure,
	MAX_FEATURES_PER_DRAFT_JOB,
} from "../ai-draft-test-cases";

const projectFindUnique = vi.mocked(db.project.findUnique);

const handler = (aiDraftTestCasesProcedure as unknown as { handler: Function })
	.handler;
const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};
const input = { projectId: "p1", storyIds: ["s1"], organizationId: null };

/** A story row as the project-scoped lookup returns it. */
const story = (id: string, acceptanceCriteria: string | null = "AC 1: x") => ({
	id,
	acceptanceCriteria,
});

beforeEach(() => {
	vi.clearAllMocks();
	// Default: manual test-case generation is on for the project (schema default).
	// The org on the RECORD is deliberately not the one any test sends as input.
	projectFindUnique.mockResolvedValue({
		generateManualTestCases: true,
		organizationId: "org-owning-the-project",
	} as never);
	vi.mocked(db.userStory.findMany).mockResolvedValue([story("s1")] as never);
	// Default: the atomic claim succeeds — no overlapping run is in flight.
	// The overlap/staleness semantics live in the claim itself and are proven
	// against real Postgres in test-case-draft-jobs.integration.test.ts.
	vi.mocked(claimTestCaseDraftJob).mockResolvedValue({
		job: { id: "job1", status: "PENDING" },
	} as never);
});

describe("aiDraftTestCasesProcedure", () => {
	it("is gated on TEST_CASE_CREATE", () => {
		expect(
			(aiDraftTestCasesProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("test-case:create");
	});

	it("starts a background run and returns its job id without drafting inline", async () => {
		// The whole point of the durable path: the caller gets a handle back
		// immediately, and nothing is generated on the request thread.
		await expect(handler({ input, context: ctx })).resolves.toEqual({
			jobId: "job1",
			status: "PENDING",
			totalFeatures: 1,
		});

		expect(workflowStart).toHaveBeenCalledWith(
			"testCaseDraftWorkflow",
			expect.objectContaining({
				taskQueue: "ai-chat",
				workflowId: "test-case-draft-job1",
				args: [
					expect.objectContaining({
						jobId: "job1",
						projectId: "p1",
						storyIds: ["s1"],
						userId: "u1",
					}),
				],
			}),
		);
		expect(setTestCaseDraftJobWorkflowId).toHaveBeenCalledWith({
			jobId: "job1",
			workflowId: "test-case-draft-job1",
		});
	});

	it("refuses when manual test-case generation is turned off for the project, before starting a run", async () => {
		// The project switch is a HARD gate. OFF must spend
		// no credits, so the procedure rejects before the claim writes a job row
		// or a workflow is dispatched. It also short-circuits before the feature
		// lookup, so nothing downstream runs.
		projectFindUnique.mockResolvedValue({
			generateManualTestCases: false,
		} as never);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("turned off"),
		});

		expect(db.userStory.findMany).not.toHaveBeenCalled();
		expect(claimTestCaseDraftJob).not.toHaveBeenCalled();
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("rejects when the project cannot be found", async () => {
		projectFindUnique.mockResolvedValue(null as never);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		expect(claimTestCaseDraftJob).not.toHaveBeenCalled();
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("scopes the feature lookup to the project and rejects a story from another project", async () => {
		// A story id outside this project must never resolve — the lookup is
		// project-scoped, so it simply isn't returned.
		vi.mocked(db.userStory.findMany).mockResolvedValue([] as never);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		expect(db.userStory.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["s1"] }, projectId: "p1" },
			}),
		);
		expect(claimTestCaseDraftJob).not.toHaveBeenCalled();
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("refuses a batch that smuggles in a story from another project", async () => {
		// The count guard is what makes the batch safe: a foreign id is absent
		// from the project-scoped result, so the whole request fails rather than
		// silently drafting only the ids that happened to belong here.
		vi.mocked(db.userStory.findMany).mockResolvedValue([
			story("s1"),
		] as never);

		await expect(
			handler({
				input: { ...input, storyIds: ["s1", "other-project-story"] },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(claimTestCaseDraftJob).not.toHaveBeenCalled();
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("refuses when no requested feature has acceptance criteria, before starting a run", async () => {
		// Acceptance criteria are the drafting contract — a run where not one
		// feature has them provably cannot draft anything, so it must not bill.
		for (const acceptanceCriteria of [null, "", "   "]) {
			vi.mocked(db.userStory.findMany).mockResolvedValue([
				story("s1", acceptanceCriteria),
			] as never);

			await expect(
				handler({ input, context: ctx }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("no acceptance criteria"),
			});
		}
		expect(claimTestCaseDraftJob).not.toHaveBeenCalled();
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("still runs a mixed batch where only some features have acceptance criteria", async () => {
		// One feature without criteria must not block the rest — it is recorded
		// as skipped by the run, not treated as a request-level error.
		vi.mocked(db.userStory.findMany).mockResolvedValue([
			story("s1"),
			story("s2", null),
		] as never);

		await expect(
			handler({
				input: { ...input, storyIds: ["s1", "s2"] },
				context: ctx,
			}),
		).resolves.toMatchObject({ jobId: "job1", totalFeatures: 2 });
	});

	it("collapses duplicate ids so the same feature is not billed twice", async () => {
		vi.mocked(db.userStory.findMany).mockResolvedValue([
			story("s1"),
		] as never);

		await expect(
			handler({
				input: { ...input, storyIds: ["s1", "s1"] },
				context: ctx,
			}),
		).resolves.toMatchObject({ totalFeatures: 1 });

		expect(claimTestCaseDraftJob).toHaveBeenCalledWith(
			expect.objectContaining({ storyIds: ["s1"] }),
		);
	});

	it("bills the org that owns the project, not the one the caller sent", async () => {
		// This guard authorizes `projectId` alone, and a non-null input org used
		// to be forwarded verbatim. The drafting run resolves AI credentials and
		// debits credits against whatever org it is handed, and nothing further
		// down the chain re-checks membership — so a caller naming someone
		// else's org would have spent that org's credits on this project.
		await expect(
			handler({
				input: { ...input, organizationId: "org-the-caller-claimed" },
				context: ctx,
			}),
		).resolves.toMatchObject({ jobId: "job1" });

		// The workflow runs outside the request context, so the tenant scope has
		// to travel with it — and it must be the project's own org.
		expect(claimTestCaseDraftJob).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-owning-the-project",
				userId: "u1",
			}),
		);
		expect(workflowStart.mock.calls[0][1].args[0]).toMatchObject({
			organizationId: "org-owning-the-project",
		});
	});

	it("fails the job row when the workflow cannot be dispatched", async () => {
		// Otherwise the client polls a PENDING row that will never resolve.
		workflowStart.mockRejectedValueOnce(new Error("temporal unavailable"));

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});

		expect(failTestCaseDraftJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "job1",
				error: "temporal unavailable",
			}),
		);
	});

	it("caps how many features one run may bill for", () => {
		// The cap is a spend limit, enforced as a rejection rather than a silent
		// trim — a truncated batch would bill for some features and drop the rest.
		expect(MAX_FEATURES_PER_DRAFT_JOB).toBe(5);
	});

	it("rejects with CONFLICT when the claim reports an overlapping run", async () => {
		// A second overlapping run would bill duplicate generations and append
		// duplicate cases. The check-and-create is atomic inside the claim; the
		// procedure's job is to surface the refusal as a CONFLICT.
		vi.mocked(claimTestCaseDraftJob).mockResolvedValue({
			blockedStoryIds: ["s1"],
		} as never);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("already being drafted"),
		});

		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("names the blocked features in the CONFLICT message", async () => {
		// Against a multi-feature selection, an unnamed "this feature" leaves
		// the user deselecting at random.
		vi.mocked(db.userStory.findMany).mockResolvedValue([
			{ id: "s1", identifier: "F-042", acceptanceCriteria: "AC" },
		] as never);
		vi.mocked(claimTestCaseDraftJob).mockResolvedValue({
			blockedStoryIds: ["s1"],
		} as never);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			message: expect.stringContaining("F-042"),
		});
	});
});
