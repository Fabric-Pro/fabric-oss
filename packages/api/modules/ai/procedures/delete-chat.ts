import { ORPCError } from "@orpc/client";
import { deleteAiChatForTenant } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses deleteAiChatForTenant() with XOR pattern
 * - Personal context: only user's personal chats (organizationId: null)
 * - Org context: only chats within that organization
 */
export const deleteChat = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "DELETE",
		path: "/ai/chats/{id}",
		tags: ["AI"],
		summary: "Delete chat",
		description: "Delete a chat by id",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { id } = input;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// XOR PATTERN: Tenant-filtered delete prevents cross-tenant access
		const deleted = await deleteAiChatForTenant({
			id,
			userId: context.user.id,
			organizationId,
		});

		if (!deleted) {
			throw new ORPCError("NOT_FOUND");
		}

		return { success: true };
	});
