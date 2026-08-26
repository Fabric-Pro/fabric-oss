/**
 * Atlassian Cloud token refresh helper for the PM-sync push path
 * (PR #1169).
 *
 * The hybrid 3LO flow stores a SECONDARY token with aud=api.atlassian.com
 * on the MCPConfig row (independent of the primary Rovo MCP OAuth token).
 * Atlassian Cloud's refresh tokens are single-use and rotated on every
 * refresh — the same race-prone pattern as the Rovo MCP refresh path —
 * so we apply the same defenses:
 *
 *   1. Process-local mutex deduping concurrent refresh attempts so two
 *      simultaneous push activities only hit `auth.atlassian.com/oauth/token`
 *      ONCE per configId.
 *   2. retry-on-invalid_grant: when the upstream rejects the refresh
 *      token (cross-replica race — another worker already rotated it),
 *      reload the config row + retry ONCE with the freshly rotated
 *      token. After that, accept defeat and surface the failure.
 *
 * Mirrors `packages/mcp/lib/oauth-provider.ts` — same pattern, separate
 * token table (we don't share their mutex because that mutex is keyed
 * by primary configId, not by the secondary Cloud token; concurrent
 * Cloud refresh on one config is the case we need to dedupe here).
 *
 * Failure-proof: never throws — returns null on any error. The caller
 * degrades to base64 inline.
 */
import {
	getMcpConfigByIdInternal,
	recordMcpAtlassianCloudRefreshFailure,
	updateMcpAtlassianCloudTokens,
} from "@repo/database";
import { logger } from "@repo/logs";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import {
	assertSafeOutboundUrl,
	safeFetchOutbound,
} from "@repo/utils/url-security";

const TOKEN_ENDPOINT = "https://auth.atlassian.com/oauth/token";

/**
 * Per-process inflight map. Two concurrent calls for the same configId
 * collapse to a single fetch — saving a refresh-token roundtrip per
 * collision and avoiding the single-use-token race entirely on the same
 * worker.
 *
 * Cross-replica: another worker may still race us. That's what the
 * retry-on-invalid_grant arm below is for.
 */
const inFlight = new Map<string, Promise<{ accessToken: string } | null>>();

export async function refreshAtlassianCloudToken(
	configId: string,
): Promise<{ accessToken: string } | null> {
	const existing = inFlight.get(configId);
	if (existing) {
		return existing;
	}
	const promise = doRefresh(configId).finally(() => {
		inFlight.delete(configId);
	});
	inFlight.set(configId, promise);
	return promise;
}

async function doRefresh(
	configId: string,
): Promise<{ accessToken: string } | null> {
	const clientId = process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID;
	const clientSecret = process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET;
	// "placeholder" is the seeded Key Vault value before real secrets are
	// synced — treat it as not-configured so refresh degrades gracefully.
	// Record the condition so it's diagnosable: a silent null here looks
	// identical to a healthy "no refresh needed" and previously masked a
	// worker that simply lacked the OAuth client credentials.
	if (
		!clientId ||
		!clientSecret ||
		clientId === "placeholder" ||
		clientSecret === "placeholder"
	) {
		const reason =
			"Atlassian Cloud OAuth client credentials are not configured on this runtime (ATLASSIAN_CLOUD_OAUTH_CLIENT_ID/_SECRET missing or placeholder) — cannot refresh the attachment-upload token";
		logger.warn(`[Atlassian Cloud] ${reason}`, { configId });
		await recordMcpAtlassianCloudRefreshFailure({
			configId,
			error: reason,
		});
		return null;
	}

	const cfg = await getMcpConfigByIdInternal(configId);
	if (!cfg?.encryptedAtlassianCloudRefreshToken) {
		const reason =
			"No Atlassian Cloud refresh token on the MCP config — reconnect the Atlassian Cloud OAuth to restore attachment upload";
		logger.warn(`[Atlassian Cloud] ${reason}`, { configId });
		await recordMcpAtlassianCloudRefreshFailure({
			configId,
			error: reason,
		});
		return null;
	}

	const attempt = await tryRefresh({
		configId,
		clientId,
		clientSecret,
		encryptedRefreshToken: cfg.encryptedAtlassianCloudRefreshToken,
	});
	if (attempt.status === "ok") {
		return { accessToken: attempt.accessToken };
	}
	if (attempt.status === "fatal") {
		// Fatal = decrypt failure / network / HTTP error that won't be fixed
		// by reloading the rotated token. Record it (the previous silent null
		// made this class of failure invisible — refreshFailureCount stayed 0).
		await recordMcpAtlassianCloudRefreshFailure({
			configId,
			error:
				attempt.errorMessage || "Atlassian Cloud token refresh failed",
		});
		return null;
	}

	// invalid_grant — another replica may have rotated the refresh token
	// since we loaded it. Reload + retry ONCE.
	const cfg2 = await getMcpConfigByIdInternal(configId);
	if (!cfg2?.encryptedAtlassianCloudRefreshToken) {
		await recordMcpAtlassianCloudRefreshFailure({
			configId,
			error: "Refresh token revoked",
		});
		return null;
	}
	if (
		cfg2.encryptedAtlassianCloudRefreshToken ===
		cfg.encryptedAtlassianCloudRefreshToken
	) {
		await recordMcpAtlassianCloudRefreshFailure({
			configId,
			error: "Refresh token revoked",
		});
		return null;
	}
	const retry = await tryRefresh({
		configId,
		clientId,
		clientSecret,
		encryptedRefreshToken: cfg2.encryptedAtlassianCloudRefreshToken,
	});
	if (retry.status === "ok") {
		return { accessToken: retry.accessToken };
	}
	await recordMcpAtlassianCloudRefreshFailure({
		configId,
		error:
			retry.status === "invalid_grant"
				? "Refresh token revoked"
				: retry.errorMessage || "Refresh failed",
	});
	return null;
}

