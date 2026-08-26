import {
	listTestCases,
	TEST_CASE_SORT_KEYS,
	TEST_CASE_STATES,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const listTestCasesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-cases",
		tags: ["Projects", "Test Cases"],
		summary: "List test cases",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			search: z.string().optional(),
			state: z.enum(TEST_CASE_STATES).optional(),
			priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
			tag: z.string().optional(),
			linkedStoryId: z.string().optional(),
			planId: z.string().optional(),
			automationStatus: z
				.enum(["NOT_AUTOMATED", "PLANNED", "AUTOMATED"])
				.optional(),
			currentResult: z
				.enum(["NOT_RUN", "PASSED", "FAILED", "BLOCKED", "SKIPPED"])
				.optional(),
			externalLinked: z.boolean().optional(),
			/**
			 * Ordering is applied in the DB so it holds across the whole result
			 * set. Omitted → `order` (the manual list order), each key falling
			 * back to its natural direction.
			 */
			sort: z.enum(TEST_CASE_SORT_KEYS).optional(),
			direction: z.enum(["asc", "desc"]).optional(),
			limit: z.number().int().min(1).max(200).optional(),
			offset: z.number().int().min(0).optional(),
			/**
			 * Return `summary` (state / automation / result tallies under the
			 * other filters, independent of `state`) for the redesigned segmented
			 * state control + stat strip. Correct across pagination.
			 */
			includeSummary: z.boolean().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates project
		// access; results are scoped to the project by the query layer.
		const { items, total, summary } = await listTestCases({
			projectId: input.projectId,
			search: input.search,
			state: input.state,
			priority: input.priority,
			tag: input.tag,
			linkedStoryId: input.linkedStoryId,
			planId: input.planId,
			automationStatus: input.automationStatus,
			currentResult: input.currentResult,
			externalLinked: input.externalLinked,
			sort: input.sort,
			direction: input.direction,
			limit: input.limit,
			offset: input.offset,
			includeSummary: input.includeSummary,
		});

		return { items, total, summary };
	});
