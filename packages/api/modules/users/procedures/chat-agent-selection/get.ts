import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { ApiPersistedSelectedAgentSchema } from "./schema";
import { fetchChatAgentSelectionForUser } from "./server-fetch";

/**
 * Read the persisted Nexus agent selection for the current
 * (user × organization) context.
 *
 * The input organization is resolved with the session fallback for older clients.
 * requireInputOrgPermission verifies membership and permission for that organization.
 *
 * The actual read + validate + empty-cleanup logic lives in
 * `fetchChatAgentSelectionForUser` so that SSR `initialData` hydration in the
 * Nexus page server components can call the same code path without going
 * through HTTP. The handler stays a thin wrapper that resolves tenant from
 * the orpc context.
 */
export const getChatAgentSelectionProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.USER_READ_SELF, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/users/chat-agent-selection",
		tags: ["Users"],
		summary: "Get persisted Nexus agent selection",
		description:
			"Returns the user's last-sent agent array for the requested organization, or the session's active organization when omitted, after dropping entries whose targets no longer resolve.",
	})
	.input(
		z.object({ organizationId: z.string().min(1).optional() }).default({}),
	)
	.output(
		z.object({
			exists: z.boolean(),
			version: z.number().int(),
			selectedAgents: z.array(ApiPersistedSelectedAgentSchema),
			droppedCount: z.number().int().min(0),
			defaultAgent: ApiPersistedSelectedAgentSchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		return fetchChatAgentSelectionForUser(
			context.user.id,
			organizationId ?? null,
		);
	});
