import { ORPCError } from "@orpc/client";
import { getContextSummaryById, hasProjectAccess } from "@repo/database";
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
 * One historical summary version's full content + references, for the history
 * viewer. Tenant + project scoped: the row is loaded under the caller's tenancy and
 * must belong to `projectId`. Any project member can read.
 */
export const getContextSummaryVersionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/summary/version",
		tags: ["Projects", "Contexts"],
		summary: "Get context summary version",
		description:
			"A specific historical summary version's content + references.",
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

		const row = await getContextSummaryById({
			id: input.summaryId,
			userId: user.id,
			organizationId,
		});
		if (!row || row.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", { message: "Summary not found" });
		}

		return { version: mapSummaryContent(row) };
	});
