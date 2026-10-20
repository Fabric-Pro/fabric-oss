import { upsertOrchestratorPreferences } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const updateOrchestratorPreferencesProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.USER_UPDATE_SELF, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/users/orchestrator-preferences",
		tags: ["Users"],
		summary: "Update user orchestrator preferences",
		description:
			"Update the current user's orchestrator preferences for the requested organization, or the session's active organization when omitted.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1).optional(),
			enabledMcpConfigIds: z.array(z.string()).optional(),
			enabledAgentIds: z.array(z.string()).optional(),
			enabledWorkspaceIds: z.array(z.string()).optional(),
			autonomyLevel: z
				.enum(["CONSERVATIVE", "BALANCED", "AUTONOMOUS"])
				.optional(),
			chatMode: z.enum(["direct", "orchestrator", "research"]).optional(),
			reasoningMode: z
				.enum(["lite", "balanced", "deep", "planner"])
				.optional(),
			uiMode: z.enum(["simple", "advanced"]).optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
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
		const prefs = await upsertOrchestratorPreferences(
			context.user.id,
			{
				enabledMcpConfigIds: input.enabledMcpConfigIds,
				enabledAgentIds: input.enabledAgentIds,
				enabledWorkspaceIds: input.enabledWorkspaceIds,
				autonomyLevel: input.autonomyLevel,
				chatMode: input.chatMode,
				reasoningMode: input.reasoningMode,
				uiMode: input.uiMode,
			},
			organizationId,
		);

		return {
			success: true,
			enabledMcpConfigIds: prefs.enabledMcpConfigIds,
			enabledAgentIds: prefs.enabledAgentIds,
			enabledWorkspaceIds: prefs.enabledWorkspaceIds,
			autonomyLevel: prefs.autonomyLevel,
			chatMode: prefs.chatMode,
			reasoningMode: prefs.reasoningMode,
			uiMode: prefs.uiMode,
		};
	});
