import { ORPCError } from "@orpc/client";
import {
	hasProjectAccess,
	resolveContextSummaryReference,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertContextSummarizationEnabled } from "../../lib/context-summarization-feature";

/**
 * Canonical, authorized drill-down from a summary reference to its original
 * source. Powers both staff drill-down (the reader's clickable `[S#]` markers)
 * and tool-enabled AI drill-down (resolve a cited marker to the raw source).
 *
 * Tenant + project isolation is enforced end-to-end: the caller must have access
 * to `projectId`, the summary is loaded under the caller's tenancy, the summary
 * must belong to `projectId`, the source must belong to that same project +
 * tenancy, and only a `sourceId` the summary actually cites resolves — so a
 * reference can never resolve across tenants or projects, and an invented /
 * non-cited id returns NOT_FOUND.
 */
export const resolveContextSummaryReferenceProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/summary/reference",
		tags: ["Projects", "Contexts"],
		summary: "Resolve context summary reference",
		description:
			"Resolve a summary [S#] reference to the original raw context or decision it cites.",
	})
	.input(
		z.object({
			projectId: z.string(),
			summaryId: z.string(),
			sourceId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertContextSummarizationEnabled();
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

		const reference = await resolveContextSummaryReference({
			summaryId: input.summaryId,
			sourceId: input.sourceId,
			projectId: input.projectId,
			userId: user.id,
			organizationId,
		});
		if (!reference) {
			throw new ORPCError("NOT_FOUND", {
				message: "Reference not found",
			});
		}

		return { reference };
	});
