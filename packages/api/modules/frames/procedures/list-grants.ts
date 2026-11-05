import { ORPCError } from "@orpc/client";
import {
	canDeleteOrganizationFrames,
	getFrameById,
	listSharingGrants,
	publicSharingRefusal,
} from "@repo/database";
import { FrameShareScopeSchema } from "@repo/database/prisma/zod";
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
});

const outputSchema = z.object({
	grants: z.array(
		z.object({
			id: z.string(),
			email: z.string().nullable(),
			invitedBy: z.string(),
			invitedAt: z.string(),
			lastAccessedAt: z.string().nullable(),
			accessCount: z.number(),
		}),
	),
	shareScope: FrameShareScopeSchema,
	hasPublicLink: z.boolean(),
	canRevoke: z.boolean(),
	canShareFramesPublicly: z.boolean(),
	updatedAt: z.string(),
	shareToken: z.string().optional(),
});

/**
 * List sharing grants for a frame
 *
 * Returns all email-based sharing grants for the frame.
 * Only the frame owner can view grants.
 */
export const listFrameGrantsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/frames/{id}/grants",
		tags: ["Frames"],
		summary: "List sharing grants",
		description: "Get all email-based sharing grants for a frame",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify the frame exists and user owns it
		const frame = await getFrameById({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!frame) {
			throw new ORPCError("NOT_FOUND", { message: "Frame not found" });
		}

		// Get sharing grants
		const grants = await listSharingGrants(input.id);
		const canShareFramesPublicly = organizationId
			? !(await publicSharingRefusal(organizationId))
			: false;

		return {
			grants: grants.map((g) => ({
				id: g.id,
				email: g.email,
				invitedBy: g.invitedBy,
				invitedAt: g.invitedAt.toISOString(),
				lastAccessedAt: g.lastAccessedAt?.toISOString() ?? null,
				accessCount: g.accessCount,
			})),
			shareScope: frame.shareScope,
			canShareFramesPublicly,
			hasPublicLink: Boolean(frame.isPublic && frame.shareToken),
			canRevoke: organizationId
				? await canDeleteOrganizationFrames(
						context.user.id,
						organizationId,
					)
				: false,
			updatedAt: frame.updatedAt.toISOString(),
			...(canShareFramesPublicly &&
			frame.shareScope === "PUBLIC" &&
			frame.shareToken
				? { shareToken: frame.shareToken }
				: {}),
		};
	});
