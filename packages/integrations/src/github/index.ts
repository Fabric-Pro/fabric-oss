/**
 * GitHub Integration Utilities
 *
 * Shared execution functions for GitHub API integrations.
 * These functions handle the actual API calls using credentials from WorkflowIntegration.
 *
 * Used by both:
 * - Temporal activities (orchestrator tool loader for agent execution)
 * - API layer (for project settings, repo listing)
 *
 * Features:
 * - Automatic token refresh when access token expires
 * - Automatic 401 retry with token refresh
 * - Concurrent refresh lock to prevent race conditions
 */

import { db } from "@repo/database";
import { withRefreshLock } from "@repo/database/prisma/queries/lib/refresh-lock";
import {
	advisoryObjectKey,
	REFRESH_ADVISORY_CLASS,
	repoIntegrationLockKey,
} from "@repo/database/prisma/queries/lib/refresh-lock-key";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import {
	refreshOAuthToken,
	sanitizeCredential,
} from "@repo/utils/oauth-refresh";
import {
	isGrantRejected,
	isRefreshTokenRejected,
	type RepoTokenRefreshFault,
	refreshFaultForOAuthErrorCode,
} from "../repo-token-refresh-fault";

const GITHUB_API_URL = "https://api.github.com";

// Module-level refresh lock to prevent concurrent token refresh races.
// When multiple concurrent requests hit a 401, only the first one refreshes
// the token; the rest await the same promise and reuse the result.
const refreshInProgress = new Map<string, Promise<string>>();

function githubHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github.v3+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "Fabric-App",
	};
}

/** Error class that preserves the HTTP status code from GitHub API responses */
class GitHubApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "GitHubApiError";
	}
}

async function githubFetch(
	token: string,
	path: string,
	params?: Record<string, string>,
): Promise<unknown> {
	const url = new URL(`${GITHUB_API_URL}${path}`);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") {
				url.searchParams.set(key, value);
			}
		}
	}

	const response = await fetch(url.toString(), {
		headers: githubHeaders(token),
	});

	const data = await response.json();

	if (!response.ok) {
		const message =
			(data as { message?: string }).message ||
			`GitHub API error: ${response.status}`;
		throw new GitHubApiError(message, response.status);
	}

	return data;
}

