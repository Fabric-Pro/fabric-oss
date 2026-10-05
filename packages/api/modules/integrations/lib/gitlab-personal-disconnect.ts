/**
 * The one personal GitLab disconnect, for every surface that offers one.
 *
 * The integration settings (`gitlab.disconnect`), the generic OAuth
 * disconnect, the generic workflow-integration delete and disconnect-by-type,
 * the MCP server tile's Delete and Revoke, and the REST API's MCP config
 * delete all call this, so they all do the same thing:
 *
 *   1. `disconnectGitLabConnection` (the connection service's core), in one
 *      transaction under the connection's lifecycle lock:
 *        - bump the connection's generation, empty its credential and
 *          deactivate every personal row; clear the token columns of the
 *          person's `gitlab` / `gitlab-official` MCP configs while keeping
 *          the rows, `enabled` and their client registrations;
 *        - mark the person's own GitLab Data Connections in that tenant
 *          EXPIRED and clear any legacy token copy or assigned credential on
 *          them (`GITLAB_DATA_CONNECTION_CLEARED_TOKENS`, shared with the
 *          other GitLab Data Connection writers). Only rows owned by the
 *          person match (the exclusive filter below); an organization's Data
 *          Connection belongs to the organization and is left alone;
 *        - for the MCP tile's Delete, turn that one config off
 *          (`enabled: false`), keeping the row and its registration.
 *      Then, after the commit, revoke at GitLab with the issuing client,
 *      best effort.
 *   2. Write one `org.integration.disconnected` audit row. The core writes
 *      none, so this is the only one for the connection; a tile Delete's
 *      `enabled: false` is recorded on it rather than as a second event.
 *   3. Drop the cached MCP registry list so the tile refreshes.
 *
 * Why the Data Connection and `enabled` writes are inside the transaction: a
 * reconnect takes the same lifecycle lock. Written after the commit (as they
 * once were), a reconnect that completed in between — during revocation,
 * say — was followed by this disconnect's late writes, leaving a connected
 * person with an expired Data Connection and a disabled server. Inside the
 * transaction they either land before the reconnect or not at all. If one of
 * them fails, the whole disconnect rolls back and the request fails: nothing
 * is left half-disconnected, and the person retries. Both properties are
 * checked in `__tests__/procedures/gitlab-one-disconnect.test.ts`.
 *
 * Steps 2 and 3 run after the commit. The audit write is fire-and-forget
 * (`recordAuditFromRequest`); a cache failure is logged, and the cached
 * entry expires on its own.
 *
 * A Data Connection is only ever marked here, never deleted, and deleting one
 * does not come back through here (also checked in the test above). Project
 * repository links (`ProjectRepositoryIntegration`) are team grants with
 * their own tokens: neither this nor the core touches them.
 */

import { isGitLabPersonalMcpServerKey } from "@repo/database";
import {
	type DisconnectGitLabResult,
	disconnectGitLabConnection,
	type GitLabTenant,
} from "@repo/integrations/gitlab";
import {
	type AuditRequestContext,
	type RecordAuditFromRequestInput,
	recordAuditFromRequest,
} from "../../../lib/audit";
import { GITLAB_DATA_CONNECTION_CLEARED_TOKENS } from "../../data-connections/lib/gitlab-data-connection";

/** Where a personal GitLab disconnect came from; recorded on the audit row. */
export type GitLabDisconnectSurface =
	| "integrations.gitlab.disconnect"
	| "integrations.oauth.disconnect"
	| "workflows.integrations.delete"
	| "workflows.integrations.disconnectByType"
	| "mcp.configs.delete"
	| "mcp.oauth.revoke"
	| "v1.mcp.configs.delete";

/** The person's GitLab MCP config the tile's Delete also turns off. */
type McpConfigToDisable = {
	id: string;
	serverKey: string;
};

export async function disconnectPersonalGitLab(args: {
	tenant: GitLabTenant;
	surface: GitLabDisconnectSurface;
	/** The request the disconnect came from, for the audit row. */
	audit: AuditRequestContext;
	/** Overrides the audit actor (the REST API's key-backed caller). */
	actor?: RecordAuditFromRequestInput["actor"];
	/** Extra, non-secret audit metadata (for example the MCP config id). */
	metadata?: Record<string, unknown>;
	/**
	 * The MCP tile's (or REST API's) Delete: also turn this config off, in
	 * the same transaction. It must be one of the person's own GitLab
	 * personal configs in this tenant; anything else is left alone.
	 */
	disableMcpConfig?: McpConfigToDisable;
}): Promise<DisconnectGitLabResult & { mcpConfigDisabled: boolean }> {
	const { tenant } = args;
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId, userId: tenant.userId }
		: { organizationId: null, userId: tenant.userId };

	let mcpConfigDisabled = false;
	const result = await disconnectGitLabConnection(tenant, undefined, {
		withinDisconnect: async (tx) => {
			await tx.dataConnection.updateMany({
				where: { ...tenantFilter, provider: "GITLAB" },
				data: {
					status: "EXPIRED",
					...GITLAB_DATA_CONNECTION_CLEARED_TOKENS,
				},
			} as never);
			const target = args.disableMcpConfig;
			if (target && isGitLabPersonalMcpServerKey(target.serverKey)) {
				const disabled = (await tx.mCPConfig.updateMany({
					where: {
						id: target.id,
						...tenantFilter,
						mcpServer: { key: target.serverKey },
					},
					data: { enabled: false },
				} as never)) as { count: number };
				mcpConfigDisabled = disabled.count > 0;
			}
		},
	});

	recordAuditFromRequest(args.audit, {
		action: "org.integration.disconnected",
		category: "org",
		organizationId: tenant.organizationId,
		...(args.actor ? { actor: args.actor } : {}),
		resource: {
			type: "gitlab_connection",
			id: result.integrationIds[0] ?? null,
			name: "GitLab",
		},
		metadata: {
			provider: "GITLAB",
			surface: args.surface,
			revocationIncomplete: result.revocationWarning !== null,
			...(args.disableMcpConfig
				? {
						mcpConfigId: args.disableMcpConfig.id,
						serverKey: args.disableMcpConfig.serverKey,
						mcpConfigDisabled,
					}
				: {}),
			...(args.metadata ?? {}),
		},
	});

	try {
		const { invalidateSystemServersCache } = await import(
			"../../../lib/mcp-registry-cache"
		);
		await invalidateSystemServersCache();
	} catch (error) {
		// Non-fatal: the cached entry expires on its own within its TTL.
		console.warn("[GitLab disconnect] cache invalidation failed", error);
	}

	return { ...result, mcpConfigDisabled };
}
