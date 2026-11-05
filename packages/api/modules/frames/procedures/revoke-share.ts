import { ORPCError } from "@orpc/client";
import { revokeFrameSharing } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { frameRevisionSchema } from "../lib/frame-edit-contract";
import { frameEditErrors } from "../lib/frame-edit-errors";

const inputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
	mode: z.enum(["public-link", "all"]).default("public-link"),
	expectedUpdatedAt: frameRevisionSchema.optional(),
});

export const revokeFrameShareProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_DELETE))
	.use(frameEditErrors)
	.route({
		method: "POST",
		path: "/frames/{id}/revoke-share",
		tags: ["Frames"],
		summary: "Revoke frame share",
		description: "Disable public sharing for a Frame",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const result = await revokeFrameSharing({
			frameId: input.id,
			userId: context.user.id,
			organizationId,
			mode: input.mode ?? "public-link",
			expectedUpdatedAt: input.expectedUpdatedAt
				? new Date(input.expectedUpdatedAt)
				: undefined,
		});
		if (!result?.ok) {
			throw new ORPCError("NOT_FOUND", { message: "Frame not found" });
		}
		return {
			id: input.id,
			shareToken: null,
			isPublic: false,
			shareScope: result.scope,
			revokedInvitations: result.revokedInvitations,
			updatedAt: result.updatedAt.toISOString(),
		};
	});
