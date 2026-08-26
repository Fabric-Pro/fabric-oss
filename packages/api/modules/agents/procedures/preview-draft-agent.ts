/**
 * Preview Draft Agent Procedure
 *
 * Runs a single agent turn using inline configuration (instructions, model,
 * capabilityIds, mcpConfigIds) without requiring the agent to be saved or
 * registered in globalAgentRegistry.
 *
 * This enables live preview for:
 * - Unsaved draft agents
 * - User-created agents (DB-backed, not in memory registry)
 * - Org-scoped agents (which globalAgentRegistry does not hold)
 *
 * AUTHORIZATION: Tenant-isolated — uses tenantProtectedProcedure.
 */

import { ORPCError } from "@orpc/server";
import { previewAgentTurn } from "@repo/temporal/activities";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure — verifies userId + session.
 * MCP config IDs are tenant-filtered inside loadMcpToolsForAgent.
 */
export const previewDraftAgent = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "POST",
		path: "/agents/preview-draft",
		tags: ["Agents"],
		summary: "Preview a draft agent",
		description:
			"Runs a single agent turn with inline configuration for live preview. Works for unsaved drafts, user-created agents, and org-scoped agents.",
	})
	.input(
		z.object({
			/** The agent's system prompt / instructions */
			systemPrompt: z.string(),
			/** User test message */
			userMessage: z.string().min(1),
			/** Optional model override (canonical name) */
			model: z.string().optional(),
			/** Capability IDs (e.g. "web-search-browse", "agent-memory") used as built-in tool names */
			capabilityIds: z.array(z.string()).optional(),
			/** MCP config IDs to load tools from */
			mcpConfigIds: z.array(z.string()).optional(),
			/** Max tool iterations (capped at 5 for preview) */
			maxIterations: z.number().min(1).max(5).optional(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			response: z.string(),
			success: z.boolean(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		try {
			const result = await previewAgentTurn({
				systemPrompt: input.systemPrompt,
				userMessage: input.userMessage,
				model: input.model,
				mcpConfigIds: input.mcpConfigIds ?? [],
				// Capability IDs are used directly as built-in tool names
				// e.g. "web-search-browse" → fabric_web_search etc. via BUILT_IN_TOOL_MAP
				builtInToolNames: input.capabilityIds ?? [],
				userId: user.id,
				organizationId: organizationId ?? undefined,
				maxIterations: input.maxIterations ?? 5,
				timeoutMs: 30_000,
			});

			return result;
		} catch (error) {
			console.error("[agents.previewDraft] Preview failed", {
				error,
				userId: user.id,
				organizationId: organizationId ?? null,
				capabilityIds: input.capabilityIds ?? [],
				mcpConfigIds: input.mcpConfigIds ?? [],
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Preview failed",
			});
		}
	});
