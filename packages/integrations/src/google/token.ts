import { db } from "@repo/database";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import {
	GoogleDriveNotConnectedError,
	GoogleDriveTokenExpiredError,
} from "./connection-errors";

export {
	GoogleDriveNotConnectedError,
	GoogleDriveTokenExpiredError,
	isGoogleDriveNotConnectedError,
} from "./connection-errors";

const LOG = "[GoogleDriveToken]";

/** The row holding a tenant's own Google OAuth client, not anyone's token. */
const OAUTH_APP_NAME = "GOOGLE_DRIVE_OAUTH_APP";

/** The grant document folders read with; `drive.file` alone lists nothing. */
const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Refresh slightly before the hard expiry so an access token handed back to a
// caller has a usable lifetime ahead of it rather than dying mid-request.
const EXPIRY_BUFFER_MS = 60_000;

/** Google's answer to a refresh-token grant. */
export interface GoogleTokenResponse {
	access_token: string;
	token_type: string;
	scope?: string;
	refresh_token?: string;
	expires_in?: number;
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

/** Whose connection is read, and in which tenant. */
export interface GoogleDriveConnectionInput {
	userId: string;
	organizationId: string | null | undefined;
	/**
	 * The resolved connection to read. Without it, the caller's own active
	 * row in this tenant is used, as the Google Docs picker does.
	 */
	connectionId?: string;
}

/**
 * Exchange a refresh token for a new access token. The one place Fabric calls
 * Google's token endpoint to refresh; the OAuth provider config calls it too.
 */
export async function refreshGoogleAccessToken(
	refreshToken: string,
	clientId: string,
	clientSecret: string,
): Promise<GoogleTokenResponse> {
	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to refresh Google token: ${response.status}`);
	}

	return response.json() as Promise<GoogleTokenResponse>;
}

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

function connectionLabel(
	input: GoogleDriveConnectionInput,
	rowId: string,
): string {
	return `integration ${rowId} (user=${input.userId}, org=${input.organizationId ?? "personal"})`;
}

/**
 * The caller's own active connection row and its decrypted credentials.
 * Throws `GoogleDriveNotConnectedError` when there is none to use.
 */
async function loadConnection(input: GoogleDriveConnectionInput): Promise<{
	id: string;
	creds: StoredCreds;
	settings: IntegrationSettings;
}> {
	// Always scoped to the CALLING user, also with a connection id: a Google
	// connection is personal even in an organization (the callback stores one
	// row per user and organization), and dropping userId would hand one
	// member's private Drive to another. A personal lookup requires
	// organizationId: null, so organization rows never leak into it.
	const row = await db.workflowIntegration.findFirst({
		where: {
			...(input.connectionId ? { id: input.connectionId } : {}),
			userId: input.userId,
			provider: "GOOGLE_DRIVE",
			isActive: true,
			organizationId: input.organizationId ?? null,
			// The GOOGLE_DRIVE_OAUTH_APP row holds OAuth client credentials,
			// not this user's token.
			NOT: { name: OAUTH_APP_NAME },
		},
	});
	if (!row?.credentials) {
		throw new GoogleDriveNotConnectedError();
	}

	let creds: StoredCreds;
	try {
		creds = JSON.parse(decryptApiKey(row.credentials)) as StoredCreds;
	} catch (error) {
		// Corrupt or undecryptable credentials are "not connected" to the
		// caller, but are logged so a crypto outage (key rotation, a
		// cross-environment restore) does not look like users disconnecting.
		console.error(
			`${LOG} Failed to decrypt credentials for ${connectionLabel(input, row.id)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		throw new GoogleDriveNotConnectedError();
	}
	if (!creds.access_token) {
		throw new GoogleDriveNotConnectedError();
	}
	return {
		id: row.id,
		creds,
		settings: (row.settings ?? {}) as IntegrationSettings,
	};
}

/**
 * Whether the stored grant includes `drive.readonly`. A connection holding
 * only `drive.file` lists an empty folder instead of failing, so a folder is
 * read only with this scope. False also when the connection is gone or its
 * credentials cannot be read: either way the person has to reconnect.
 */
export async function hasGoogleDriveReadonlyScope(
	input: GoogleDriveConnectionInput,
): Promise<boolean> {
	let creds: StoredCreds;
	try {
		({ creds } = await loadConnection(input));
	} catch (error) {
		if (error instanceof GoogleDriveNotConnectedError) {
			return false;
		}
		throw error;
	}
	return (creds.scope ?? "").split(/\s+/).includes(DRIVE_READONLY_SCOPE);
}

/**
 * A usable Google Drive access token for one person's connection, shared by
 * the API and the Temporal worker (which does not depend on `@repo/api`).
 *
 * Reads the `GOOGLE_DRIVE` `WorkflowIntegration` row written by the unified
 * OAuth callback, decrypts its JSON `credentials` blob, and returns the stored
 * `access_token` while it is still valid. Near expiry it refreshes the token
 * and stores the new one in the shape the callback writes, so later reads stay
 * consistent.
 *
 * The callback stores credentials as encrypted JSON of the shape
 *   { access_token, refresh_token, scope, expires_in, token_obtained_at }
 * so expiry is `token_obtained_at + expires_in`, with a fallback to the ISO
 * `settings.tokenExpiresAt` mirror the callback also writes.
 *
 * Throws `GoogleDriveNotConnectedError` when there is no active row or no
 * credentials, and `GoogleDriveTokenExpiredError` when the token expired with
 * no usable refresh.
 */
/**
 * The OAuth client that issued the token, needed to refresh it: the
 * environment's, or else the tenant's own `GOOGLE_DRIVE_OAUTH_APP` row, in
 * the same order the OAuth flow uses (`getOAuthCredentialsWithDb`):
 * the organization's row, then the person's own. Never an unscoped row,
 * which could be another tenant's app.
 */
async function resolveGoogleClient(
	input: GoogleDriveConnectionInput,
): Promise<{ clientId: string; clientSecret: string } | null> {
	const envId = process.env.GOOGLE_CLIENT_ID;
	const envSecret = process.env.GOOGLE_CLIENT_SECRET;
	if (envId && envSecret) {
		return { clientId: envId, clientSecret: envSecret };
	}
	const app = {
		provider: "GOOGLE_DRIVE" as const,
		name: OAUTH_APP_NAME,
		isActive: true,
	};
	const scopes = [
		...(input.organizationId
			? [{ organizationId: input.organizationId, ...app }]
			: []),
		{ userId: input.userId, organizationId: null, ...app },
	];
	for (const where of scopes) {
		const row = await db.workflowIntegration.findFirst({
			where,
			select: { credentials: true },
		});
		if (!row?.credentials) {
			continue;
		}
		try {
			const parsed = JSON.parse(decryptApiKey(row.credentials)) as {
				client_id?: string;
				client_secret?: string;
			};
			if (parsed.client_id && parsed.client_secret) {
				return {
					clientId: parsed.client_id,
					clientSecret: parsed.client_secret,
				};
			}
		} catch {
			// An unreadable app row is no client; try the next scope.
		}
	}
	return null;
}

export async function getGoogleDriveAccessToken(
	input: GoogleDriveConnectionInput,
): Promise<string> {
	const { id, creds, settings } = await loadConnection(input);
	const expiryMs = resolveExpiryMs(creds, settings);

	// Unknown expiry is treated as still-valid: Google's stored token carries
	// `expires_in` in practice, and refreshing on every call would be wasteful.
	const notExpired =
		expiryMs === null || expiryMs - Date.now() > EXPIRY_BUFFER_MS;
	if (notExpired) {
		return creds.access_token;
	}

	if (!creds.refresh_token) {
		throw new GoogleDriveTokenExpiredError();
	}

	const client = await resolveGoogleClient(input);
	if (!client) {
		throw new GoogleDriveTokenExpiredError();
	}
	const { clientId, clientSecret } = client;

	try {
		const refreshed = await refreshGoogleAccessToken(
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
		// credentials blob (matches the callback and oauth.ts refresh path);
		// otherwise the mirror goes stale after the first helper-driven
		// refresh and the resolveExpiryMs fallback would read a wrong value.
		const refreshedExpiresAt =
			refreshed.expires_in != null
				? new Date(
						obtainedAt.getTime() + refreshed.expires_in * 1000,
					).toISOString()
				: undefined;
		await db.workflowIntegration.update({
			where: { id },
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
		console.error(
			`${LOG} Token refresh failed for ${connectionLabel(input, id)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		throw new GoogleDriveTokenExpiredError();
	}
}
