import { ORPCError } from "@orpc/client";
import {
	getLatestCompletedContextSummary,
	hasProjectAccess,
	parseSummaryReferences,
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
 * The project's current compressed summary content for the Context-tab
 * read-only view (and human/agent retrieval). Returns the latest COMPLETED,
 * non-superseded summary, or null. Any project member can read.
 */
export const getContextSummaryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/summary",
		tags: ["Projects", "Contexts"],
		summary: "Get context summary",
		description:
			"The project's current compressed context summary, if any.",
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

		const summary = await getLatestCompletedContextSummary({
			projectId: input.projectId,
			userId: user.id,
			organizationId,
		});

		return {
			summary: summary
				? {
						id: summary.id,
						content: summary.content,
						trigger: summary.trigger,
						coveredThrough: summary.coveredThrough,
						coveredContextCount: summary.coveredContextCount,
						tokenCount: summary.tokenCount,
						model: summary.model,
						createdAt: summary.createdAt,
						engineVersion: summary.engineVersion,
						// Source-level references so the reader can render inline
						// [S#] markers as links to the original context/decision.
						references: parseSummaryReferences(summary.references),
					}
				: null,
		};
	});