async function githubPost(
	token: string,
	path: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const response = await fetch(`${GITHUB_API_URL}${path}`, {
		method: "POST",
		headers: {
			...githubHeaders(token),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const data = await response.json();

	if (!response.ok) {
		const message =
			(data as { message?: string }).message ||
			`GitHub API error: ${response.status}`;
		throw new GitHubApiError(message, response.status);
	}

	return data;
}

interface ParsedCredentials {
	access_token?: string;
	GITHUB_TOKEN?: string;
	token?: string;
	apiKey?: string;
	refresh_token?: string;
	expires_in?: number;
	refresh_token_expires_in?: number;
	token_obtained_at?: string;
}

/**
 * Prisma client able to persist the refreshed credential. Satisfied by both the
 * root client and a transaction client, so the locked path can hand in its `tx`
 * and avoid checking out a second pooled connection.
 */
type RefreshWriter = Pick<typeof db, "workflowIntegration">;

/** Parse a stored credentials blob, or null when it is a raw token string. */
function safeParseCredentials(
	credentialsJson: string,
): ParsedCredentials | null {
	try {
		const parsed = JSON.parse(credentialsJson) as ParsedCredentials;
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}

function extractAccessToken(credentialsJson: string): string {
	try {
		const parsed = JSON.parse(credentialsJson) as ParsedCredentials;
		if (typeof parsed !== "object" || parsed === null) {
			return credentialsJson;
		}
		const token =
			parsed.access_token ||
			parsed.GITHUB_TOKEN ||
			parsed.token ||
			parsed.apiKey ||
			"";
		if (!token) {
			throw new Error("No access token found in GitHub credentials");
		}
		return token;
	} catch (e) {
		if (e instanceof SyntaxError) {
			return credentialsJson;
		}
		throw e;
	}
}

function isTokenExpired(credentials: ParsedCredentials): boolean {
	if (!credentials.expires_in) {
		// No expiry info. Fabric authenticates as a GitHub *App* (client id
		// `Iv23li…`), whose user tokens ALWAYS expire after 8h — so "no
		// expires_in" means the row predates us capturing it, NOT that the token
		// lives forever. Treating it as non-expiring left those connections
		// permanently dead. When a refresh token is present, force a one-time
		// refresh; the refreshed blob carries `expires_in`, so later checks are
		// precise. PATs (no refresh token) genuinely don't expire — left as-is.
		// Mirrors the same correction already made on the GitLab side.
		return !!credentials.refresh_token;
	}
	if (!credentials.token_obtained_at) {
		// Has expires_in but no timestamp — pre-patch connection.
		// Conservatively treat as expired to trigger a refresh attempt.
		return !!credentials.refresh_token;
	}
	const obtainedAt = new Date(credentials.token_obtained_at).getTime();
	const expiresAt = obtainedAt + credentials.expires_in * 1000;
	const bufferMs = 5 * 60 * 1000; // Refresh 5 minutes before expiry
	return Date.now() >= expiresAt - bufferMs;
}

/**
 * Clean a configured app credential and shout if it needed cleaning.
 *
 * `refreshOAuthToken` sanitizes defensively too, but only here do we still know
 * WHERE the value came from — and a credential arriving with a BOM or stray
 * whitespace means the deployment pipeline is corrupting secrets, which will
 * bite other credentials that have no such safety net. Staging ran seven weeks
 * with a BOM-prefixed `FABRIC_GITHUB_CLIENT_ID`; this log line is what would
 * have made that a five-minute fix.
 */
function cleanAppCredential(value: string, source: string, field: string) {
	const cleaned = sanitizeCredential(value);
	if (cleaned !== value) {
		console.warn(
			`[GitHub] ${field} from ${source} contained a BOM or surrounding whitespace and was sanitized. ` +
				"Fix the stored secret — other credentials from the same source are probably corrupted too.",
		);
	}
	return cleaned;
}

async function getGitHubClientCredentials(
	userId?: string,
	organizationId?: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
	// Check env vars first
	const envClientId = process.env.FABRIC_GITHUB_CLIENT_ID;
	const envClientSecret = process.env.FABRIC_GITHUB_CLIENT_SECRET;
	if (envClientId && envClientSecret) {
		return {
			clientId: cleanAppCredential(envClientId, "env", "client_id"),
			clientSecret: cleanAppCredential(
				envClientSecret,
				"env",
				"client_secret",
			),
		};
	}

	// Fall back to DB-stored app credentials.
	// Mirror the same lookup chain as getOAuthCredentialsWithDb():
	// org-scoped → personal → any/global (admin-configured)
	try {
		const whereConditions: Record<string, unknown>[] = [];
		if (organizationId) {
			whereConditions.push({
				organizationId,
				provider: "GITHUB",
				name: "GITHUB_OAUTH_APP",
				isActive: true,
			});
		}
		if (userId) {
			whereConditions.push({
				userId,
				organizationId: null,
				provider: "GITHUB",
				name: "GITHUB_OAUTH_APP",
				isActive: true,
			});
		}
		// Also check for any record with this name (admin-configured)
		whereConditions.push({
			provider: "GITHUB",
			name: "GITHUB_OAUTH_APP",
			isActive: true,
		});

		for (const where of whereConditions) {
			const appConfig = await db.workflowIntegration.findFirst({
				where: where as any,
			});
			if (appConfig?.credentials) {
				try {
					const decrypted = JSON.parse(
						decryptApiKey(appConfig.credentials),
					) as Record<string, string>;
					if (decrypted.client_id && decrypted.client_secret) {
						return {
							clientId: cleanAppCredential(
								decrypted.client_id,
								"GITHUB_OAUTH_APP record",
								"client_id",
							),
							clientSecret: cleanAppCredential(
								decrypted.client_secret,
								"GITHUB_OAUTH_APP record",
								"client_secret",
							),
						};
					}
				} catch {
					// Decryption failed, try next
				}
			}
		}
	} catch {
		// DB lookup failed, fall through
	}

	return null;
}

/**
 * Perform the actual GitHub token refresh via OAuth endpoint.
 * Separated from refreshTokenIfNeeded so it can be reused by the 401 retry path.
 */
async function performTokenRefresh(
	integration: {
		id: string;
		settings: unknown;
	},
	refreshTokenValue: string,
	userId?: string,
	organizationId?: string,
	/**
	 * Transaction client when running inside `withRefreshLock`. Writes MUST go
	 * through it: the lock holds one pooled connection for the whole exchange, so
	 * issuing the persist on the outer `db` would request a SECOND connection
	 * from the same (default 10) pool and can deadlock it under concurrency.
	 */
	writer: RefreshWriter = db,
	/** Pre-resolved app credentials, looked up outside the lock. */
	preResolvedCreds?: { clientId: string; clientSecret: string } | null,
): Promise<string> {
	const creds =
		preResolvedCreds !== undefined
			? preResolvedCreds
			: await getGitHubClientCredentials(userId, organizationId);

	if (!creds) {
		throw new Error(
			"Cannot refresh GitHub token: no client credentials configured. " +
				"Set FABRIC_GITHUB_CLIENT_ID and FABRIC_GITHUB_CLIENT_SECRET, " +
				"or reconnect your GitHub account.",
		);
	}

	const { clientId, clientSecret } = creds;

	console.log("[GitHub] Refreshing expired access token...");

	const result = await refreshOAuthToken({
		tokenEndpoint: "https://github.com/login/oauth/access_token",
		refreshToken: refreshTokenValue,
		clientId,
		clientSecret,
	});

	if (!result.ok) {
		throw new Error(`GitHub token refresh failed: ${result.errorMessage}`);
	}

	// Store refreshed credentials. Reuse the existing refresh token when
	// GitHub did not rotate so the workflow integration credential blob
	// stays internally consistent.
	const newCredentials = JSON.stringify({
		access_token: result.accessToken,
		token_type: result.tokenType ?? "bearer",
		scope: result.scope ?? undefined,
		refresh_token: result.refreshToken ?? refreshTokenValue,
		expires_in: result.expiresIn ?? undefined,
		token_obtained_at: new Date().toISOString(),
	});

	const existingSettings =
		typeof integration.settings === "object" &&
		integration.settings !== null
			? integration.settings
			: {};

	await writer.workflowIntegration.update({
		where: { id: integration.id },
		data: {
			credentials: encryptApiKey(newCredentials),
			settings: {
				...(existingSettings as Record<string, unknown>),
				tokenExpiresAt: result.expiresIn
					? new Date(
							Date.now() + result.expiresIn * 1000,
						).toISOString()
					: null,
			},
			updatedAt: new Date(),
		},
	});

	console.log("[GitHub] Successfully refreshed access token");
	return result.accessToken;
}

/**
 * Default lifetime for GitHub access tokens when the response omits
 * `expires_in`. GitHub User-to-Server tokens are 8 hours by default.
 */
const GITHUB_DEFAULT_TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;

/**
 * A stored token expiring beyond this window counts as already-fresh — when a
 * concurrent refresher persisted it, the loser reuses it instead of exchanging
 * again (mirrors the 60 s buffer in the code-search route).
 */
const PROJECT_REPO_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

/**
 * Refresh a GitHub access token attached to a `ProjectRepositoryIntegration`
 * and persist via optimistic-CAS so concurrent callers do not burn each
 * other's rotated refresh tokens. Used by both the temporal repo-health-check
 * activity and the per-request code-search route.
 *
 * On CAS conflict, re-reads the row to recover the winning token instead of
 * dropping the refresh on the floor — the temporal path used to return
 * `false` in this case, which left a freshly refreshed token unused until
 * the next workflow tick. The re-read path verifies that `tokenExpiresAt`
 * actually advanced before reusing the stored token, because `updatedAt` is
 * bumped by unrelated writes (`setIntegrationStatus()`, health-check
 * timestamps, a monitored-branch edit), so a CAS miss does not prove that a
 * concurrent refresh actually occurred. When the stored token is still stale
 * (unrelated bump), the just-rotated tokens are RE-PERSISTED against the
 * fresh `updatedAt` instead of being dropped — GitHub has already consumed
 * the old refresh token by then, so losing the rotation would strand the
 * integration until a manual reconnect.
 *
 * Client credentials are resolved via `getGitHubClientCredentials()`, which
 * first tries env vars (`FABRIC_GITHUB_CLIENT_ID/SECRET`) and then falls back
 * to an admin/org/user `GITHUB_OAUTH_APP` workflow_integration record, so
 * deployments that configure the OAuth app in the DB still refresh.
 *
 * Returns the plaintext access token on success, or `null` if no refresh
 * token is configured, client credentials are missing, the OAuth exchange
 * failed, or the row could not be confirmed fresh after a CAS conflict.
 *
 * A caller that needs to know WHY the null came back — specifically, whether
 * the failure was ours or the customer's — should call
 * {@link refreshProjectRepoGitHubTokenWithOutcome} instead. This function is
 * the unchanged token-or-null wrapper over it, kept so every existing caller
 * that only wants the token is unaffected.
 */
export async function refreshProjectRepoGitHubToken(input: {
	integrationId: string;
	encryptedRefreshToken: string;
	expectedUpdatedAt: Date;
	/**
	 * Optional — used to scope the `GITHUB_OAUTH_APP` DB fallback lookup so
	 * an org-specific OAuth app is preferred over the global admin record.
	 */
	userId?: string;
	organizationId?: string;
	/**
	 * Force a real OAuth exchange even when the stored access token still looks
	 * unexpired. The analysis clone path sets this after a `git` "Authentication
	 * failed" has PROVEN the stored token is dead despite a future
	 * `tokenExpiresAt` (e.g. a server-side revocation or an org-SSO
	 * de-authorization). Without it, the "a concurrent caller already refreshed"
	 * short-circuit below would hand the same dead token straight back.
	 */
	forceReExchange?: boolean;
}): Promise<string | null> {
	return (await refreshProjectRepoGitHubTokenWithOutcome(input)).token;
}

/**
 * {@link refreshProjectRepoGitHubToken}, but reporting WHY a null token came
 * back when the reason is a platform fault rather than the customer's grant.
 *
 * The distinction matters because the caller's fallback is to keep using the
 * EXPIRED stored access token: the provider then answers 401, and a consumer
 * reading only that 401 blames the customer's credential. When the refresh
 * never had a chance — no deployment OAuth client credentials, a token-endpoint
 * outage, our own database throwing — that 401 is entirely ours, and every
 * expired integration on the deployment produces one at the same moment. See
 * `RepoTokenRefreshFault` for the full reasoning.
 *
 * `platformFault` is set ONLY alongside `token: null`, and only when the cause
 * cannot be the customer's grant.
 *
 * `grantRejected` is the positive counterpart, and the two are NOT complements.
 * It is set only when the provider actually rejected the grant AND the stored
 * credential is still the one that was rejected. A failure that is neither —
 * an ambiguous code, or a rejection whose credential a concurrent reconnect has
 * already replaced — returns a bare `{ token: null }`, meaning "retry, blame
 * nobody". Callers must branch on all three: only `grantRejected` justifies
 * expiring the connection or telling the user to reconnect.
 */
export async function refreshProjectRepoGitHubTokenWithOutcome(input: {
	integrationId: string;
	encryptedRefreshToken: string;
	expectedUpdatedAt: Date;
	userId?: string;
	organizationId?: string;
	forceReExchange?: boolean;
}): Promise<{
	token: string | null;
	platformFault?: RepoTokenRefreshFault;
	grantRejected?: boolean;
	/**
	 * The refresh-token ciphertext the provider rejected, set alongside
	 * `grantRejected`. Pass it to any LATER write that acts on the rejection so
	 * that write is pinned to the same credential generation — see
	 * `setIntegrationStatus`'s `expectedRefreshToken`.
	 */
	rejectedRefreshToken?: string;
}> {
	const creds = await getGitHubClientCredentials(
		input.userId,
		input.organizationId,
	);
	if (!creds) {
		console.warn(
			`[GitHub] Cannot refresh project repo token for ${input.integrationId} — no client credentials (checked env vars and GITHUB_OAUTH_APP workflow_integration records)`,
		);
		return { token: null, platformFault: "MISSING_CLIENT_CREDENTIALS" };
	}

	// GitHub rotates the refresh token on every exchange (single-use), so two
	// callers spending the same token would have the loser get HTTP 404 from the
	// token endpoint ("Not Found" — the token was already rotated away) and
	// strand the integration. Serialize the exchange per-integration across ALL
	// processes (worker + web/api) with a Postgres advisory lock, and re-read the
	// latest stored token inside the lock so a caller that lost the race reuses
	// the winner's freshly rotated token instead of exchanging again.
	try {
		return await db.$transaction(
			async (tx) => {
				// MUST be $executeRaw, NOT $queryRaw: pg_advisory_xact_lock()
				// returns `void`, which the Postgres driver adapter's $queryRaw
				// cannot deserialize ("Failed to deserialize column of type
				// 'void'"). That throw aborted EVERY project-repo token refresh,
				// silently stranding GitHub OAuth integrations until a manual
				// reconnect (the access token still probed OK until it expired,
				// then flipped to "Reconnect required" with no working refresh).
				// $executeRaw returns the affected-row count and never
				// deserializes result columns, so the lock is taken cleanly.
				// Transitional double-lock. This path previously keyed on the
				// bare integration id; it now keys on `repo:<id>` so the
				// credential store is explicit and cannot collide with a
				// WorkflowIntegration of the same id. Those are different
				// object ids, so during a rolling deploy a draining replica
				// (old key) and a live one (new key) would not serialize —
				// reopening, for a few minutes, the exact token-burning race
				// this lock exists to prevent. Taking the legacy key first and
				// the new key second closes that window: old replicas hold
				// only the legacy key and new replicas always acquire it
				// before the new one, so no cycle is possible.
				// Remove the legacy acquisition once this revision is fully
				// rolled out everywhere.
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFRESH_ADVISORY_CLASS}::int, ${advisoryObjectKey(input.integrationId)}::int)`;
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFRESH_ADVISORY_CLASS}::int, ${advisoryObjectKey(repoIntegrationLockKey(input.integrationId))}::int)`;

				const row = await tx.projectRepositoryIntegration.findUnique({
					where: { id: input.integrationId },
					select: {
						encryptedAccessToken: true,
						encryptedRefreshToken: true,
						tokenExpiresAt: true,
					},
				});
				// Row gone, or tokens deliberately wiped (disconnect) — never
				// resurrect credentials onto such a row.
				if (!row?.encryptedAccessToken || !row.encryptedRefreshToken) {
					return { token: null };
				}
				// A concurrent caller already refreshed while we waited for the
				// lock — reuse their token instead of burning a second exchange.
				// Skipped under `forceReExchange`: the caller has proof the stored
				// token is unusable, so a not-yet-elapsed expiry must NOT
				// short-circuit it back to the same dead token.
				if (
					!input.forceReExchange &&
					row.tokenExpiresAt &&
					row.tokenExpiresAt.getTime() >
						Date.now() + PROJECT_REPO_TOKEN_REFRESH_BUFFER_MS
				) {
					return { token: decryptApiKey(row.encryptedAccessToken) };
				}

				// Exchange the CURRENT stored refresh token — the caller's
				// snapshot (`input.encryptedRefreshToken`) may already be stale.
				const refreshToken = decryptApiKey(row.encryptedRefreshToken);
				const result = await refreshOAuthToken({
					tokenEndpoint:
						"https://github.com/login/oauth/access_token",
					refreshToken,
					clientId: creds.clientId,
					clientSecret: creds.clientSecret,
				});
				if (!result.ok) {
					console.warn(
						`[GitHub] Project repo token refresh failed for ${input.integrationId}: ${result.errorMessage}`,
					);
					// Only a code that CANNOT be the customer's grant becomes a
					// platform fault — see `refreshFaultForOAuthErrorCode`.
					const platformFault = refreshFaultForOAuthErrorCode(
						result.errorCode,
					);
					if (!isGrantRejected(result.errorCode)) {
						// Either a platform fault, or a code that names
						// neither side (a bare 4xx, `invalid_request`, an
						// unrecognized RFC code). Ambiguity must not reach the
						// customer as a reconnect prompt, so report the fault
						// if we have one and otherwise say nothing at all —
						// callers defer and retry.
						return { token: null, platformFault };
					}

					// The provider rejected the grant. Write under a
					// compare-and-swap on the exact refresh-token ciphertext we
					// just exchanged.
					//
					// The advisory locks serialize refresh callers only; the
					// reconnect callback takes neither of them, so it can land
					// between our in-lock read and this write. Without the CAS
					// we would stamp — and have the caller expire — the
					// credentials a user had just successfully reconnected,
					// retiring the fresh grant from the sweep and demanding a
					// second manual reconnect. `status != DISCONNECTED` alone
					// does not cover that, because reconnect returns the row to
					// ACTIVE.
					//
					// A miss means the stored credential is no longer the one
					// the provider rejected, so our evidence says nothing about
					// what is stored now: return the ambiguous outcome and let
					// the next cycle probe the new token.
					const rejectedAt =
						await tx.projectRepositoryIntegration.updateMany({
							where: {
								id: input.integrationId,
								status: { not: "DISCONNECTED" },
								encryptedRefreshToken:
									row.encryptedRefreshToken,
							},
							data: isRefreshTokenRejected(result.errorCode)
								? { refreshTokenRejectedAt: new Date() }
								: // Not sticky (see `isRefreshTokenRejected`),
									// but still worth recording, and it makes
									// this write a real CAS either way.
									{ lastError: result.errorMessage },
						});
					if (rejectedAt.count === 0) {
						return { token: null };
					}
					// Hand back WHICH credential was rejected, not just that one
					// was. `grantRejected` is only true as of this commit — a
					// reconnect landing immediately afterwards replaces the
					// credential, and a caller that then writes status
					// unconditionally would expire the fresh grant. The witness
					// lets that later write pin itself to the same generation.
					return {
						token: null,
						grantRejected: true,
						rejectedRefreshToken: row.encryptedRefreshToken,
					};
				}

				const newExpiry = result.expiresIn
					? new Date(Date.now() + result.expiresIn * 1000)
					: new Date(Date.now() + GITHUB_DEFAULT_TOKEN_LIFETIME_MS);

				const updated =
					await tx.projectRepositoryIntegration.updateMany({
						where: {
							id: input.integrationId,
							// Never resurrect a row disconnected (tokens wiped) while the
							// OAuth exchange was in flight — the advisory lock does not
							// block a concurrent disconnect (plain updateMany).
							status: { not: "DISCONNECTED" },
							// Same compare-and-swap the rejection path uses, for the
							// same reason: the advisory lock serializes refresh
							// callers, not reconnect. Without it, a reconnect landing
							// after the exchange gets its brand-new credentials
							// overwritten by the ones this call rotated out of the OLD
							// grant — silently downgrading a repair the user just made.
							// A miss falls through to the `count === 0` return below,
							// so the caller retries against whatever is now stored.
							encryptedRefreshToken: row.encryptedRefreshToken,
						},
						data: {
							encryptedAccessToken: encryptApiKey(
								result.accessToken,
							),
							// GitHub rotates the refresh token single-use; persist the new
							// one (fall back to the existing one only when GitHub omitted
							// a rotation).
							encryptedRefreshToken: result.refreshToken
								? encryptApiKey(result.refreshToken)
								: row.encryptedRefreshToken,
							tokenExpiresAt: newExpiry,
							status: "ACTIVE",
							lastError: null,
							// The grant just proved itself alive — clear any
							// earlier rejection so the row rejoins the sweep.
							refreshTokenRejectedAt: null,
						},
					});
				if (updated.count === 0) {
					return { token: null };
				}
				return { token: result.accessToken };
			},
			{ timeout: 20_000, maxWait: 10_000 },
		);
	} catch (error) {
		console.warn(
			`[GitHub] Project repo token refresh exchange failed for ${input.integrationId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		// A throw out of the locked transaction is a database/pool/bug failure,
		// never the customer's grant.
		return { token: null, platformFault: "INTERNAL" };
	}
}

/**
 * Refresh the token with a per-integration lock to prevent concurrent refresh races.
 * If another request is already refreshing, awaits that result instead of duplicating.
 */
async function refreshTokenWithLock(
	integration: {
		id: string;
		settings: unknown;
	},
	refreshTokenValue: string,
	userId?: string,
	organizationId?: string,
): Promise<string> {
	const integrationId = integration.id;
	let existing = refreshInProgress.get(integrationId);
	if (!existing) {
		// In-process dedupe FIRST (cheap, avoids taking a DB lock when this
		// process is already refreshing), then the cross-process advisory lock —
		// the Map alone only serializes one Node process, and web + worker (and
		// worker replicas) are separate processes that would otherwise each
		// spend the same single-use refresh token.
		// App credentials are static config, not per-integration state, so they
		// are resolved BEFORE the lock. Looking them up inside would hold the
		// lock's pooled connection while requesting a SECOND one from the same
		// (default 10) pool — under concurrency that starves the pool until the
		// transaction times out, and the timeout path then marks healthy
		// connections needsReauth: the very bug this lock exists to prevent.
		existing = getGitHubClientCredentials(userId, organizationId)
			.then((creds) => {
				// Fail fast: a misconfigured deployment must not acquire an advisory
				// lock and a pooled transaction just to throw inside it.
				if (!creds) {
					throw new Error(
						"Cannot refresh GitHub token: no client credentials configured. " +
							"Set FABRIC_GITHUB_CLIENT_ID and FABRIC_GITHUB_CLIENT_SECRET, " +
							"or reconnect your GitHub account.",
					);
				}
				return withRefreshLock(`wfint:${integrationId}`, async (tx) => {
					// Re-read inside the lock: a winner may have rotated the token while
					// we queued, in which case theirs is the live one and exchanging
					// again would burn it.
					const fresh = await tx.workflowIntegration.findUnique({
						where: { id: integrationId },
						select: { credentials: true },
					});
					if (fresh?.credentials) {
						const parsed = safeParseCredentials(
							decryptApiKey(fresh.credentials),
						);
						if (parsed && !isTokenExpired(parsed)) {
							return extractAccessToken(
								decryptApiKey(fresh.credentials),
							);
						}
						if (parsed?.refresh_token) {
							refreshTokenValue = parsed.refresh_token;
						}
					}
					return performTokenRefresh(
						integration,
						refreshTokenValue,
						userId,
						organizationId,
						tx,
						creds,
					);
				});
			})
			.finally(() => {
				refreshInProgress.delete(integrationId);
			});
		refreshInProgress.set(integrationId, existing);
	}
	return existing;
}

async function refreshTokenIfNeeded(
	integration: {
		id: string;
		credentials: string;
		settings: unknown;
	},
	userId?: string,
	organizationId?: string,
): Promise<string> {
	const credentialsJson = decryptApiKey(integration.credentials);
	let parsed: ParsedCredentials;
	try {
		parsed = JSON.parse(credentialsJson) as ParsedCredentials;
	} catch {
		return credentialsJson; // Raw token string, no refresh possible
	}

	if (typeof parsed !== "object" || parsed === null) {
		return credentialsJson;
	}

	const currentToken = extractAccessToken(credentialsJson);

	if (!isTokenExpired(parsed) || !parsed.refresh_token) {
		return currentToken;
	}

	// Token is expired and we have a refresh token — try to refresh
	try {
		return await refreshTokenWithLock(
			integration,
			parsed.refresh_token,
			userId,
			organizationId,
		);
	} catch (error) {
		console.error("[GitHub] Pre-emptive token refresh failed:", error);
		// Return current token and let the 401 retry handle it
		return currentToken;
	}
}

// ============================================================================
// Tool Handlers
// ============================================================================

interface RepoItem {
	id: number;
	name: string;
	full_name: string;
	owner: { login: string };
	private: boolean;
	default_branch: string;
	description: string | null;
	html_url: string;
	updated_at: string;
}

async function listRepositories(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const type = (args.type as string) || "all";
	const sort = (args.sort as string) || "updated";
	const perPage = String(args.per_page || 30);

	const repos = (await githubFetch(token, "/user/repos", {
		type,
		sort,
		per_page: perPage,
		direction: "desc",
	})) as RepoItem[];

	return repos.map((r) => ({
		name: r.full_name,
		private: r.private,
		default_branch: r.default_branch,
		description: r.description,
		url: r.html_url,
		updated_at: r.updated_at,
	}));
}

async function getRepository(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { owner, repo } = args as { owner: string; repo: string };
	if (!owner || !repo) {
		throw new Error("owner and repo are required");
	}
	return githubFetch(token, `/repos/${owner}/${repo}`);
}

async function listIssues(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { owner, repo } = args as { owner: string; repo: string };
	if (!owner || !repo) {
		throw new Error("owner and repo are required");
	}

	const state = (args.state as string) || "open";
	const perPage = String(args.per_page || 30);

	const issues = (await githubFetch(token, `/repos/${owner}/${repo}/issues`, {
		state,
		per_page: perPage,
	})) as Array<{
		number: number;
		title: string;
		state: string;
		user: { login: string };
		labels: Array<{ name: string }>;
		created_at: string;
		updated_at: string;
		html_url: string;
		body: string | null;
		pull_request?: unknown;
	}>;

	// Filter out pull requests (GitHub API returns PRs in issues endpoint)
	return issues
		.filter((i) => !i.pull_request)
		.map((i) => ({
			number: i.number,
			title: i.title,
			state: i.state,
			author: i.user?.login,
			labels: i.labels?.map((l) => l.name),
			created_at: i.created_at,
			updated_at: i.updated_at,
			url: i.html_url,
			body: i.body ? i.body.substring(0, 500) : null,
		}));
}

async function getIssue(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { owner, repo, issue_number } = args as {
		owner: string;
		repo: string;
		issue_number: number;
	};
	if (!owner || !repo || !issue_number) {
		throw new Error("owner, repo, and issue_number are required");
	}
	return githubFetch(token, `/repos/${owner}/${repo}/issues/${issue_number}`);
}

async function getPullRequest(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { owner, repo, pull_number } = args as {
		owner: string;
		repo: string;
		pull_number: number;
	};
	if (!owner || !repo || !pull_number) {
		throw new Error("owner, repo, and pull_number are required");
	}
	return githubFetch(token, `/repos/${owner}/${repo}/pulls/${pull_number}`);
}

async function listPullRequests(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { owner, repo } = args as { owner: string; repo: string };
	if (!owner || !repo) {
		throw new Error("owner and repo are required");
	}

	const params: Record<string, string> = {
		state: (args.state as string) || "open",
		per_page: String(args.per_page || 30),
	};
	if (args.head) {
		params.head = args.head as string;
	}
	if (args.base) {
		params.base = args.base as string;
	}

	const prs = (await githubFetch(
		token,
		`/repos/${owner}/${repo}/pulls`,
		params,
	)) as Array<{
		number: number;
		title: string;
		state: string;
		user: { login: string };
		head: { ref: string };
		base: { ref: string };
		created_at: string;
		updated_at: string;
		html_url: string;
		draft: boolean;
		merged_at: string | null;
	}>;

	return prs.map((pr) => ({
		number: pr.number,
		title: pr.title,
		state: pr.state,
		author: pr.user?.login,
		head: pr.head?.ref,
		base: pr.base?.ref,
		draft: pr.draft,
		merged_at: pr.merged_at,
		created_at: pr.created_at,
		updated_at: pr.updated_at,
		url: pr.html_url,
	}));
}

async function createPullRequest(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { owner, repo, title, head, base, body, draft } = args as {
		owner: string;
		repo: string;
		title: string;
		head: string;
		base: string;
		body?: string;
		draft?: boolean;
	};
	if (!owner || !repo || !title || !head || !base) {
		throw new Error("owner, repo, title, head, and base are required");
	}

	const pr = (await githubPost(token, `/repos/${owner}/${repo}/pulls`, {
		title,
		head,
		base,
		body: body || "",
		draft: draft || false,
	})) as { html_url?: string; title?: string; number?: number };

	return {
		...pr,
		structuredContent: {
			url: pr.html_url,
			title: pr.title ?? title,
			number: pr.number,
		},
	};
}

async function createIssue(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { owner, repo, title, body, labels, assignees } = args as {
		owner: string;
		repo: string;
		title: string;
		body?: string;
		labels?: string[];
		assignees?: string[];
	};
	if (!owner || !repo || !title) {
		throw new Error("owner, repo, and title are required");
	}

	const payload: Record<string, unknown> = { title };
	if (body) {
		payload.body = body;
	}
	if (labels?.length) {
		payload.labels = labels;
	}
	if (assignees?.length) {
		payload.assignees = assignees;
	}

	const issue = (await githubPost(
		token,
		`/repos/${owner}/${repo}/issues`,
		payload,
	)) as { html_url?: string; title?: string; number?: number };

	return {
		...issue,
		structuredContent: {
			url: issue.html_url,
			title: issue.title ?? title,
			number: issue.number,
		},
	};
}

async function getFileContents(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { owner, repo, path, ref } = args as {
		owner: string;
		repo: string;
		path: string;
		ref?: string;
	};
	if (!owner || !repo || !path) {
		throw new Error("owner, repo, and path are required");
	}

	const params: Record<string, string> = {};
	if (ref) {
		params.ref = ref;
	}

	const result = (await githubFetch(
		token,
		`/repos/${owner}/${repo}/contents/${path}`,
		params,
	)) as {
		content?: string;
		encoding?: string;
		sha: string;
		path: string;
		size: number;
		type: string;
		name: string;
		html_url: string;
	};

	// If it's a file, decode base64 content
	if (result.content && result.encoding === "base64") {
		const decoded = Buffer.from(result.content, "base64").toString("utf-8");
		return {
			path: result.path,
			sha: result.sha,
			size: result.size,
			content: decoded,
			url: result.html_url,
		};
	}

	// If it's a directory listing
	if (Array.isArray(result)) {
		return (
			result as Array<{
				name: string;
				path: string;
				type: string;
				size: number;
			}>
		).map((item) => ({
			name: item.name,
			path: item.path,
			type: item.type,
			size: item.size,
		}));
	}

	return result;
}

async function listBranches(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { owner, repo } = args as { owner: string; repo: string };
	if (!owner || !repo) {
		throw new Error("owner and repo are required");
	}

	const perPage = String(args.per_page || 30);

	const branches = (await githubFetch(
		token,
		`/repos/${owner}/${repo}/branches`,
		{ per_page: perPage },
	)) as Array<{
		name: string;
		protected: boolean;
		commit: { sha: string };
	}>;

	return branches.map((b) => ({
		name: b.name,
		protected: b.protected,
		sha: b.commit?.sha,
	}));
}

async function searchCommits(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { sha, query } = args as { sha?: string; query?: string };
	const searchQuery = sha || query;
	if (!searchQuery) {
		throw new Error("sha or query is required");
	}

	// GitHub commit search requires cloak-preview header
	const url = new URL(`${GITHUB_API_URL}/search/commits`);
	url.searchParams.set("q", searchQuery);
	url.searchParams.set("per_page", "5");

	const response = await fetch(url.toString(), {
		headers: {
			...githubHeaders(token),
			Accept: "application/vnd.github.cloak-preview+json",
		},
	});

	const data = (await response.json()) as {
		items?: Array<{
			sha: string;
			commit: {
				message: string;
				author: { name: string; email: string; date: string };
			};
			repository: {
				full_name: string;
				name: string;
				private: boolean;
				owner: { login: string };
			};
			html_url: string;
		}>;
		total_count?: number;
		message?: string;
	};

	if (!response.ok) {
		throw new GitHubApiError(
			data.message || `GitHub API error: ${response.status}`,
			response.status,
		);
	}

	const items = data.items ?? [];
	return {
		total_count: data.total_count ?? 0,
		commits: items.map((item) => ({
			sha: item.sha,
			message: item.commit?.message,
			author: item.commit?.author?.name,
			date: item.commit?.author?.date,
			repository: item.repository?.full_name,
			owner: item.repository?.owner?.login,
			repo: item.repository?.name,
			url: item.html_url,
		})),
	};
}

async function getCommit(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { owner, repo, ref } = args as {
		owner: string;
		repo: string;
		ref: string;
	};
	if (!owner || !repo || !ref) {
		throw new Error("owner, repo, and ref (commit SHA) are required");
	}

	const commit = (await githubFetch(
		token,
		`/repos/${owner}/${repo}/commits/${ref}`,
	)) as {
		sha: string;
		commit: {
			message: string;
			author: { name: string; email: string; date: string };
		};
		author: { login: string } | null;
		html_url: string;
		stats?: { additions: number; deletions: number; total: number };
		files?: Array<{
			filename: string;
			status: string;
			changes: number;
			additions: number;
			deletions: number;
			patch?: string;
		}>;
	};

	// Sort by change size (most changed first) and limit to 10 files
	// to keep context manageable for downstream analysis and diagram creation
	const sortedFiles = (commit.files ?? [])
		.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
		.slice(0, 10);

	return {
		sha: commit.sha,
		message: commit.commit?.message,
		author: commit.author?.login || commit.commit?.author?.name,
		date: commit.commit?.author?.date,
		url: commit.html_url,
		stats: commit.stats,
		// Include diff patches for the most significant files.
		// Keep patches short (400 chars) to preserve context for diagram creation.
		files: sortedFiles.map((f) => ({
			filename: f.filename,
			status: f.status,
			additions: f.additions,
			deletions: f.deletions,
			patch: f.patch
				? f.patch.length > 400
					? `${f.patch.slice(0, 400)}... (+${f.patch.length - 400} chars)`
					: f.patch
				: undefined,
		})),
		totalFiles: commit.files?.length ?? 0,
	};
}

async function getAuthenticatedUserInfo(
	token: string,
	_args: Record<string, unknown>,
): Promise<unknown> {
	const user = (await githubFetch(token, "/user")) as {
		login: string;
		name: string | null;
		email: string | null;
		avatar_url: string;
		html_url: string;
		public_repos: number;
		private_repos?: number;
		company: string | null;
	};

	return {
		login: user.login,
		name: user.name,
		email: user.email,
		url: user.html_url,
		public_repos: user.public_repos,
		company: user.company,
	};
}

// ============================================================================
// Direct API Functions (for project wizard repo picker etc.)
// ============================================================================

/**
 * Get the GitHub access token for a user's workflow integration.
 * Automatically refreshes the token if expired (GitHub App with expiring tokens).
 * Returns null if not configured.
 */
export async function getGitHubAccessToken(
	userId: string,
	organizationId?: string,
): Promise<string | null> {
	const integration = await db.workflowIntegration.findFirst({
		where: {
			userId,
			organizationId: organizationId ?? null,
			provider: "GITHUB",
			isActive: true,
		},
		select: { id: true, credentials: true, settings: true },
	});

	if (!integration?.credentials) {
		return null;
	}

	try {
		return await refreshTokenIfNeeded(integration, userId, organizationId);
	} catch {
		return null;
	}
}

/**
 * Get the authenticated GitHub user's info.
 */
export async function getAuthenticatedUser(
	token: string,
): Promise<{ login: string; name: string | null; avatar_url: string } | null> {
	try {
		const data = (await githubFetch(token, "/user")) as {
			login: string;
			name: string | null;
			avatar_url: string;
		};
		return data;
	} catch {
		return null;
	}
}

interface SearchRepoItem {
	name: string;
	full_name: string;
	description: string | null;
	private: boolean;
	html_url: string;
	language: string | null;
	default_branch: string;
	updated_at: string;
	stargazers_count: number;
	fork: boolean;
	owner: { login: string; avatar_url?: string };
}

/**
 * Search GitHub repositories using the Search API.
 */
export async function searchGitHubRepositories(
	token: string,
	query: string,
	perPage = 100,
): Promise<SearchRepoItem[]> {
	try {
		const data = (await githubFetch(token, "/search/repositories", {
			q: query,
			per_page: String(perPage),
			sort: "updated",
			order: "desc",
		})) as { items: SearchRepoItem[]; total_count: number };
		return data.items ?? [];
	} catch {
		return [];
	}
}

/**
 * List the authenticated user's repositories (all types).
 */
export async function listUserRepositories(
	token: string,
	perPage = 100,
): Promise<SearchRepoItem[]> {
	try {
		const repos = (await githubFetch(token, "/user/repos", {
			type: "all",
			sort: "updated",
			direction: "desc",
			per_page: String(perPage),
		})) as SearchRepoItem[];
		return repos;
	} catch {
		return [];
	}
}

export interface GitHubCompareResult {
	/** GitHub compare status: "identical" | "ahead" | "behind" | "diverged". */
	status: string;
	/** Commits `head` is ahead of `base` (new commits since `base`). */
	aheadBy: number;
	/** Commits `head` is behind `base` (history rewritten below `base`). */
	behindBy: number;
	totalCommits: number;
	/** Files changed between base and head (GitHub caps this at 300). */
	changedFiles: number;
	/** SHA of the head ref at compare time, when the range carried commits. */
	headSha: string | null;
}

/**
 * Compare two refs via `GET /repos/{owner}/{repo}/compare/{base}...{head}`.
 * Used to tell how far a repo's HEAD has moved past an indexed commit. Throws
 * `GitHubApiError` (with the HTTP status) on failure — e.g. a 404 when `base`
 * no longer exists after a force-push — so callers can degrade gracefully.
 */
export async function compareGitHubCommits(
	token: string,
	owner: string,
	repo: string,
	base: string,
	head: string,
): Promise<GitHubCompareResult> {
	const data = (await githubFetch(
		token,
		`/repos/${owner}/${repo}/compare/${base}...${head}`,
	)) as {
		status?: string;
		ahead_by?: number;
		behind_by?: number;
		total_commits?: number;
		files?: unknown[];
		commits?: Array<{ sha?: string }>;
	};
	const commits = data.commits ?? [];
	return {
		status: data.status ?? "unknown",
		aheadBy: data.ahead_by ?? 0,
		behindBy: data.behind_by ?? 0,
		totalCommits: data.total_commits ?? 0,
		changedFiles: Array.isArray(data.files) ? data.files.length : 0,
		headSha:
			commits.length > 0
				? (commits[commits.length - 1]?.sha ?? null)
				: null,
	};
}

// ============================================================================
// Main Executor
// ============================================================================

const TOOL_HANDLERS: Record<
	string,
	(token: string, args: Record<string, unknown>) => Promise<unknown>
> = {
	list_repositories: listRepositories,
	get_repository: getRepository,
	list_issues: listIssues,
	get_issue: getIssue,
	get_pull_request: getPullRequest,
	list_pull_requests: listPullRequests,
	create_pull_request: createPullRequest,
	create_issue: createIssue,
	get_file_contents: getFileContents,
	list_branches: listBranches,
	search_commits: searchCommits,
	get_commit: getCommit,
	get_authenticated_user: getAuthenticatedUserInfo,
};

/**
 * Parse a GitHub repository URL to extract owner and repo
 */
export function parseGitHubRepoUrl(
	url: string,
): { owner: string; repo: string } | null {
	// Handle various GitHub URL formats:
	// https://github.com/owner/repo
	// https://github.com/owner/repo.git
	// git@github.com:owner/repo.git
	const patterns = [
		/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i,
		/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
	];

	for (const pattern of patterns) {
		const match = url.match(pattern);
		if (match) {
			return { owner: match[1], repo: match[2] };
		}
	}
	return null;
}

/**
 * Fetch file content from GitHub
 */
export async function fetchFileContent(
	token: string,
	args: { owner: string; repo: string; path: string; ref?: string },
): Promise<{ content: string; path: string; size: number; url: string }> {
	const result = (await getFileContents(token, args)) as {
		content: string;
		path: string;
		size: number;
		url: string;
	};
	return result;
}

/**
 * Get GitHub token for a user/organization
 */
export async function getGitHubToken({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string;
}): Promise<string | null> {
	const integration = await db.workflowIntegration.findFirst({
		where: {
			userId,
			organizationId: organizationId ?? null,
			provider: "GITHUB",
			isActive: true,
		},
		select: { id: true, credentials: true, settings: true },
	});

	if (!integration?.credentials) {
		return null;
	}

	return refreshTokenIfNeeded(integration, userId, organizationId);
}

/**
 * Execute a GitHub tool using the user's OAuth credentials from WorkflowIntegration,
 * or from project-level credentials if provided.
 *
 * Automatically retries on 401 by refreshing the token (matching Microsoft Teams behavior).
 *
 * @param projectAccessToken - Pre-decrypted token from ProjectRepositoryIntegration.
 *   When provided, skips the WorkflowIntegration lookup entirely.
 */
export async function executeGitHubTool(
	methodName: string,
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
	projectAccessToken?: string,
): Promise<unknown> {
	const handler = TOOL_HANDLERS[methodName];
	if (!handler) {
		throw new Error(
			`Unknown GitHub tool: ${methodName}. Available tools: ${Object.keys(TOOL_HANDLERS).join(", ")}`,
		);
	}

	if (projectAccessToken) {
		// Project-level credentials — no refresh available, execute directly
		return handler(projectAccessToken, args);
	}

	// Get GitHub integration for token lookup and refresh
	const integration = await db.workflowIntegration.findFirst({
		where: {
			userId,
			organizationId: organizationId ?? null,
			provider: "GITHUB",
			isActive: true,
		},
		select: { id: true, credentials: true, settings: true },
	});

	if (!integration?.credentials) {
		throw new Error(
			"GitHub not connected. Please connect your GitHub account in Project Settings or Workflow Integrations.",
		);
	}

	let accessToken = await refreshTokenIfNeeded(
		integration,
		userId,
		organizationId,
	);

	// First attempt
	try {
		return await handler(accessToken, args);
	} catch (error) {
		// If 401 and we have a refresh token, try refreshing and retrying.
		// Re-read first: GitHub also rotates refresh tokens single-use, so the
		// pre-emptive refresh above (or a concurrent process) may already have
		// spent the one in our snapshot. Reusing it fails and surfaces a false
		// "reconnect your GitHub account" to a user whose connection is fine.
		if (error instanceof GitHubApiError && error.status === 401) {
			const fresh = await db.workflowIntegration.findUnique({
				where: { id: integration.id },
				select: { credentials: true },
			});
			const credentialsJson = decryptApiKey(
				fresh?.credentials ?? integration.credentials,
			);
			let refreshTokenValue: string | undefined;
			try {
				const parsed = JSON.parse(credentialsJson) as ParsedCredentials;
				refreshTokenValue =
					typeof parsed === "object" && parsed !== null
						? parsed.refresh_token
						: undefined;
			} catch {
				// Can't parse credentials for refresh token
			}

			if (refreshTokenValue) {
				console.log(
					`[GitHub] Got 401 for ${methodName}, attempting token refresh and retry...`,
				);
				try {
					accessToken = await refreshTokenWithLock(
						integration,
						refreshTokenValue,
						userId,
						organizationId,
					);
					return await handler(accessToken, args);
				} catch (refreshError) {
					console.error(
						"[GitHub] Token refresh after 401 failed:",
						refreshError,
					);
					throw new Error(
						"GitHub access token expired and refresh failed. " +
							"Please reconnect your GitHub account in Settings > Integrations.",
					);
				}
			}
		}

		// Not a 401, or no refresh token — rethrow original error
		throw error;
	}
}
