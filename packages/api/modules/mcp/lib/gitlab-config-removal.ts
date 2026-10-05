/**
 * "Delete" for a GitLab personal MCP server config (`gitlab`,
 * `gitlab-official`), from the MCP server tile or the REST API.
 *
 * These rows hold no credential of their own: the person's GitLab connection
 * does, and the `gitlab-official` row can hold the dynamic client
 * registration that issued it. Hard-deleting the row would leave the
 * connection alive behind a missing tile and throw away the registration a
 * reconnect reuses. So Delete here is the one personal GitLab disconnect with
 * `enabled: false` for this config, written in the disconnect's own
 * transaction (see `disconnectPersonalGitLab`), and the row — with its
 * registration — is kept. It is recorded as one audit event, the disconnect,
 * carrying the config id and whether it was turned off.
 *
 * Project repository links are untouched: neither this nor the shared
 * disconnect writes them.
 */

import type { DisconnectGitLabResult } from "@repo/integrations/gitlab";
import type {
	AuditRequestContext,
	RecordAuditFromRequestInput,
} from "../../../lib/audit";
import {
	disconnectPersonalGitLab,
	type GitLabDisconnectSurface,
} from "../../integrations/lib/gitlab-personal-disconnect";

export type GitLabPersonalMcpConfig = {
	id: string;
	userId: string | null;
	organizationId: string | null;
	displayName?: string | null;
	mcpServer?: { key?: string | null; name?: string | null } | null;
};

export async function removeGitLabPersonalMcpConfig(args: {
	/** A config already looked up for the caller with the exclusive tenant filter. */
	config: GitLabPersonalMcpConfig;
	surface: Extract<
		GitLabDisconnectSurface,
		"mcp.configs.delete" | "v1.mcp.configs.delete"
	>;
	audit: AuditRequestContext;
	actor?: RecordAuditFromRequestInput["actor"];
}): Promise<DisconnectGitLabResult & { mcpConfigDisabled: boolean }> {
	const { config } = args;
	const serverKey = config.mcpServer?.key ?? null;
	if (!config.userId || !config.organizationId || !serverKey) {
		// A GitLab personal config belongs to one person in one organization;
		// without both there is no connection to disconnect, so refuse rather
		// than guess one (or write a no-organization tenant).
		throw new Error(
			"A GitLab MCP config without an owner and an organization cannot be removed",
		);
	}

	return disconnectPersonalGitLab({
		tenant: {
			userId: config.userId,
			organizationId: config.organizationId,
		},
		surface: args.surface,
		audit: args.audit,
		actor: args.actor,
		disableMcpConfig: { id: config.id, serverKey },
	});
}
