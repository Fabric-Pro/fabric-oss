/**
 * Revoke Connected Agent Procedure
 *
 * Ends an agent's access: its consent and every access and refresh token issued
 * under it are deleted together, so the agent's next request is refused rather
 * than served until its token would have expired. Scoped to the caller: a
 * consent id that is not theirs behaves exactly like one that does not exist.
 */

import { ORPCError } from "@orpc/server";
import { revokeOAuthConnection } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const revokeOAuthConnectionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "DELETE",
		path: "/users/oauth-connections/{consentId}",
		tags: ["Users", "Connected agents"],
		summary: "Revoke a connected agent",
		description:
			"Remove an agent's consent and every token issued under it.",
	})
	.input(z.object({ consentId: z.string().min(1) }))
	.output(z.object({ success: z.literal(true) }))
	.handler(async ({ context, input }) => {
		const revoked = await revokeOAuthConnection({
			userId: context.user.id,
			consentId: input.consentId,
		});

		if (!revoked) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connected agent not found",
			});
		}

		recordAuditFromRequest(context, {
			action: "account.oauth.consent_revoked",
			category: "account",
			outcome: "success",
			severity: "info",
			organizationId: revoked.organizationId,
			// The public client id, as the grant's audit row records it, so
			// approval and revocation of one agent read as one resource.
			resource: {
				type: "oauth_client",
				id: revoked.clientId,
				name: revoked.clientName,
			},
			metadata: { consentId: input.consentId },
		});

		return { success: true as const };
	});
