import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertContextSummarizationEnabled } from "../../lib/context-summarization-feature";

/**
 * Cancel a project's in-flight summarization run. Admin-only
 * (`PROJECT_SETTINGS_EDIT`). Requests Temporal cancellation of the deterministic
 * workflow (its cancellation scope flips the row CANCELLED and leaves the prior
 * COMPLETED summary intact) and, belt-and-suspenders, flips a still-running row so
 * it never lingers. Idempotent — a no-op when nothing is running.
 */
export const cancelContextSummaryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/summary/cancel",
		tags: ["Projects", "Contexts"],
		summary: "Cancel context summary",
		description: "Cancel the project's in-flight context-summary run.",
	})
	.input(
		z.object({
			projectId: z.string(),
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

		const { cancelContextSummarizationWorkflow } = await import(
			"@repo/temporal"
		);
		const { cancelled } = await cancelContextSummarizationWorkflow({
			projectId: input.projectId,
			userId: organizationId ? null : user.id,
			organizationId: organizationId ?? null,
		});

		return { cancelled };
	});
