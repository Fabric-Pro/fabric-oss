import { getOrganizationById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string(),
});

const outputSchema = z.object({
	canShareFramesPublicly: z.boolean(),
	allowedFrameShareDomains: z.array(z.string()),
});

/**
 * Get frame sharing policy for an organization
 *
 * Returns the organization's frame sharing settings.
 * Only organization members can view this.
 */
export const getFrameSharingPolicyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/frame-sharing-policy",
		tags: ["Organizations"],
		summary: "Get frame sharing policy",
		description: "Get the frame sharing policy for an organization",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		// Verify user is member of the organization
		const { getOrganizationMembership } = await import("@repo/database");
		const membership = await getOrganizationMembership(
			input.organizationId,
			context.user.id,
		);

		if (!membership) {
			throw new Error("You are not a member of this organization");
		}

		const org = await getOrganizationById(input.organizationId);

		if (!org) {
			throw new Error("Organization not found");
		}

		return {
			canShareFramesPublicly: org.canShareFramesPublicly ?? true,
			allowedFrameShareDomains: org.allowedFrameShareDomains ?? [],
		};
	});
