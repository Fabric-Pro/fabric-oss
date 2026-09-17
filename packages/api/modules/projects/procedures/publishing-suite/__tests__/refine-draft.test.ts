import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `acceptRefinement` — adopting a reviewed refinement proposal (Fizzy #1851
 * follow-up).
 *
 * Handler-level, mirroring `topic-drafts.test.ts`: the procedure chain and the
 * DB layer are both mocked, so what is under test is the handler's own
 * contract. Two things live there and nowhere else:
 *
 *  1. The REVIEWED body is passed through. The diff review resolves a proposal
 *     change by change, so what a person confirms is usually neither the saved
 *     draft nor the whole proposal, and a handler that dropped it would write
 *     the proposal over their decisions while reporting success.
 *  2. The per-content-type ceiling. The schema's own `.max()` has to be static
 *     — one bound for seven types whose limits differ by an order of magnitude
 *     — so the exact one is enforced here, against the same map the refinement
 *     output schema reads. When those two disagree a model can propose a body
 *     the save path then refuses, which is the 5,000-character refined tweet
 *     bug that `WORKING_DRAFT_BODY_MAX` exists to prevent.
 *
 * NOT under test here: the input schema itself. Calling `.handler` directly
 * bypasses zod, which is what makes the handler-level check above worth having
 * — the two bounds are independent, and this file can only see one of them.
 */

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
	acceptRefinement: vi.fn(),
	rejectRefinement: vi.fn(),
	startRefinement: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	acceptRefinement: dbMocks.acceptRefinement,
	rejectRefinement: dbMocks.rejectRefinement,
	startRefinement: dbMocks.startRefinement,
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
}));

const projectMocks = vi.hoisted(() => ({
	requireEligibleProjectForTopic: vi.fn(),
}));
vi.mock("../../../lib/publishing-topic-project", () => ({
	requireEligibleProjectForTopic: projectMocks.requireEligibleProjectForTopic,
}));

/**
 * Measurement only, and it swallows its own failures in production — mocked
 * here so a test never depends on that being true.
 */
vi.mock("../../../lib/publishing-outcome", () => ({
	recordEditedWorkingDraft: vi.fn().mockResolvedValue(undefined),
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
		Permissions: {
			PUBLISHING_TOPIC_READ: "publishing-topic:read",
			PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
		},
	};
});

import { WORKING_DRAFT_BODY_MAX } from "@repo/utils/publishing-working-draft-limits";
import { acceptRefinementProcedure } from "../refine-draft";

const handler = (acceptRefinementProcedure as unknown as { handler: Function })
	.handler;
const permission = (
	acceptRefinementProcedure as unknown as { __permission: string }
).__permission;

const SEEN = new Date("2026-09-01T12:00:00Z");

const INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
	postType: "BLOG_POST" as const,
	expectedUpdatedAt: SEEN,
};

const CONTEXT = { user: { id: "user-1" } };

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: "u1",
	});
	projectMocks.requireEligibleProjectForTopic.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	dbMocks.acceptRefinement.mockResolvedValue({
		status: "accepted",
		updatedAt: new Date("2026-09-01T12:10:00Z"),
		version: 4,
	});
});

describe("acceptRefinement procedure", () => {
	it("is gated on PUBLISHING_TOPIC_UPDATE — it replaces a body", () => {
		expect(permission).toBe("publishing-topic:update");
	});

	it("passes the reviewed body down, with the caller's concurrency token", async () => {
		await handler({
			input: { ...INPUT, body: "A partly revised draft." },
			context: CONTEXT,
		});

		expect(dbMocks.acceptRefinement).toHaveBeenCalledWith(
			expect.objectContaining({
				topicId: "topic-1",
				projectId: "project-1",
				postType: "BLOG_POST",
				acceptedById: "user-1",
				expectedUpdatedAt: SEEN,
				body: "A partly revised draft.",
			}),
		);
	});

	it("leaves the body undefined when the reviewer took the proposal whole", async () => {
		// The writer then uses the proposal it stored. Sending `undefined`
		// explicitly is the same thing as omitting it, and it is what the
		// fallback is keyed on.
		await handler({ input: INPUT, context: CONTEXT });

		expect(dbMocks.acceptRefinement).toHaveBeenCalledWith(
			expect.objectContaining({ body: undefined }),
		);
	});

	it("derives the tenant from the project row, never from the input", async () => {
		// The permission middleware proved the caller is authorized for THIS
		// project but never inspects the org; `input.organizationId` is a guard
		// only. The id that reaches the writer is the loaded row's.
		projectMocks.requireEligibleProjectForTopic.mockResolvedValue({
			id: "project-real",
			organizationId: "org-real",
		});

		await handler({
			input: { ...INPUT, organizationId: "org-claimed" },
			context: CONTEXT,
		});

		expect(dbMocks.acceptRefinement).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project-real" }),
		);
	});

	it("refuses a reviewed body past the content type's own ceiling", async () => {
		// A tweet's limit is 2,000 where a blog post's is 40,000, so a static
		// schema bound cannot express this one.
		const tooLong = "x".repeat(WORKING_DRAFT_BODY_MAX.TWEET + 1);

		await expect(
			handler({
				input: { ...INPUT, postType: "TWEET", body: tooLong },
				context: CONTEXT,
			}),
		).rejects.toThrow(/cannot exceed 2000 characters/);
		expect(dbMocks.acceptRefinement).not.toHaveBeenCalled();
	});

	it("accepts the same body for a content type whose ceiling allows it", async () => {
		// The negative control: proves the refusal above came from the bound
		// and not from the length of the string.
		const body = "x".repeat(WORKING_DRAFT_BODY_MAX.TWEET + 1);

		await handler({
			input: { ...INPUT, postType: "BLOG_POST", body },
			context: CONTEXT,
		});

		expect(dbMocks.acceptRefinement).toHaveBeenCalledWith(
			expect.objectContaining({ body }),
		);
	});

	it("reports a proposal whose baseline moved as a CONFLICT to run again", async () => {
		// DISTINCT from `stale`: refreshing changes nothing here, because the
		// proposal revises text nobody has any more.
		dbMocks.acceptRefinement.mockResolvedValue({
			status: "baseline_changed",
		});

		await expect(
			handler({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow(/Refine again/);
	});

	it("reports a spent proposal as NOT_FOUND, with nothing to retry against", async () => {
		dbMocks.acceptRefinement.mockResolvedValue({ status: "no_proposal" });

		await expect(
			handler({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow(/no refinement to accept/);
	});

	it("refuses when the Publishing Suite feature flag is off", async () => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			handler({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow(/Publishing Suite is not enabled/);
		expect(dbMocks.acceptRefinement).not.toHaveBeenCalled();
	});
});
