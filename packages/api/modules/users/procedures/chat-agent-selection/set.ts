import { upsertChatAgentSelection } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { ApiPersistedSelectedAgentSchema } from "./schema";

/**
 * Persist the Nexus agent selection. Fired by the picker on every
 * pick / unpick so the stored value tracks the user's current intent
 * (originally fired only on successful send — see CopilotPage.tsx
 * `handleToggleAgent` for the rationale). Idempotent — repeated calls
 * with the same array are value-level no-ops at the DB layer (only
 * `updatedAt` ticks).
 *
 * The input organization is resolved with the session fallback for older clients.
 * requireInputOrgPermission verifies membership and permission for that organization.
 *
 * Cap the array at 50 entries so a malformed client cannot persist an
 * arbitrarily large blob (defense-in-depth — the picker UI tops out far
 * below this in practice).
 */
export const setChatAgentSelectionProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.USER_UPDATE_SELF, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/users/chat-agent-selection",
		tags: ["Users"],
		summary: "Persist Nexus agent selection",
		description:
			"Stores the user's currently-picked agent array for the requested organization, or the session's active organization when omitted. Idempotent upsert.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1).optional(),
			selectedAgents: z.array(ApiPersistedSelectedAgentSchema).max(50),
		}),
	)
	.output(z.object({ success: z.boolean() }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		await upsertChatAgentSelection(
			context.user.id,
			{ selectedAgents: input.selectedAgents },
			organizationId,
		);

		return { success: true };
	});
