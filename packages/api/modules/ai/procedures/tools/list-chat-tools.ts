import { ORPCError } from "@orpc/client";
import { getAiChatToolSelectionForTenant } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses tenant-filtered AI chat lookup before returning chat tool overrides.
 */
export const listChatTools = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "GET",
		path: "/ai/chats/{id}/tools",
		tags: ["AI"],
		summary: "List chat tools",
		description: "Get the MCP config IDs enabled for a Nexus conversation.",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const selection = await getAiChatToolSelectionForTenant({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (selection === null) {
			throw new ORPCError("NOT_FOUND");
		}

		return selection;
	});
