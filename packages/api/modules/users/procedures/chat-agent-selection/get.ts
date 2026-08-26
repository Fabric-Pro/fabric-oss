import { z } from "zod";
import { getOrganizationIdFromContext } from "../../../../orpc/middleware/tenant-context-middleware";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { ApiPersistedSelectedAgentSchema } from "./schema";
import { fetchChatAgentSelectionForUser } from "./server-fetch";

/**
 * Read the persisted Nexus agent selection for the current
 * (user × organization) context.
 *
 * `tenantProtectedProcedure` + `getOrganizationIdFromContext` resolves the
 * tenant — the handler MUST NOT hand-roll its own organizationId filter
 * (CLAUDE.md "Multi-Tenant XOR Pattern").
 *
 * The actual read + validate + empty-cleanup logic lives in
 * `fetchChatAgentSelectionForUser` so that SSR `initialData` hydration in the
 * Nexus page server components can call the same code path without going
 * through HTTP. The handler stays a thin wrapper that resolves tenant from
 * the orpc context.
 */
export const getChatAgentSelectionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/users/chat-agent-selection",
		tags: ["Users"],
		summary: "Get persisted Nexus agent selection",
		description:
			"Returns the user's last-sent agent array for the current (user, organization) context, after dropping entries whose targets no longer resolve.",
	})
	.output(
		z.object({
			exists: z.boolean(),
			version: z.number().int(),
			selectedAgents: z.array(ApiPersistedSelectedAgentSchema),
			droppedCount: z.number().int().min(0),
			defaultAgent: ApiPersistedSelectedAgentSchema.nullable(),
		}),
	)
	.handler(async ({ context }) => {
		const organizationId = getOrganizationIdFromContext(
			context.tenantContext,
		);
		return fetchChatAgentSelectionForUser(context.user.id, organizationId);
	});
