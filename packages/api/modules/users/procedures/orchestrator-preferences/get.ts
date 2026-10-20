import { getOrchestratorPreferences } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getOrchestratorPreferencesProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.USER_READ_SELF, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/users/orchestrator-preferences",
		tags: ["Users"],
		summary: "Get user orchestrator preferences",
		description:
			"Get the current user's orchestrator preferences (enabled MCP servers, agents, workspaces, modes) for the requested organization, or the session's active organization when omitted.",
	})
	.input(
		z.object({ organizationId: z.string().min(1).optional() }).default({}),
	)
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
	.handler(async ({ input, context }) => {
		// Resolve the same organization authorized by requireInputOrgPermission.
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
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
