import {
	type GitLabIntegrationSettings,
	type GitLabMcpProbeRecord,
	probeGitLabMcp,
	readUseOfficialMcp,
} from "@repo/integrations/gitlab";
import { encryptApiKey, hashApiKey } from "@repo/utils";
import { getValidGitLabToken } from "./gitlab-token";
import {
	type SyncTx,
	syncGitlabOfficialMcpConfig,
} from "./sync-gitlab-official-mcp";

const DEFAULT_PROBE_BASE_URL = "https://gitlab.com";

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
 * Structural shape of the `db` argument the recheck flow needs. Extends the
 * `SyncTx` shape with the read+write accessors used outside the transaction
 * (initial integration lookup + token refresh). We accept a Prisma client
 * via this structural type so callers pass the real client without a `never`
 * cast.
 */
export type RecheckDb = SyncTx & {
	workflowIntegration: {
		findFirst: (args: unknown) => Promise<unknown>;
		update: (args: unknown) => Promise<unknown>;
	};
	mCPConfig: SyncTx["mCPConfig"] & {
		findFirst: (args: unknown) => Promise<unknown>;
		updateMany?: (args: unknown) => Promise<unknown>;
	};
	$transaction: <T>(cb: (tx: RecheckDb) => Promise<T>) => Promise<T>;
};

/**
 * Best-effort derivation of the probe base URL from the gitlab-official
 * MCPConfig.baseUrl column. Falls back to gitlab.com when missing or
 * unparseable (back-compat for older rows + self-hosted future-proofing).
 *
 * baseUrl is stored as the full MCP endpoint URL (e.g.
 * `https://gitlab.example.com/api/v4/mcp`); the probe wants the host
 * origin so it can append `/api/v4/mcp` itself.
 */
function deriveProbeBaseUrl(rawBaseUrl: string | null | undefined): string {
	if (!rawBaseUrl) {
		return DEFAULT_PROBE_BASE_URL;
	}
	try {
		return new URL(rawBaseUrl).origin;
	} catch {
		return DEFAULT_PROBE_BASE_URL;
	}
}

export async function recheckGitlabCapabilities(opts: {
	db: RecheckDb;
	input: RecheckCapabilitiesInput;
	probe?: typeof probeGitLabMcp;
}): Promise<RecheckCapabilitiesResult> {
	// 1. Load the WorkflowIntegration outside the tx so we can fail fast on
	//    not-connected and so the probe (HTTP — slow) doesn't hold a DB
	//    connection from the pool.
	const integ = (await opts.db.workflowIntegration.findFirst({
		where: {
			userId: opts.input.userId,
			organizationId: opts.input.organizationId,
			provider: "GITLAB",
		},
		select: { id: true, settings: true },
	})) as { id: string; settings: unknown } | null;

	if (!integ) {
		throw new GitLabIntegrationNotConnectedError();
	}

	// 2. Probe base URL: prefer the existing gitlab-official MCPConfig.baseUrl
	//    (covers future self-hosted support). Falls back to gitlab.com.
	const existingOfficialCfg = (await opts.db.mCPConfig.findFirst({
		where: {
			userId: opts.input.userId,
			organizationId: opts.input.organizationId,
			mcpServer: { key: "gitlab-official" },
		},
		select: { id: true, baseUrl: true, tokenExpiresAt: true },
	})) as {
		id: string;
		baseUrl: string | null;
		tokenExpiresAt: Date | null;
	} | null;

	const probeBaseUrl = deriveProbeBaseUrl(existingOfficialCfg?.baseUrl);

	// 3. Get a fresh, refreshed access token (handles near-expiry case so we
	//    don't probe with a stale token and get a spurious `unauthorized`).
	//    Structural cast: `RecheckDb` covers a superset of the accessors
	//    `getValidGitLabToken` needs (mCPConfig, workflowIntegration,
	//    $transaction). One explicit cast site that future refactors will
	//    surface as a compile error if either contract drifts.
	const accessToken = await getValidGitLabToken(
		opts.db as unknown as Parameters<typeof getValidGitLabToken>[0],
		{
			userId: opts.input.userId,
			organizationId: opts.input.organizationId,
		},
	);

	// 4. Probe (HTTP — outside any transaction).
	const probeFn = opts.probe ?? probeGitLabMcp;
	const probe = await probeFn({
		baseUrl: probeBaseUrl,
		accessToken,
	});

	const prevSettings = (integ.settings ?? {}) as GitLabIntegrationSettings;
	const prevFlag = readUseOfficialMcp(prevSettings);

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

	const nextSettings: GitLabIntegrationSettings = {
		...prevSettings,
		useOfficialMcp: newUseOfficialMcp,
		mcpProbe,
	};

	// 5. Wrap BOTH writes (settings + sync) in a single transaction so a
	//    partial failure leaves no half-updated state.
	await opts.db.$transaction(async (tx) => {
		await tx.workflowIntegration.update({
			where: { id: integ.id },
			data: { settings: nextSettings },
		});

		// Only touch MCPConfig when the probe is authoritative.
		if (isAuthoritative) {
			const result = await syncGitlabOfficialMcpConfig(tx, {
				userId: opts.input.userId,
				organizationId: opts.input.organizationId,
				capable: probe.capable,
				// A capability recheck reuses the EXISTING credential — it is
				// not a new grant, so it must not clear `needsReauth` or the
				// rest of the circuit-breaker state on the row.
				resetBreaker: false,
				tokenBundle: {
					encryptedAccessToken: encryptApiKey(accessToken),
					accessTokenHash: hashApiKey(accessToken),
					encryptedRefreshToken: null,
					// tokenExpiresAt intentionally omitted — recheck doesn't
					// carry an authoritative expiry value. The sync helper
					// preserves the existing column when this is undefined.
				},
			});
			if (!result.ok) {
				// TODO(observability): wire a structured logger when integrations/api packages
				// share one (@repo/logs is currently in api only). For now console.error so
				// the unseeded-env case at least surfaces in container logs.
				console.error(
					"[gitlab-recheck] gitlab-official MCPServer row missing — skipped MCPConfig sync",
					{
						userId: opts.input.userId,
						organizationId: opts.input.organizationId,
					},
				);
			} else if (result.action === "kept-condemned") {
				// The row is condemned and a recheck has no authority to clear
				// that, so the sync declined the delete an incapable probe
				// would normally take — deleting would launder the breaker,
				// since the next capable recheck recreates the row clean.
				// `useOfficialMcp: false` above already routes traffic away
				// from it. Same `console.error` reasoning as the branch above.
				console.error(
					"[gitlab-recheck] kept a condemned gitlab-official MCPConfig rather than deleting it — only a fresh grant may clear its breaker",
					{
						userId: opts.input.userId,
						organizationId: opts.input.organizationId,
					},
				);
			}
		}
	});

	return { useOfficialMcp: newUseOfficialMcp, mcpProbe };
}
