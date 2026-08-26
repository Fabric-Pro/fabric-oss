import { ORPCError } from "@orpc/server";
import {
	getLatestScanFindingReview,
	hasProjectAccess,
	type ScanReviewProposal,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * The most-recent AI false-positive review run for a project (G7) — drives the
 * "Review findings" status + polling. Returns the latest review (any status)
 * with its `proposals`, or `null` when the project has never been reviewed.
 * Read-gated by project access.
 */
export const getReviewProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/scan/review/latest",
		tags: ["Projects", "Security"],
		summary: "Get the latest AI findings review",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId } = input;
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

		const review = await getLatestScanFindingReview(projectId);
		// `proposals` is a Prisma `Json?` column (inferred as JsonValue). Re-type it
		// to the proposal array shape so the oRPC client — and the UI types derived
		// from this contract — get a real `ScanReviewProposal[]`, not an opaque
		// JsonValue. The activities only ever persist this shape here.
		return {
			review: review
				? {
						...review,
						proposals: (review.proposals ??
							[]) as unknown as ScanReviewProposal[],
					}
				: null,
		};
	});
