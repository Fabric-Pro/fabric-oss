import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadSuggestionContext,
	suggestDecisionMetadata,
} from "../../lib/suggest-decision-metadata";

/**
 * AI suggestion of tagging metadata (type / duration / priority flag / owner)
 * for a decision being captured or edited. Read-only: a proposed type that
 * doesn't exist yet comes back as a name, and the save path mints the row.
 */
export const suggestDecisionMetadataProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ARCHITECTURE_DECISION_READ))
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/architecture-decisions/suggest-metadata",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Suggest decision type, duration, priority flag and owner",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1),
			decision: z.string().min(1),
			contextProblem: z.string().nullable().optional(),
			participantsText: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const { existingTypes, ownerCandidates } = await loadSuggestionContext(
			input.projectId,
		);

		const suggestion = await suggestDecisionMetadata({
			title: input.title,
			decision: input.decision,
			contextProblem: input.contextProblem ?? null,
			participantsText: input.participantsText ?? null,
			existingTypes,
			ownerCandidates,
			tenantFilter: {
				userId: context.user.id,
				organizationId,
			},
		});

		return { suggestion };
	});
