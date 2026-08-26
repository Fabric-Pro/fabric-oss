import { getOrchestratorPreferences } from "@repo/database";
import { z } from "zod";
import { getOrganizationIdFromContext } from "../../../../orpc/middleware/tenant-context-middleware";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getOrchestratorPreferencesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/users/orchestrator-preferences",
		tags: ["Users"],
		summary: "Get user orchestrator preferences",
		description:
			"Get the current user's orchestrator preferences (enabled MCP servers, agents, workspaces, modes) for the active (user × organization) context.",
	})
	.output(
		z.object({
			exists: z.boolean(),
			enabledMcpConfigIds: z.array(z.string()),
			enabledAgentIds: z.array(z.string()),
			enabledWorkspaceIds: z.array(z.string()),
			autonomyLevel: z.enum(["CONSERVATIVE", "BALANCED", "AUTONOMOUS"]),
			chatMode: z.enum(["direct", "orchestrator", "research"]),
			reasoningMode: z.enum(["lite", "balanced", "deep", "planner"]),
			uiMode: z.enum(["simple", "advanced"]),
		}),
	)
	.handler(async ({ context }) => {
		// XOR isolation: per (user × organization). Personal context maps
		// to the org-id="" row; each org keeps its own row per user. Mirrors
		// the chat-agent-selection isolation model so the same user can have
		// different Loom mode / reasoning preferences across orgs they're
		// in. Earlier behavior was per-user-only (the `organizationId` arg
		// was never passed) and silently shared one row across all
		// (user × org) pairs — diverging from `UserChatAgentSelection`'s
		// stated invariant.
		const organizationId = getOrganizationIdFromContext(
			context.tenantContext,
		);
		const prefs = await getOrchestratorPreferences(
			context.user.id,
			organizationId,
		);

		if (!prefs) {
			return {
				exists: false,
				enabledMcpConfigIds: [],
				enabledAgentIds: [],
				enabledWorkspaceIds: [],
				autonomyLevel: "BALANCED" as const,
				chatMode: "orchestrator" as const,
				reasoningMode: "balanced" as const,
				uiMode: "simple" as const,
			};
		}

		return {
			exists: true,
			enabledMcpConfigIds: prefs.enabledMcpConfigIds,
			enabledAgentIds: prefs.enabledAgentIds,
			enabledWorkspaceIds: prefs.enabledWorkspaceIds,
			autonomyLevel: prefs.autonomyLevel,
			chatMode: prefs.chatMode,
			reasoningMode: prefs.reasoningMode,
			uiMode: prefs.uiMode,
		};
	});
