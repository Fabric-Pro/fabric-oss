import { ORPCError } from "@orpc/server";
import {
	getScanFindingReview,
	hasProjectAccess,
	recordScanActivity,
	updateScanFinding,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Apply a user-confirmed subset of an AI review's proposals (G7). The review
 * only proposed changes; this is the explicit, never-automatic apply step. Each
 * decision is a per-finding status and/or severity change the user opted into;
 * they need not mirror the proposals one-to-one (the user may have edited a
 * verdict or applied only some).
 *
 * The review is verified to belong to the project first (tenant safety), then
 * each change is applied via the tenant-scoped `updateScanFinding`. Records ONE
 * `FINDINGS_REVIEWED` page-history entry. Permission mirrors triage edits
 * (PROJECT_UPDATE).
 */
export const applyReviewProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/review/apply",
		tags: ["Projects", "Security"],
		summary: "Apply confirmed proposals from an AI findings review",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			reviewId: z.string(),
			decisions: z
				.array(
					z
						.object({
							findingId: z.string(),
							status: z
								.enum(["OPEN", "RESOLVED", "DISMISSED"])
								.optional(),
							severity: z
								.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"])
								.optional(),
						})
						.refine(
							(d) =>
								d.status !== undefined ||
								d.severity !== undefined,
							{
								message:
									"Each decision needs a status or severity.",
							},
						),
				)
				.min(1)
				.max(500),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId, reviewId, decisions } = input;
		const hasAccess = await hasProjectAccess(
			projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// The review must belong to this project — guards against applying under a
		// review id from another project / tenant.
		const review = await getScanFindingReview(reviewId, projectId);
		if (!review) {
			throw new ORPCError("NOT_FOUND", { message: "Review not found" });
		}

		// Apply each confirmed change (tenant-scoped via updateScanFinding). A
		// finding that doesn't move (already at that value, or not in this
		// project) simply doesn't count toward `applied`.
		let applied = 0;
		for (const d of decisions) {
			const ok = await updateScanFinding(d.findingId, projectId, {
				status: d.status,
				severity: d.severity,
			});
			if (ok) {
				applied += 1;
			}
		}

		if (applied > 0) {
			await recordScanActivity({
				projectId,
				type: "FINDINGS_REVIEWED",
				userId: context.user.id,
				organizationId: organizationId ?? null,
				summary: `Applied AI review to ${applied} finding${
					applied === 1 ? "" : "s"
				}`,
			}).catch(() => {});
		}

		return { applied };
	});
