import { ORPCError } from "@orpc/client";
import { hasProjectAccess, restoreContextSummary } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertContextSummarizationEnabled } from "../../lib/context-summarization-feature";
import { mapSummaryContent } from "./summary-mappers";

/**
 * Restore a historical summary version as the current summary. Admin-only
 * (`PROJECT_SETTINGS_EDIT`). Non-destructive: creates a NEW current version copying
 * the chosen version's content + references, superseding the current head (a new
 * history entry). The restored-from row stays in history.
 */
export const restoreContextSummaryVersionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/summary/restore",
		tags: ["Projects", "Contexts"],
		summary: "Restore context summary version",
		description: "Make a historical summary version the current summary.",
	})
	.input(
		z.object({
			projectId: z.string(),
			summaryId: z.string(),
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

		const restored = await restoreContextSummary({
			projectId: input.projectId,
			tenancy: {
				userId: organizationId ? null : user.id,
				organizationId: organizationId ?? null,
			},
			restoredByUserId: user.id,
			versionId: input.summaryId,
		});
		if (!restored) {
			throw new ORPCError("NOT_FOUND", { message: "Summary not found" });
		}

		return { summary: mapSummaryContent(restored) };
	});
