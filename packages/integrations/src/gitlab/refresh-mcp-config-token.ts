/**
 * Refresh the OAuth tokens stored on an `MCPConfig` row (the official
 * GitLab MCP path) using its own `encryptedRefreshToken` /
 * `oauthClientId` / `encryptedOauthClientSecret`.
 *
 * Wired into `resolveGitLabSource`'s `refresh` closure at every call site.
 *
 * NOTE: this is distinct from `getValidGitLabAccessToken`, which refreshes
 * the *WorkflowIntegration* JSON credentials blob. The two storage shapes
 * are different (MCPConfig stores tokens as discrete encrypted columns;
 * WorkflowIntegration stores them as an encrypted JSON blob). Conflating
 * them by passing an MCPConfig id into `getValidGitLabAccessToken`
 * produces an "integration not found" error the moment a token expires.
 */

import { updateMcpConfigTokens } from "@repo/database";
import { decryptApiKey, encryptApiKey, hashApiKey } from "@repo/utils";
import {
	type GitLabIntegrationSettings,
	readUseOfficialMcp,
} from "./integration-settings";
import {
	GitLabReauthRequiredError,
	GitLabRefreshRaceLostError,
	type GitLabRefreshResponse,
	GitLabRefreshSuppressedError,
	refreshGitLabToken,
} from "./oauth-refresh";
import { probeGitLabMcp } from "./probe-mcp";

interface MCPConfigAccessor {
	findUnique: (args: unknown) => Promise<unknown>;
	delete?: (args: unknown) => Promise<unknown>;
}

interface WorkflowIntegrationAccessor {
	findFirst: (args: unknown) => Promise<unknown>;
	update: (args: unknown) => Promise<unknown>;
}

/**
 * The MCP `baseUrl` column stores the full MCP endpoint URL (e.g.
 * `https://gitlab.example.com/api/v4/mcp`). The GitLab OAuth token
 * endpoint, however, lives at the instance origin (`/oauth/token`).
 * Reduce to the origin so `refreshGitLabToken` can append the right
 * path. Returns `null` for missing/invalid values so callers fall
 * back to gitlab.com.
 */
/**
 * Re-read the refresh-token ciphertext currently stored on the row.
 *
 * This is the evidence the rotation invariant below is tested against, so
 * the column is selected explicitly: omit it and Prisma returns `undefined`,
 * which reads as "nothing stored" and silently disables the recovery.
 */
async function readStoredRefreshToken(
	db: { mCPConfig: MCPConfigAccessor },
	configId: string,
): Promise<string | null> {
	const raw = await db.mCPConfig.findUnique({
		where: { id: configId },
		select: { encryptedRefreshToken: true },
	});
	const row = raw as { encryptedRefreshToken: string | null } | null;
	return row?.encryptedRefreshToken ?? null;
}

/**
 * Stamp the ciphertext a rejection actually describes onto the condemning
 * error, so the writer downstream can bind its `needsReauth` write to that
 * exact row version. `refreshMcpConfigToken` is the only layer that knows
 * the value — its rotation-race retry posts a token the caller never loaded.
 * Returns the error so call sites read `throw withSpentToken(err, ...)`.
 */
function withSpentToken(
	error: GitLabReauthRequiredError,
	spentEncryptedRefreshToken: string,
): GitLabReauthRequiredError {
	error.spentEncryptedRefreshToken = spentEncryptedRefreshToken;
	return error;
}

function deriveOAuthBaseUrl(rawBaseUrl: string | null): string | null {
	if (!rawBaseUrl) {
		return null;
	}
	try {
		return new URL(rawBaseUrl).origin;
	} catch {
		return null;
	}
}

