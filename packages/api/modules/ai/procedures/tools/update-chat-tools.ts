import { ORPCError } from "@orpc/client";
import {
	getMcpConfigById,
	replaceAiChatMcpConfigsForTenant,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Verifies chat ownership and MCP config tenant visibility before replacing the chat tool set.
 */
export const updateChatTools = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "PUT",
		path: "/ai/chats/{id}/tools",
		tags: ["AI"],
		summary: "Update chat tools",
		description:
			"Replace the MCP config IDs enabled for a Nexus conversation.",
	})
	.input(
		z.object({
			id: z.string(),
			toolSelectionMode: z.enum(["DEFAULT", "ONLY_SELECTED", "DISABLED"]),
			selectedMcpConfigIds: z.array(z.string()),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		for (const mcpConfigId of input.selectedMcpConfigIds) {
			const config = await getMcpConfigById(mcpConfigId, {
				userId: context.user.id,
				organizationId,
			});
			if (!config) {
				throw new ORPCError("NOT_FOUND", {
					message: `MCP config ${mcpConfigId} was not found in this context.`,
				});
			}
		}

		const selection = await replaceAiChatMcpConfigsForTenant({
			id: input.id,
			userId: context.user.id,
			organizationId,
			mcpConfigIds: input.selectedMcpConfigIds,
			toolSelectionMode: input.toolSelectionMode,
		});

		if (selection === null) {
			throw new ORPCError("NOT_FOUND");
		}

		return selection;
	});
