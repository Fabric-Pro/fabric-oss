import { ORPCError } from "@orpc/client";
import { hasProjectAccess, listContextSummaries } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertContextSummarizationEnabled } from "../../lib/context-summarization-feature";
import { mapSummaryVersion } from "./summary-mappers";

/**
 * The project's summary history (newest first): every generated run and every
 * manual edit, each with its date, source selection, tokens spent, and origin — so
 * a member can review how the summary evolved and an admin can restore a version.
 * Any project member can read.
 */
export const listContextSummaryHistoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/summary/history",
		tags: ["Projects", "Contexts"],
		summary: "List context summary history",
		description:
			"Past context-summary versions (generated runs + manual edits) with dates and tokens spent.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			take: z.number().int().min(1).max(100).optional(),
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

		const rows = await listContextSummaries({
			projectId: input.projectId,
			userId: user.id,
			organizationId,
			take: input.take ?? 50,
		});

		return { versions: rows.map(mapSummaryVersion) };
	});