export async function refreshMcpConfigToken(args: {
	configId: string;
	db: {
		mCPConfig: MCPConfigAccessor;
		workflowIntegration?: WorkflowIntegrationAccessor;
	};
	/**
	 * Optional override for the persistence helper. Tests inject a mock;
	 * production calls fall through to the real `updateMcpConfigTokens`
	 * imported from `@repo/database`.
	 */
	updateMcpConfigTokens?: typeof updateMcpConfigTokens;
	/**
	 * Optional override for the probe function. Tests inject a mock;
	 * production calls fall through to the real `probeGitLabMcp`.
	 */
	probe?: typeof probeGitLabMcp;
}): Promise<string> {
	const rawConfig = await args.db.mCPConfig.findUnique({
		where: { id: args.configId },
		select: {
			id: true,
			encryptedRefreshToken: true,
			oauthClientId: true,
			encryptedOauthClientSecret: true,
			baseUrl: true,
			needsReauth: true,
		},
	});

	const config = rawConfig as {
		id: string;
		encryptedRefreshToken: string | null;
		oauthClientId: string | null;
		encryptedOauthClientSecret: string | null;
		baseUrl: string | null;
		needsReauth: boolean;
	} | null;

	// The circuit breaker trips `needsReauth` on a permanent rejection, and
	// only a successful re-auth clears it. Refreshing anyway would re-hammer
	// a token the provider has already rejected, so stop before touching the
	// token endpoint. The distinct error type tells callers this was a local
	// decline rather than a provider verdict, so they don't record it as
	// another failure against an already-condemned row.
	//
	// Consulted before every other rejection below, deliberately: a condemned
	// row that ALSO lacks a refresh token or client ID would otherwise throw
	// an ordinary `Error`, which callers do record — further diagnostics
	// against a row that must be left alone. Null-safe because the
	// missing-config check now runs second. The generic provider's
	// `doRefreshAccessToken` orders its breaker check the same way.
	if (config?.needsReauth) {
		throw new GitLabRefreshSuppressedError(
			`MCPConfig ${args.configId} needs re-authentication — refresh suppressed by the circuit breaker`,
		);
	}

	if (!config?.encryptedRefreshToken || !config.oauthClientId) {
		throw new Error(
			`MCPConfig ${args.configId} missing refresh credentials — reconnect required`,
		);
	}

	const refreshToken = decryptApiKey(config.encryptedRefreshToken);
	const clientSecret = config.encryptedOauthClientSecret
		? decryptApiKey(config.encryptedOauthClientSecret)
		: "";

	// `baseUrl` carries the MCP server's connection URL (e.g.
	// `https://gitlab.example.com/api/v4/mcp`). Derive the OAuth host
	// from it so self-hosted instances hit their own token endpoint.
	// Falls back to gitlab.com when null (back-compat for older rows).
	const baseUrl = deriveOAuthBaseUrl(config.baseUrl);

	// Ciphertext of the refresh token this call actually spends. The
	// rotation-race retry below replaces it with the value a parallel refresh
	// persisted, so a response that omits `refresh_token` falls back to the
	// token still on the row rather than clobbering it with a spent one.
	let spentEncryptedRefreshToken = config.encryptedRefreshToken;

	let refreshed: GitLabRefreshResponse;
	try {
		refreshed = await refreshGitLabToken(
			refreshToken,
			config.oauthClientId,
			clientSecret,
			baseUrl ? { baseUrl } : undefined,
		);
	} catch (error) {
		// Cross-replica rotation-race recovery. GitLab rotates the refresh
		// token on every exchange, so when two callers (the PM adapter and the
		// Temporal resolver, or two replicas of either) refresh the same config
		// concurrently, the loser posts a token the winner has already spent
		// and GitLab answers `invalid_grant`. Reload the row — if the stored
		// refresh token changed under us, the winner persisted a fresh one —
		// and retry ONCE with it.
		//
		// Without this, a lost race is indistinguishable from a revoked grant:
		// callers condemn on exactly this typed error, so they would trip
		// `needsReauth` on a perfectly live credential and force the user
		// through a reconnect they never needed. Any other error is a real
		// failure rather than a race, so it rethrows untouched.
		if (!(error instanceof GitLabReauthRequiredError)) {
			throw error;
		}

		const reloadedEncrypted = await readStoredRefreshToken(
			args.db,
			args.configId,
		);
		if (!reloadedEncrypted) {
			throw withSpentToken(error, spentEncryptedRefreshToken);
		}
		// Compare the DECRYPTED values: `encryptApiKey` is non-deterministic,
		// so equal ciphertext is not the question — equal plaintext is.
		const reloadedRefreshToken = decryptApiKey(reloadedEncrypted);
		if (reloadedRefreshToken === refreshToken) {
			// The row still holds the very token GitLab just rejected, so the
			// evidence is current and the grant really is dead. Rethrow so the
			// caller's existing classification condemns the row. This reload
			// doubles as the rotation check for the no-retry path — nothing
			// has happened since it was read.
			throw withSpentToken(error, spentEncryptedRefreshToken);
		}

		console.warn(
			"[gitlab-mcp-refresh] refresh token rotated by a parallel refresh — retrying once with the stored value",
			{ configId: args.configId },
		);
		spentEncryptedRefreshToken = reloadedEncrypted;
		try {
			refreshed = await refreshGitLabToken(
				reloadedRefreshToken,
				config.oauthClientId,
				clientSecret,
				baseUrl ? { baseUrl } : undefined,
			);
		} catch (retryError) {
			// The retry can lose a SECOND race. GitLab rotates on every
			// exchange, so with three concurrent callers on T0: A spends
			// T0→T1; B and C both reload and retry with T1; B spends T1→T2
			// and C is told `invalid_grant` about T1 while T2 is alive on the
			// row. Condemning on that would kill a working grant.
			//
			// The invariant that settles it: a provider rejection only proves
			// the grant is dead while the token we posted is STILL the stored
			// one. So reload once more and compare — if the row has moved on,
			// our rejection describes a token that has already been replaced
			// and must not escape as the condemning error type. There is no
			// further retry here, so this cannot loop.
			if (!(retryError instanceof GitLabReauthRequiredError)) {
				throw retryError;
			}
			const latestEncrypted = await readStoredRefreshToken(
				args.db,
				args.configId,
			);
			const latestRefreshToken = latestEncrypted
				? decryptApiKey(latestEncrypted)
				: null;
			if (
				latestRefreshToken === null ||
				latestRefreshToken === reloadedRefreshToken
			) {
				// Still the token we posted (or nothing stored at all, which
				// proves nothing): keep the provider's verdict. The stamp
				// carries the RETRIED token, not the one first loaded — that
				// is the value the rejection is about.
				throw withSpentToken(retryError, spentEncryptedRefreshToken);
			}
			throw new GitLabRefreshRaceLostError(
				`MCPConfig ${args.configId} refresh was rejected, but the stored refresh token rotated again meanwhile — the rejection describes a token that has already been replaced`,
			);
		}
	}

	const persist = args.updateMcpConfigTokens ?? updateMcpConfigTokens;
	await persist({
		configId: config.id,
		encryptedAccessToken: encryptApiKey(refreshed.access_token),
		accessTokenHash: hashApiKey(refreshed.access_token),
		encryptedRefreshToken: refreshed.refresh_token
			? encryptApiKey(refreshed.refresh_token)
			: spentEncryptedRefreshToken,
		tokenExpiresAt: refreshed.expires_in
			? new Date(Date.now() + refreshed.expires_in * 1000)
			: null,
	});

	// Skip probe entirely if caller didn't wire workflowIntegration support.
	if (!args.db.workflowIntegration) {
		return refreshed.access_token;
	}

	// Look up the MCPConfig's owner so we can find their WorkflowIntegration.
	const ownerRaw = await args.db.mCPConfig.findUnique({
		where: { id: args.configId },
		select: { userId: true, organizationId: true },
	});
	const owner = ownerRaw as {
		userId: string;
		organizationId: string | null;
	} | null;
	if (!owner) {
		return refreshed.access_token; // shouldn't happen — refresh just succeeded.
	}

	const integration = await args.db.workflowIntegration.findFirst({
		where: {
			userId: owner.userId,
			organizationId: owner.organizationId,
			provider: "GITLAB",
		},
		select: { id: true, settings: true, credentials: true },
	});
	const integ = integration as {
		id: string;
		settings: unknown;
		credentials: string;
	} | null;
	if (!integ) {
		return refreshed.access_token; // no integration to update; skip.
	}

	// Probe the SAME host we just refreshed against. For gitlab.com OAuth
	// configs this stays "https://gitlab.com"; for self-hosted instances
	// it uses the derived origin so we don't send a self-hosted bearer to
	// gitlab.com.
	const PROBE_BASE_URL = baseUrl ?? "https://gitlab.com";
	const probeFn = args.probe ?? probeGitLabMcp;
	const probeResult = await probeFn({
		baseUrl: PROBE_BASE_URL,
		accessToken: refreshed.access_token,
	});

	const prevSettings = (integ.settings ?? {}) as GitLabIntegrationSettings;
	const prevFlag = readUseOfficialMcp(prevSettings);

	const isAuthoritative =
		probeResult.status === "ok" ||
		probeResult.status === "unauthorized" ||
		probeResult.status === "not-found";

	const newUseOfficialMcp = isAuthoritative
		? probeResult.capable
		: prevFlag === true; // preserve on network-error / timeout

	const nextSettings: GitLabIntegrationSettings = {
		...prevSettings,
		useOfficialMcp: newUseOfficialMcp,
		mcpProbe: {
			status: probeResult.status,
			httpStatus: probeResult.httpStatus,
			checkedAt: new Date().toISOString(),
			baseUrl: PROBE_BASE_URL,
		},
	};

	// Read the current credentials blob so we preserve fields we don't refresh
	// (token_type, scope, created_at). Guarded against malformed/legacy blobs
	// so the dual-write stays best-effort relative to the primary MCPConfig
	// refresh that already succeeded above.
	let existingCredentials: {
		access_token?: string;
		refresh_token?: string;
		token_type?: string;
		scope?: string;
		expires_in?: number;
		created_at?: number;
		[key: string]: unknown;
	} = {};
	if (integ.credentials) {
		try {
			existingCredentials = JSON.parse(decryptApiKey(integ.credentials));
		} catch {
			// Malformed legacy credentials (e.g., raw PAT not JSON). Treat as
			// empty and let the dual-write replace with the refreshed shape.
			// The primary MCPConfig refresh already succeeded — don't bubble.
			existingCredentials = {};
		}
	}

	const newCredentials = JSON.stringify({
		...existingCredentials,
		access_token: refreshed.access_token,
		refresh_token:
			refreshed.refresh_token ?? existingCredentials.refresh_token,
		expires_in: refreshed.expires_in,
		token_obtained_at: new Date().toISOString(),
	});

	const newWorkflowExpiresAt = refreshed.expires_in
		? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
		: null;

	await args.db.workflowIntegration.update({
		where: { id: integ.id },
		data: {
			credentials: encryptApiKey(newCredentials),
			settings: {
				...nextSettings,
				tokenExpiresAt: newWorkflowExpiresAt,
			},
		},
	});

	// If the flag flipped true → false, delete the now-stale gitlab-official
	// MCPConfig (the one we just refreshed). Subsequent resolves will fall
	// through to REST. If false → true the create-step is owned by
	// persistGitLabToken (on next connect/reconnect), not here.
	if (
		prevFlag === true &&
		newUseOfficialMcp === false &&
		args.db.mCPConfig.delete
	) {
		await args.db.mCPConfig.delete({ where: { id: args.configId } });
	}

	return refreshed.access_token;
}
