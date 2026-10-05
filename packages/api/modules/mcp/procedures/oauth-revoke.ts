/**
 * Revoke an MCP server config's OAuth access — the MCP server tile's
 * "Revoke access" (Fizzy #2859: the tile called a route that did not exist).
 *
 * Ownership: the config is looked up for the caller with the exclusive
 * tenant filter (`getMcpConfigById` with the caller's user id AND the
 * resolved organization), so another person's config, or the caller's own
 * config in another organization, is "not found".
 *
 * - `gitlab` / `gitlab-official`: these hold no credential of their own; the
 *   person's GitLab connection does. Revoke is the one personal GitLab
 *   disconnect (revocation at GitLab with the issuing client, best effort;
 *   rows, `enabled` and client registration kept; project repository links
 *   untouched; one audit row).
 * - Any other OAuth server: its access and refresh tokens are cleared
 *   (including the chained Atlassian Cloud tokens), keeping the row and its
 *   client registration so a reconnect reuses them. There is no provider-side
 *   revocation helper for MCP OAuth servers, so none is attempted; the
 *   response says so and the audit row records it.
 */

import { ORPCError } from "@orpc/server";
import {
	getMcpConfigById,
	isGitLabPersonalMcpServerKey,
	revokeOAuthTokens,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { disconnectPersonalGitLab } from "../../integrations/lib/gitlab-personal-disconnect";

const PROVIDER_REVOCATION_SKIPPED_WARNING =
	"Fabric no longer holds this server's tokens. They were not revoked at the provider, so remove Fabric's access in the provider's own settings if you need to end it there too.";

export const revokeMcpOAuthProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.MCP_CONNECT, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "DELETE",
		path: "/mcp/oauth/revoke/{configId}",
		tags: ["MCP"],
		summary: "Revoke an MCP config's OAuth access",
	})
	.input(
		z.object({
			configId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			revocationWarning: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		// `requireOrganization: true` above already refuses this, with the
		// marked missing-organization error; this only narrows the type.
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message: "An organization is required",
			});
		}

		const config = await getMcpConfigById(input.configId, {
			userId,
			organizationId,
		});
		if (!config) {
			throw new ORPCError("NOT_FOUND", {
				message: "MCP config not found",
			});
		}
		if (config.authType !== "OAUTH2") {
			throw new ORPCError("BAD_REQUEST", {
				message: "This MCP server is not connected with OAuth",
			});
		}

		const serverKey = config.mcpServer?.key ?? null;
		const name = config.displayName || config.mcpServer?.name || config.id;

		if (isGitLabPersonalMcpServerKey(serverKey)) {
			const { revocationWarning } = await disconnectPersonalGitLab({
				tenant: { userId, organizationId },
				surface: "mcp.oauth.revoke",
				audit: context,
				metadata: { mcpConfigId: config.id, serverKey },
			});
			return { success: true, revocationWarning };
		}

		// One update clears the server's tokens and any chained Atlassian
		// Cloud tokens together: a failure leaves both stored, never one.
		await revokeOAuthTokens(config.id, { userId, organizationId });

		recordAuditFromRequest(context, {
			action: "mcp.config.updated",
			category: "mcp",
			severity: "warning",
			organizationId,
			resource: { type: "mcp_config", id: config.id, name },
			metadata: {
				change: "oauth_tokens_revoked",
				serverKey,
				providerRevocation: "not-supported",
			},
		});

		return {
			success: true,
			revocationWarning: PROVIDER_REVOCATION_SKIPPED_WARNING,
		};
	});
