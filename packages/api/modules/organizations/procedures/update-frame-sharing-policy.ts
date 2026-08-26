import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string(),
	canShareFramesPublicly: z.boolean(),
	allowedFrameShareDomains: z.array(z.string()).optional(),
});

const outputSchema = z.object({
	success: z.boolean(),
	canShareFramesPublicly: z.boolean(),
	allowedFrameShareDomains: z.array(z.string()),
});

/**
 * Update frame sharing policy for an organization
 *
 * Updates the organization's frame sharing settings.
 * Only organization admins/owners can modify this.
 */
export const updateFrameSharingPolicyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_UPDATE))
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/frame-sharing-policy",
		tags: ["Organizations"],
		summary: "Update frame sharing policy",
		description:
			"Update the frame sharing policy for an organization (admin only)",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const { db } = await import("@repo/database");

		// Verify user is admin/owner of the organization
		const membership = await db.member.findFirst({
			where: {
				organizationId: input.organizationId,
				userId: context.user.id,
				role: { in: ["owner", "admin"] },
			},
		});

		if (!membership) {
			throw new Error(
				"Only organization admins can update sharing policy",
			);
		}

		// Update the organization
		await db.organization.update({
			where: { id: input.organizationId },
			data: {
				canShareFramesPublicly: input.canShareFramesPublicly,
				allowedFrameShareDomains: input.allowedFrameShareDomains ?? [],
			},
		});

		// Audit-log emission. Frame-sharing policy is an
		// org-level setting, so we surface it as `org.settings.updated`
		// rather than `org.updated` (the latter covers name/slug/logo).
		recordAuditFromRequest(context, {
			action: "org.settings.updated",
			category: "org",
			organizationId: input.organizationId,
			resource: {
				type: "organization",
				id: input.organizationId,
				name: null,
			},
			metadata: {
				setting: "frame_sharing_policy",
				canShareFramesPublicly: input.canShareFramesPublicly,
				allowedFrameShareDomainsCount:
					input.allowedFrameShareDomains?.length ?? 0,
			},
		});

		return {
			success: true,
			canShareFramesPublicly: input.canShareFramesPublicly,
			allowedFrameShareDomains: input.allowedFrameShareDomains ?? [],
		};
	});
