import { upsertChatAgentSelection } from "@repo/database";
import { z } from "zod";
import { getOrganizationIdFromContext } from "../../../../orpc/middleware/tenant-context-middleware";
import {
	Permissions,
	requirePermission,
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
 * `tenantProtectedProcedure` + `getOrganizationIdFromContext` resolves the
 * tenant — the handler MUST NOT hand-roll its own organizationId filter
 * (CLAUDE.md "Multi-Tenant XOR Pattern").
 *
 * Cap the array at 50 entries so a malformed client cannot persist an
 * arbitrarily large blob (defense-in-depth — the picker UI tops out far
 * below this in practice).
 */
export const setChatAgentSelectionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/users/chat-agent-selection",
		tags: ["Users"],
		summary: "Persist Nexus agent selection",
		description:
			"Stores the user's currently-picked agent array for the current (user, organization) context. Idempotent upsert.",
	})
	.input(
		z.object({
			selectedAgents: z.array(ApiPersistedSelectedAgentSchema).max(50),
		}),
	)
	.output(z.object({ success: z.boolean() }))
	.handler(async ({ input, context }) => {
		const organizationId = getOrganizationIdFromContext(
			context.tenantContext,
		);

		await upsertChatAgentSelection(
			context.user.id,
			{ selectedAgents: input.selectedAgents },
			organizationId,
		);

		return { success: true };
	});
