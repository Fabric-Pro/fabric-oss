import { ORPCError } from "@orpc/client";
import { hasProjectAccess, listContextSummarySources } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertContextSummarizationEnabled,
	isCodeRepoSummarySourceEnabled,
} from "../../lib/context-summarization-feature";

/**
 * Candidate sources the manual-edit reference picker can cite: recent context
 * items, accepted decisions, active roadmap items, and — only when the code-repo
 * feature is enabled — connected repositories. Flag-aware and tenant scoped. Any
 * project member can read.
 */
export const listContextSummarySourcesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/summary/sources",
		tags: ["Projects", "Contexts"],
		summary: "List context summary sources",
		description:
			"Citable sources (context, decisions, roadmap, repos) for the manual-edit reference picker.",
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

		const candidates = await listContextSummarySources({
			projectId: input.projectId,
			tenancy: {
				userId: organizationId ? null : user.id,
				organizationId: organizationId ?? null,
			},
			includeCodeRepo: isCodeRepoSummarySourceEnabled(),
		});

		return { candidates };
	});
