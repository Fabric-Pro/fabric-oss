import { ORPCError } from "@orpc/client";
import type { UIMessage } from "@repo/ai";
import { getAiChatByIdForTenant } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses getAiChatByIdForTenant() with XOR pattern
 * - Personal context: only user's personal chats (organizationId: null)
 * - Org context: only chats within that organization
 */
export const findChat = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "GET",
		path: "/ai/chats/{id}",
		tags: ["AI"],
		summary: "Get chat",
		description: "Get a chat by id",
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

		// XOR PATTERN: Tenant-filtered query prevents data leakage
		const chat = await getAiChatByIdForTenant({
			id,
			userId: context.user.id,
			organizationId,
		});

		if (!chat) {
			throw new ORPCError("NOT_FOUND");
		}

		return {
			chat: {
				...chat,
				messages: (chat.messages ?? []) as unknown as UIMessage[],
			},
		};
	});
