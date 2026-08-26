import { type FrameShareScope, updateFrameShareScope } from "@repo/database";
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
 * - PUBLIC: Anyone with the link can access
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

		// Check organization policy for public sharing
		if (input.shareScope === "PUBLIC" && organizationId) {
			const { db } = await import("@repo/database");
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { canShareFramesPublicly: true },
			});

			if (!org?.canShareFramesPublicly) {
				return {
					success: false,
					error: "Public sharing is disabled for this organization",
				};
			}
		}

		const result = await updateFrameShareScope({
			frameId: input.id,
			userId: context.user.id,
			organizationId,
			shareScope: input.shareScope as FrameShareScope,
		});

		if (!result.success) {
			return {
				success: false,
				error: result.error,
			};
		}

		// Generate share URL for public sharing
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
