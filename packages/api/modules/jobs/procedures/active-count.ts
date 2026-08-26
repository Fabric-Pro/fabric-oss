import { countActiveBackgroundJobs } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Running-job count for the navigation badge.
 *
 * Polled on a slow interval whether or not the panel is open, so it stays a
 * single indexed COUNT over a table the retention purge keeps small. No cache
 * layer: a Redis round trip would not beat the query it replaces.
 *
 * `requireInputOrgPermission` (not the plain `requirePermission`) because the
 * organization arrives from the client: it must be proven to be one the caller
 * belongs to before it is used as a filter.
 */
export const activeJobCountProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/jobs/active-count",
		tags: ["Jobs"],
		summary: "Count of currently running background jobs",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;

		const count = await countActiveBackgroundJobs({
			userId: context.user.id,
			organizationId,
		});

		return { count };
	});
