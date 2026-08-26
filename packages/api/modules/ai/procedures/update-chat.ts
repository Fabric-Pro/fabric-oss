import { ORPCError } from "@orpc/client";
import { updateAiChatForTenant } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses updateAiChatForTenant() with XOR pattern
 * - Personal context: only user's personal chats (organizationId: null)
 * - Org context: only chats within that organization
 */
export const updateChat = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "PUT",
		path: "/ai/chats/{id}",
		tags: ["AI"],
		summary: "Update chat",
		description: "Update a chat by id",
	})
	.input(
		z.object({
			id: z.string(),
			title: z.string().optional(),
			pinned: z.boolean().optional(),
			messages: z.array(z.record(z.string(), z.unknown())).optional(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { id, title, pinned, messages } = input;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// XOR PATTERN: Tenant-filtered update prevents cross-tenant access
		const updatedChat = await updateAiChatForTenant({
			id,
			userId: context.user.id,
			organizationId,
			title,
			pinned,
			messages: messages as Array<object> | undefined,
		});

		if (!updatedChat) {
			throw new ORPCError("NOT_FOUND");
		}

		return { chat: updatedChat };
	});
