import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	listFeatureCoverage: vi.fn(),
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
		Permissions: {
			TEST_CASE_READ: "test-case:read",
			TEST_CASE_UPDATE: "test-case:update",
		},
	};
});

import { listFeatureCoverage } from "@repo/database";
import { listFeatureCoverageProcedure } from "../list-feature-coverage";

const handler = (
	listFeatureCoverageProcedure as unknown as { handler: Function }
).handler;
const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};

const emptyResult = { items: [], total: 0 };

beforeEach(() => {
	vi.clearAllMocks();
	process.env.FABRIC_FEATURE_TEST_CASES = "true";
	vi.mocked(listFeatureCoverage).mockResolvedValue(emptyResult as never);
});

describe("listFeatureCoverageProcedure", () => {
	it("is gated on TEST_CASE_READ (same gate as its per-story sibling)", () => {
		expect(
			(
				listFeatureCoverageProcedure as unknown as {
					__permission: string;
				}
			).__permission,
		).toBe("test-case:read");
	});

	it("behaves as if the route doesn't exist when the feature flag is off", async () => {
		process.env.FABRIC_FEATURE_TEST_CASES = "false";

		await expect(
			handler({ input: { projectId: "p1" }, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(listFeatureCoverage).not.toHaveBeenCalled();
	});

	it("scopes the query to the requested project", async () => {
		await handler({
			input: { projectId: "p1", organizationId: null },
			context: ctx,
		});

		expect(listFeatureCoverage).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "p1" }),
		);
	});

	it("forwards the filter/pagination inputs verbatim", async () => {
		await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				search: "F-12",
				kind: "FEATURE",
				uncoveredOnly: true,
				excludeClosed: true,
				order: "UNCOVERED_FIRST",
				limit: 20,
				offset: 40,
			},
			context: ctx,
		});

		expect(listFeatureCoverage).toHaveBeenCalledWith({
			projectId: "p1",
			search: "F-12",
			kind: "FEATURE",
			uncoveredOnly: true,
			excludeClosed: true,
			order: "UNCOVERED_FIRST",
			limit: 20,
			offset: 40,
		});
	});

	it("leaves kind unset when the caller doesn't filter (no hardcoded default)", async () => {
		await handler({ input: { projectId: "p1" }, context: ctx });

		expect(listFeatureCoverage).toHaveBeenCalledWith(
			expect.objectContaining({ kind: undefined }),
		);
	});

	it("imposes neither an order nor a closed filter — the query owns both defaults", async () => {
		await handler({ input: { projectId: "p1" }, context: ctx });

		// Left undefined so the paging reader keeps the query's stable order and
		// keeps seeing finished work; the picker is the one that opts out.
		expect(listFeatureCoverage).toHaveBeenCalledWith(
			expect.objectContaining({
				order: undefined,
				excludeClosed: undefined,
			}),
		);
	});

	it("returns the query's items + total unchanged", async () => {
		const result = {
			items: [
				{
					storyId: "s1",
					identifier: "12",
					title: "Checkout",
					kind: "FEATURE",
					draftingStage: "DRAFT",
					maturationStatus: null,
					caseCount: 2,
					resultCounts: {
						NOT_RUN: 0,
						PASSED: 2,
						FAILED: 0,
						BLOCKED: 0,
					},
					distinctAcRefs: 1,
					coverageState: "COVERED",
				},
			],
			total: 1,
		};
		vi.mocked(listFeatureCoverage).mockResolvedValue(result as never);

		await expect(
			handler({ input: { projectId: "p1" }, context: ctx }),
		).resolves.toEqual(result);
	});
});
