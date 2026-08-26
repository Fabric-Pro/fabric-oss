import { searchTemplatesForMention } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

const searchForMentionInputSchema = z.object({
	query: z.string().optional(),
	organizationId: z.string().nullable().optional(),
	limit: z.number().min(1).max(20).default(10),
});

/**
 * Search templates for @mention autocomplete in chat.
 *
 * Returns templates matching the query, ordered by popularity.
 * Excludes workflow templates which have dedicated UIs (e.g., Deep Research is a built-in Nexus mode).
 */
export const searchForMentionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_READ))
	.input(searchForMentionInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if an organizationId is provided
		let verifiedOrgId: string | null = null;
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				context.user.id,
			);
			if (membership) {
				verifiedOrgId = organizationId;
			}
			// If not a member, don't include org templates (silently exclude)
		}

		const templates = await searchTemplatesForMention({
			query: input.query,
			userId: context.user.id,
			organizationId: verifiedOrgId,
			limit: input.limit,
		});

		return { templates };
	});
