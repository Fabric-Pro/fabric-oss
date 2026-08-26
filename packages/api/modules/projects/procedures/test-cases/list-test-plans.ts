import { computePlanPassRates, listTestPlans } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const listTestPlansProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-plans",
		tags: ["Projects", "Test Cases"],
		summary: "List test plans",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			search: z.string().optional(),
			state: z.enum(["ACTIVE", "INACTIVE"]).optional(),
			limit: z.number().int().min(1).max(200).optional(),
			offset: z.number().int().min(0).optional(),
			/**
			 * Attach each plan's `resultRollup` (pass-rate over its member cases'
			 * current results) — for the redesigned plan card grid. One batched
			 * query, not N+1.
			 */
			includePassRate: z.boolean().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates project
		// access; plans are scoped to the project by the query layer.
		const { items, total } = await listTestPlans({
			projectId: input.projectId,
			search: input.search,
			state: input.state,
			limit: input.limit,
			offset: input.offset,
		});

		// Consistent shape: every item carries `resultRollup` (null unless the
		// caller opted into the pass-rate rollup), so consumers read one field.
		const rollups = input.includePassRate
			? await computePlanPassRates(items.map((p) => p.id))
			: null;

		return {
			items: items.map((p) => ({
				...p,
				resultRollup: rollups?.get(p.id) ?? null,
			})),
			total,
		};
	});
