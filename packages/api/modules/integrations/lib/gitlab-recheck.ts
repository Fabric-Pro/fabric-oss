import {
	type GitLabConnectionDeps,
	type GitLabIntegrationSettings,
	type GitLabMcpProbeRecord,
	GitLabReauthRequiredError,
	getGitLabConnectionToken,
	patchGitLabConnectionSettings,
	probeGitLabMcp,
	readUseOfficialMcp,
} from "@repo/integrations/gitlab";
import {
	type SyncTx,
	syncGitlabOfficialMcpConfig,
} from "./sync-gitlab-official-mcp";

export class GitLabIntegrationNotConnectedError extends Error {
	constructor() {
		super("GitLab integration not connected");
		this.name = "GitLabIntegrationNotConnectedError";
	}
}

export type RecheckCapabilitiesInput = {
	userId: string;
	organizationId: string | null;
};

export type RecheckCapabilitiesResult = {
	useOfficialMcp: boolean;
	mcpProbe: GitLabMcpProbeRecord;
};

/**
 * Re-probe whether the person's GitLab connection can use GitLab's official
 * MCP server, and record the answer.
 *
 * The probe runs against the credential's own GitLab origin with the
 * connection's current token (refreshed when due). Its result is written
 * through `patchGitLabConnectionSettings`, fenced on the connection
 * generation the token came from: a reconnect, disconnect or reauth mark
 * that lands while the probe is in flight wins, and the stale result is
 * dropped rather than written over it.
 */
export async function recheckGitlabCapabilities(opts: {
	input: RecheckCapabilitiesInput;
	probe?: typeof probeGitLabMcp;
	deps?: Partial<GitLabConnectionDeps>;
}): Promise<RecheckCapabilitiesResult> {
	const tenant = {
		userId: opts.input.userId,
		organizationId: opts.input.organizationId,
	};
	// `anyOrigin`: the probe below goes to the credential's own instance.
	const token = await getGitLabConnectionToken(
		tenant,
		{ mode: "strict", anyOrigin: true },
		opts.deps,
	);
	if (!token.ok) {
		if (token.reason === "not-connected") {
			throw new GitLabIntegrationNotConnectedError();
		}
		if (token.reason === "needs-reauth") {
			throw new GitLabReauthRequiredError();
		}
		throw new Error(token.message);
	}

	const probeBaseUrl = token.origin;
	const probe = await (opts.probe ?? probeGitLabMcp)({
		baseUrl: probeBaseUrl,
		accessToken: token.accessToken,
	});

	const prevFlag = readUseOfficialMcp(
		token.settings as GitLabIntegrationSettings,
	);
	const isAuthoritative =
		probe.status === "ok" ||
		probe.status === "unauthorized" ||
		probe.status === "not-found";
	const newUseOfficialMcp = isAuthoritative
		? probe.capable
		: prevFlag === true;

	const mcpProbe: GitLabMcpProbeRecord = {
		status: probe.status,
		httpStatus: probe.httpStatus,
		checkedAt: new Date().toISOString(),
		baseUrl: probeBaseUrl,
	};

	const written = await patchGitLabConnectionSettings(
		tenant,
		{
			expectedGeneration: token.generation,
			patch: { useOfficialMcp: newUseOfficialMcp, mcpProbe },
			alsoInTransaction: async (tx) => {
				if (!isAuthoritative) {
					return;
				}
				const result = await syncGitlabOfficialMcpConfig(
					tx as unknown as SyncTx,
					{
						...tenant,
						capable: probe.capable,
						protectedConfigIds:
							token.issuer?.kind === "mcp-dcr"
								? [token.issuer.mcpConfigId]
								: [],
					},
				);
				if (!result.ok) {
					console.error(
						"[gitlab-recheck] gitlab-official MCPServer row missing — skipped MCPConfig sync",
						tenant,
					);
				}
			},
		},
		opts.deps,
	);
	if (!written) {
		console.warn(
			"[gitlab-recheck] the GitLab connection changed during the probe — result not recorded",
			tenant,
		);
	}

	return { useOfficialMcp: newUseOfficialMcp, mcpProbe };
}
