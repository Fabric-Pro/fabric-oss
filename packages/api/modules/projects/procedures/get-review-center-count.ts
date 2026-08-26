import { ORPCError } from "@orpc/client";
import { getReviewCenterCount, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Review Center — actionable-only badge count.
 *
 * Counts open conflicts + FAILED/CONFLICT hierarchy rows + ADO pull-drift
 * (`PendingPmStateChange.status = PENDING`). Does **not** count `PmSyncLog`
 * rows (D-Q8) — the badge reflects work to do, not audit history. Live query
 * against existing per-item fields; reads are unaudited (D-Q11). Delegated to
 * `@repo/database` (`getReviewCenterCount`). Returns 0 cleanly.
 *
 * Gated on `STORY_UPDATE` (OWNER / PROJECT_ADMIN / EDITOR — spec §11.1).
 */
export const getReviewCenterCountProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/review-center/count",
		tags: ["Projects", "PM Sync"],
		summary: "Count Review Center actionable items",
		description:
			"Actionable-only count for the Review Center badge (conflicts + failed/conflict items + ADO pull-drift). Excludes PM sync log rows.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			conflictsCount: z.number().int(),
			failuresCount: z.number().int(),
			pullDriftCount: z.number().int(),
			total: z.number().int(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const tenant = organizationId
			? { organizationId }
			: { userId: user.id };

		return getReviewCenterCount({
			...tenant,
			projectId: input.projectId,
		});
	});
