import { listFeatureCoverage } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const listFeatureCoverageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/feature-test-coverage",
		tags: ["Projects", "Test Cases"],
		summary: "List work items with their test-coverage rollup",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** Type-ahead needle over identifier + title. */
			search: z.string().optional(),
			/**
			 * Omitted = both kinds. Callers pick their own default rather than the
			 * query imposing one — a feature picker wants FEATURE, a coverage list
			 * may want everything.
			 */
			kind: z.enum(["FEATURE", "BUG"]).optional(),
			uncoveredOnly: z.boolean().optional(),
			/**
			 * Drop work items sitting in a status the project flagged `isFinal`.
			 * Omitted = every status, so a coverage report keeps reporting on
			 * finished work; a picker asks for them to be dropped.
			 */
			excludeClosed: z.boolean().optional(),
			/**
			 * `STABLE` (default) is the createdAt order a paging reader needs to
			 * hold still. `UNCOVERED_FIRST` ranks untested work first, then most
			 * recently updated — what a picker offering somewhere to aim wants.
			 */
			order: z.enum(["STABLE", "UNCOVERED_FIRST"]).optional(),
			limit: z.number().int().min(1).max(200).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates project
		// access; the rollup counts only live cases in this project, and the
		// query is scoped to the project on both sides of the case↔story join.
		// Mirrors `coverageForStory` — this is its batched sibling.
		return listFeatureCoverage({
			projectId: input.projectId,
			search: input.search,
			kind: input.kind,
			uncoveredOnly: input.uncoveredOnly,
			excludeClosed: input.excludeClosed,
			order: input.order,
			limit: input.limit,
			offset: input.offset,
		});
	});
