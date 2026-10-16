import { shareFrame } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
	shareScope: z.enum([
		"PRIVATE",
		"EMAILS_ONLY",
		"WORKSPACE_AND_EMAILS",
		"PUBLIC",
	]),
});

const outputSchema = z.object({
	success: z.boolean(),
	shareToken: z.string().optional(),
	shareUrl: z.string().optional(),
	error: z.string().optional(),
});

/**
 * Update frame sharing scope
 *
 * Changes the sharing level of a frame:
 * - PRIVATE: Only owner can access
 * - EMAILS_ONLY: Only invited email addresses can access
 * - WORKSPACE_AND_EMAILS: Organization members + invited emails can access
 * - PUBLIC: Anyone with the link can access, when the organization allows it
 *
 * `shareFrame` owns the organization's sharing policy, the same command the
 * Fabric Agent's `fabric_share_frame` calls.
 */
export const shareFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/frames/{id}/share",
		tags: ["Frames"],
		summary: "Update frame sharing scope",
		description:
			"Change the sharing scope of a frame (private, emails-only, workspace, or public)",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const result = await shareFrame({
			frameId: input.id,
			userId: context.user.id,
			organizationId,
			scope: input.shareScope,
		});

		if (!result.ok) {
			return { success: false, error: result.message };
		}

		let shareUrl: string | undefined;
		if (result.shareToken) {
			const siteUrl =
				process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001";
			shareUrl = `${siteUrl}/share/frame/${result.shareToken}`;
		}

		return {
			success: true,
			shareToken: result.shareToken,
			shareUrl,
		};
	});
