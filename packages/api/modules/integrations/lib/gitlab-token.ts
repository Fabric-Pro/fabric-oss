/**
 * API-layer composition for writing a person's GitLab connection.
 *
 * The credential itself is owned by the connection service in
 * `@repo/integrations/gitlab` (`connectGitLab`, `getGitLabConnectionToken`,
 * `refreshGitLabConnection`): one encrypted credential on the person's
 * `WorkflowIntegration`, carrying the issuing client, under one lifecycle
 * lock and a generation fence. This module adds what only the API layer
 * decides around a connect: the MCP capability probe, the `gitlab-official`
 * MCPConfig capability sync, and the `gitlab` registry row the MCP page lists.
 *
 * Nothing here writes a token to an MCPConfig. On GitLab configs those
 * columns are empty (migration 20261004120000 nulled the legacy copies);
 * the connection service never reads them and clears them again on
 * disconnect.
 */
import {
	connectGitLab,
	type GitLabConnectionDb,
	type GitLabConnectionDeps,
	type GitLabIssuer,
	GitLabReauthRequiredError,
	probeGitLabMcp,
} from "@repo/integrations/gitlab";
import {
	type SyncTx,
	syncGitlabOfficialMcpConfig,
} from "./sync-gitlab-official-mcp";

export { GitLabReauthRequiredError };

export type GitLabTokenCtx = {
	userId: string;
	organizationId: string | null;
};

type GitLabUserIdentity = {
	id: number;
	username: string;
	name: string;
	avatarUrl: string | null;
};

export type PersistTokenInput = {
	userId: string;
	organizationId: string | null;
	token: {
		accessToken: string;
		refreshToken: string | null;
		expiresAt: Date | null;
		scopes: string[];
	};
	gitlabUser: GitLabUserIdentity;
	/**
	 * The client that issued this token and the GitLab origin it belongs to.
	 * A later refresh uses exactly this client, and the token is never sent
	 * to another origin.
	 */
	issuer: GitLabIssuer;
	/**
	 * Whether the caller holds a grant the user just authorized (an OAuth
	 * code exchange, a PAT they entered). Only a fresh grant clears the
	 * reconnect-required state.
	 */
	freshGrant: boolean;
	/**
	 * The connection generation the caller read before it started (an OAuth
	 * callback reads it before the code exchange). The write is dropped when
	 * the connection moved meanwhile — a disconnect or another connect.
	 */
	expectedGeneration?: number;
};

export type PersistTokenResult =
	| { written: true; workflowIntegrationId: string; generation: number }
	| { written: false; reason: "stale" };

type ProbeFn = typeof probeGitLabMcp;

/**
 * Write a person's GitLab connection and the capability state derived from
 * probing it. The probe (HTTP, bounded) runs before the lock; the connection
 * write, the `gitlab` registry row and the `gitlab-official` capability sync
 * commit together under the connection's lifecycle lock.
 */
export async function persistGitLabToken(
	input: PersistTokenInput,
	options: {
		probe?: ProbeFn;
		deps?: Partial<GitLabConnectionDeps>;
	} = {},
): Promise<PersistTokenResult> {
	const tenant = {
		userId: input.userId,
		organizationId: input.organizationId,
	};
	const probeBaseUrl = input.issuer.origin;
	const probe = await (options.probe ?? probeGitLabMcp)({
		baseUrl: probeBaseUrl,
		accessToken: input.token.accessToken,
	});
	const isAuthoritative =
		probe.status === "ok" ||
		probe.status === "unauthorized" ||
		probe.status === "not-found";
	if (!isAuthoritative) {
		console.error(
			"[gitlab-token] non-authoritative probe on persistGitLabToken — leaving useOfficialMcp as it was",
			{
				userId: input.userId,
				organizationId: input.organizationId,
				probeStatus: probe.status,
			},
		);
	}

	const settingsPatch: Record<string, unknown> = {
		mcpProbe: {
			status: probe.status,
			httpStatus: probe.httpStatus,
			checkedAt: new Date().toISOString(),
			baseUrl: probeBaseUrl,
		},
	};
	if (isAuthoritative) {
		settingsPatch.useOfficialMcp = probe.capable;
	}

	const result = await connectGitLab(
		tenant,
		{
			accessToken: input.token.accessToken,
			refreshToken: input.token.refreshToken,
			expiresAt: input.token.expiresAt,
			scopes: input.token.scopes,
			issuer: input.issuer,
			account: input.gitlabUser,
			freshGrant: input.freshGrant,
			settingsPatch,
			expectedGeneration: input.expectedGeneration,
			alsoInTransaction: async (tx) => {
				await ensureGitLabRegistryRow(tx, tenant);
				if (!isAuthoritative) {
					return;
				}
				const sync = await syncGitlabOfficialMcpConfig(
					tx as unknown as SyncTx,
					{
						...tenant,
						capable: probe.capable,
						protectedConfigIds:
							input.issuer.kind === "mcp-dcr"
								? [input.issuer.mcpConfigId]
								: [],
					},
				);
				if (!sync.ok) {
					console.error(
						"[gitlab-token] gitlab-official MCPServer row missing — skipped MCPConfig sync",
						tenant,
					);
				}
			},
		},
		options.deps,
	);
	if (!result.written) {
		return { written: false, reason: "stale" };
	}
	return {
		written: true,
		workflowIntegrationId: result.integrationId,
		generation: result.generation,
	};
}

/**
 * Make sure the person has the `gitlab` MCPConfig the MCP page lists for a
 * connected GitLab account — as a registry entry only, with no token.
 */
export async function ensureGitLabRegistryRow(
	tx: GitLabConnectionDb,
	tenant: GitLabTokenCtx,
): Promise<void> {
	const client = tx as unknown as {
		mCPServer: { findFirst: (args: unknown) => Promise<unknown> };
		mCPConfig: {
			findFirst: (args: unknown) => Promise<unknown>;
			create: (args: unknown) => Promise<unknown>;
		};
	};
	const server = (await client.mCPServer.findFirst({
		where: { key: "gitlab", isSystemProvided: true },
		select: { id: true },
	})) as { id: string } | null;
	if (!server) {
		// The catalog row is optional now that no token lives on it; log so an
		// unseeded environment is visible.
		console.error(
			"[gitlab-token] GitLab MCPServer row missing — skipped the registry entry (run seed:mcp-registry)",
		);
		return;
	}
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId, userId: tenant.userId }
		: { organizationId: null, userId: tenant.userId };
	const existing = await client.mCPConfig.findFirst({
		where: { ...tenantFilter, mcpServerId: server.id },
		select: { id: true },
	});
	if (existing) {
		return;
	}
	await client.mCPConfig.create({
		data: {
			userId: tenant.userId,
			organizationId: tenant.organizationId,
			mcpServerId: server.id,
			authType: "OAUTH2",
			needsReauth: false,
		},
	});
}
