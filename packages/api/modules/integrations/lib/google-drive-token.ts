import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { oauthProviders } from "./oauth-providers";

/**
 * Resolve a usable Google Drive access token for a tenant (XOR user/org).
 *
 * Reads the `GOOGLE_DRIVE` `WorkflowIntegration` row written by the unified
 * OAuth callback (`procedures/oauth.ts`), decrypts its JSON `credentials`
 * blob, and returns the stored `access_token` when it is still valid. When
 * the token is near/at expiry it refreshes via the provider's
 * `refreshAccessToken` and re-persists the new token in the same shape the
 * callback uses, so subsequent reads stay consistent.
 *
 * The callback stores credentials as encrypted JSON of the shape
 *   { access_token, refresh_token, scope, expires_in, token_obtained_at }
 * (see `oauth.ts` ~L383). Expiry is therefore derived from
 * `token_obtained_at + expires_in`, with a fallback to the ISO
 * `settings.tokenExpiresAt` mirror the callback also writes.
 *
 * Throws typed sentinel errors the procedures map to friendly messages:
 *  - `GoogleDriveNotConnectedError` — no active integration row / no creds.
 *  - `GoogleDriveTokenExpiredError` — expired with no usable refresh path.
 */
export class GoogleDriveNotConnectedError extends Error {
	constructor() {
		super("Google account not connected");
		this.name = "GoogleDriveNotConnectedError";
	}
}

export class GoogleDriveTokenExpiredError extends Error {
	constructor() {
		super("Google session expired");
		this.name = "GoogleDriveTokenExpiredError";
	}
}

/**
 * Shape of the decrypted `credentials` JSON persisted by the OAuth callback.
 * `expires_in` is the original lifetime (seconds); combined with
 * `token_obtained_at` it yields the absolute expiry instant.
 */
interface StoredCreds {
	access_token: string;
	refresh_token?: string;
	scope?: string;
	expires_in?: number;
	token_obtained_at?: string;
}

/** Mirror of the bits of `WorkflowIntegration.settings` we read for expiry. */
interface IntegrationSettings {
	tokenExpiresAt?: string | null;
}

// Refresh slightly before the hard expiry so an access token handed back to a
// caller has a usable lifetime ahead of it rather than dying mid-request.
const EXPIRY_BUFFER_MS = 60_000;

/**
 * Compute the absolute expiry instant (epoch ms) for the stored token, or
 * `null` when expiry is unknown. Prefers `token_obtained_at + expires_in`
 * from the credentials blob; falls back to the ISO `settings.tokenExpiresAt`
 * mirror the callback also writes.
 */
function resolveExpiryMs(
	creds: StoredCreds,
	settings: IntegrationSettings,
): number | null {
	if (creds.expires_in && creds.token_obtained_at) {
		const obtainedAt = Date.parse(creds.token_obtained_at);
		if (!Number.isNaN(obtainedAt)) {
			return obtainedAt + creds.expires_in * 1000;
		}
	}
	if (settings.tokenExpiresAt) {
		const parsed = Date.parse(settings.tokenExpiresAt);
		if (!Number.isNaN(parsed)) {
			return parsed;
		}
	}
	return null;
}

export async function getGoogleDriveAccessToken(input: {
	userId: string;
	organizationId: string | undefined;
}): Promise<string> {
	// Always scope to the CALLING user — a Google connection is personal even
	// in an org context (the OAuth callback stores one row per (userId,
	// organizationId), so multiple members can each connect their own account).
	// Dropping userId here would let `findFirst` return an arbitrary member's
	// connection and expose their private Docs (story PR-2). This mirrors the
	// canonical `getAccessToken` procedure in oauth.ts. The XOR part is the
	// organization dimension: personal context REQUIRES organizationId: null so
	// org rows never leak into a user's personal lookup.
	const where = {
		userId: input.userId,
		provider: "GOOGLE_DRIVE" as const,
		isActive: true,
		organizationId: input.organizationId ?? null,
	};

	const row = await db.workflowIntegration.findFirst({ where });
	if (!row?.credentials) {
		throw new GoogleDriveNotConnectedError();
	}

	let creds: StoredCreds;
	try {
		creds = JSON.parse(decryptApiKey(row.credentials)) as StoredCreds;
	} catch (error) {
		// Corrupt / undecryptable credentials are indistinguishable from "not
		// connected" for the caller — but log so a crypto outage (key rotation,
		// AES-tag mismatch from a cross-env DB restore) doesn't manifest as a
		// silent "user appears disconnected" with no Sentry signal.
		logger.error(
			`[GoogleDriveToken] Failed to decrypt credentials for integration ${row.id} (user=${input.userId}, org=${input.organizationId ?? "personal"}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		throw new GoogleDriveNotConnectedError();
	}
	if (!creds.access_token) {
		throw new GoogleDriveNotConnectedError();
	}

	const settings = (row.settings ?? {}) as IntegrationSettings;
	const expiryMs = resolveExpiryMs(creds, settings);

	// Unknown expiry is treated as still-valid: Google's stored token carries
	// `expires_in` in practice, and refreshing on every call would be wasteful.
	const notExpired =
		expiryMs === null || expiryMs - Date.now() > EXPIRY_BUFFER_MS;
	if (notExpired) {
		return creds.access_token;
	}

	const provider = oauthProviders.GOOGLE_DRIVE;
	if (!creds.refresh_token || !provider?.refreshAccessToken) {
		throw new GoogleDriveTokenExpiredError();
	}

	const clientId = process.env.GOOGLE_CLIENT_ID;
	const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new GoogleDriveTokenExpiredError();
	}

	try {
		const refreshed = await provider.refreshAccessToken(
			creds.refresh_token,
			clientId,
			clientSecret,
		);
		// Re-persist in the same JSON shape the callback uses so the next read
		// derives expiry the same way. Google's refresh response usually omits
		// a new refresh_token, so we keep the existing one.
		const obtainedAt = new Date();
		const updated: StoredCreds = {
			access_token: refreshed.access_token,
			refresh_token: refreshed.refresh_token ?? creds.refresh_token,
			scope: refreshed.scope ?? creds.scope,
			expires_in: refreshed.expires_in,
			token_obtained_at: obtainedAt.toISOString(),
		};
		// Keep the `settings.tokenExpiresAt` mirror consistent with the
		// credentials blob (matches the callback + oauth.ts refresh path);
		// otherwise the mirror goes stale after the first helper-driven refresh
		// and the resolveExpiryMs fallback would read a wrong value.
		const refreshedExpiresAt =
			refreshed.expires_in != null
				? new Date(
						obtainedAt.getTime() + refreshed.expires_in * 1000,
					).toISOString()
				: undefined;
		await db.workflowIntegration.update({
			where: { id: row.id },
			data: {
				credentials: encryptApiKey(JSON.stringify(updated)),
				settings: {
					...settings,
					...(refreshedExpiresAt
						? { tokenExpiresAt: refreshedExpiresAt }
						: {}),
				},
			},
		});
		return updated.access_token;
	} catch (error) {
		// Refresh failures are conflated with permanent expiry for the UI (both
		// require reconnect), but log the original so a transient Google 5xx,
		// DNS failure, or Prisma write error doesn't look identical to a real
		// "session expired" in logs.
		logger.error(
			`[GoogleDriveToken] Token refresh failed for integration ${row.id} (user=${input.userId}, org=${input.organizationId ?? "personal"}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		throw new GoogleDriveTokenExpiredError();
	}
}