type RefreshOutcome =
	| { status: "ok"; accessToken: string }
	| { status: "fatal"; errorMessage: string }
	| { status: "invalid_grant"; errorMessage: string };

async function tryRefresh({
	configId,
	clientId,
	clientSecret,
	encryptedRefreshToken,
}: {
	configId: string;
	clientId: string;
	clientSecret: string;
	encryptedRefreshToken: string;
}): Promise<RefreshOutcome> {
	let refreshTokenPlain: string;
	try {
		refreshTokenPlain = decryptApiKey(encryptedRefreshToken);
	} catch (err) {
		logger.warn("[Atlassian Cloud] refresh token decrypt failed", {
			configId,
			error: err instanceof Error ? err.message : String(err),
		});
		return { status: "fatal", errorMessage: "decrypt failed" };
	}

	assertSafeOutboundUrl(TOKEN_ENDPOINT);
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshTokenPlain,
		client_id: clientId,
		client_secret: clientSecret,
	});
	let res: Response;
	try {
		res = await safeFetchOutbound(TOKEN_ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
			},
			body,
		});
	} catch (err) {
		return {
			status: "fatal",
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	}

	const json = (await res.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!res.ok || !json) {
		const errCode = (json?.error as string | undefined) ?? "";
		const errDesc =
			(json?.error_description as string | undefined) ??
			`HTTP ${res.status}`;
		if (
			errCode === "invalid_grant" ||
			errCode === "invalid_token" ||
			/invalid refresh token/i.test(errDesc)
		) {
			return { status: "invalid_grant", errorMessage: errDesc };
		}
		return { status: "fatal", errorMessage: errDesc };
	}

	const accessToken = json.access_token as string | undefined;
	if (!accessToken) {
		return {
			status: "fatal",
			errorMessage: "no access_token in refresh response",
		};
	}
	const refreshToken = (json.refresh_token as string | undefined) ?? null;
	const expiresIn = (json.expires_in as number | undefined) ?? null;
	const expiresAt = expiresIn
		? new Date(Date.now() + expiresIn * 1000)
		: null;

	// Persist the rotated tokens. We DON'T touch the site URL / cloudId
	// — those don't rotate with refresh.
	try {
		const cfg = await getMcpConfigByIdInternal(configId);
		if (!cfg?.atlassianCloudCloudId || !cfg?.atlassianCloudSiteUrl) {
			return {
				status: "fatal",
				errorMessage: "missing cloudId/siteUrl post-refresh",
			};
		}
		await updateMcpAtlassianCloudTokens({
			configId,
			encryptedAccessToken: encryptApiKey(accessToken),
			encryptedRefreshToken: refreshToken
				? encryptApiKey(refreshToken)
				: encryptedRefreshToken,
			tokenExpiresAt: expiresAt,
			siteUrl: cfg.atlassianCloudSiteUrl,
			cloudId: cfg.atlassianCloudCloudId,
			scopes: cfg.atlassianCloudScopes ?? [],
		});
	} catch (err) {
		logger.warn("[Atlassian Cloud] persist refreshed token failed", {
			configId,
			error: err instanceof Error ? err.message : String(err),
		});
		return {
			status: "fatal",
			errorMessage: "persist failed",
		};
	}

	return { status: "ok", accessToken };
}
