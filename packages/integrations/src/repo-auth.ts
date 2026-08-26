/**
 * Self-healing repository auth — the canonical place a usable code-repo
 * credential is resolved, shared by every consumer of a
 * `ProjectRepositoryIntegration` (clone paths, code search, indexing, daily
 * brief, security scans, the repo pickers).
 *
 * Canonical for `ProjectRepositoryIntegration` reads. It is NOT the only
 * credential path in the codebase, and the exceptions are load-bearing enough
 * to name precisely — an earlier version of this comment said "every consumer",
 * which was not true and cost a reviewer real time:
 *
 *  - `repo-health-check.ts` probes the live API and refreshes reactively on a
 *    401. Different pattern by design; reuses only the low-level exchange.
 *  - `packages/atlas/src/credentials.ts` layers a persisted cooldown plus
 *    status/notification handling for the Atlas UI, and duplicates this
 *    module's near-expiry buffer.
 *  - `daily-brief/resolve-repo-auth.ts` routes its GitLab OAuth branch straight
 *    to `getValidGitLabAccessToken` (correctly locked) rather than through
 *    here, so it can hand callers a lazy `getToken`.
 *  - The personal-connection (`WorkflowIntegration`) paths in
 *    `code-search-handler.ts` Strategy 2 and `code-indexing-trigger.ts`'s
 *    legacy indexing refresh GitHub only; their GitLab fallbacks still read
 *    the stored credential directly.
 *  - `MCPConfig` credentials are a separate store with no cross-process lock
 *    at all. Known gap, tracked separately.
 *
 * Why this must be central: GitHub App user-to-server access tokens expire
 * after 8 HOURS. A consumer that decrypts `encryptedAccessToken` directly gets
 * a token that is dead for all but the first 8 hours of a connection's life,
 * and stays dead until some *other* code path happens to refresh it. Refresh
 * therefore cannot be opt-in per call site — every read goes through
 * `resolveFreshRepoTokenForRow` (row in hand) or `resolveFreshRepoToken`
 * (integration id only), and both refresh when the stored token is near expiry.
 *
 * A `git clone` for a project repo can fail with "Authentication failed" even
 * though the integration row read ACTIVE at request time: the stored OAuth
 * access token is dead for the clone (rotated/revoked, or an org-SSO
 * de-authorization the lightweight `GET /user` health probe never sees). The
 * status / health-check self-heal paths key off `status` + `tokenExpiresAt`, so
 * they can't catch this — the clone is the first thing that actually exercises
 * repo-scoped access. This module gives clone paths the primitives to stay
 * fresh, recover, or fail cleanly and actionably:
 *
 *  - `resolveFreshRepoToken` PROACTIVELY resolves a usable token before the
 *    clone, refreshing a near-expiry GitHub/GitLab OAuth token through the
 *    shared OAuth primitives (never its own exchange) and falling back to the
 *    stored token when refresh isn't possible.
 *  - `forceReExchangeRepoCredentials` forces a REAL OAuth token re-exchange
 *    (bypassing the "looks-unexpired" reuse short-circuit) so a single clone
 *    retry can self-heal a token that lapsed while the row still looked valid.
 *    It REUSES `refreshProjectRepoGitHubToken` (GitHub) / `getValidGitLabAccessToken`
 *    (GitLab); it never does its own exchange.
 *  - `markRepoReauthRequired` flips the integration to TOKEN_EXPIRED and fires
 *    the credential-expiry notification once, on a genuine transition INTO that
 *    state, when recovery isn't possible — so the UI surfaces an actionable
 *    "Reconnect" state and the configuring user is told.
 *  - `buildAuthCloneUrl` / `isGitAuthError` are the shared clone-URL builder and
 *    auth-error classifier both clone paths use.
 *
 * The recovery helpers are best-effort and NEVER throw — a recovery attempt
 * must never mask the underlying clone failure with an error of its own.
 */
import {
	createRepoIntegrationCredentialNotification,
	db,
	setIntegrationStatus,
} from "@repo/database";
import type {
	RepositoryAuthMethod,
	RepositoryProvider,
} from "@repo/database/prisma/zod";
import { decryptApiKey } from "@repo/utils";
import { refreshProjectRepoGitHubTokenWithOutcome } from "./github/index";
import {
	GitLabReauthRequiredError,
	getValidGitLabAccessToken,
	refreshGitLabToken,
} from "./gitlab/index";
import type { RepoTokenRefreshFault } from "./repo-token-refresh-fault";

export function buildAuthCloneUrl(
	provider: string,
	repositoryUrl: string,
	token: string,
): string {
	const url = new URL(repositoryUrl);
	if (provider === "AZURE_DEVOPS") {
		url.username = "pat";
		url.password = token;
	} else if (provider === "GITLAB") {
		url.username = "oauth2";
		url.password = token;
	} else {
		// GITHUB and anything else that accepts token-as-password basic auth.
		url.username = "x-access-token";
		url.password = token;
	}
	return url.toString();
}

/**
 * A `git` transport AUTHENTICATION failure (dead/rotated token, revoked grant,
 * unauthorized org SSO) — as opposed to a network/disk/parse error or a user
 * cancel. Matched on the message text simple-git surfaces from the underlying
 * `git` process. Deliberately excludes rate-limit 403s (which carry no auth
 * wording) so a quota wall is never mistaken for a dead credential.
 */
export function isGitAuthError(error: unknown): boolean {
	const message = (
		error instanceof Error ? error.message : String(error)
	).toLowerCase();
	return (
		message.includes("authentication failed") ||
		message.includes("could not read username") ||
		message.includes("could not read password") ||
		message.includes("terminal prompts disabled") ||
		message.includes("invalid username or password") ||
		message.includes("invalid username or token") ||
		message.includes("http basic: access denied")
	);
}

/**
 * Decrypt a stored credential, distinguishing WHY a null comes back: no
 * ciphertext was ever stored, vs. ciphertext was stored but `decryptApiKey`
 * threw. Card #2383: a caller that only sees `token: null` cannot tell "this
 * customer never connected a working credential" (their problem) from "our
 * encryption key is lost/rotated and NOTHING decrypts anymore" (a platform
 * fault, and every tenant's at once) — see `ResolvedRepoToken.credentialFault`.
 */
function safeDecrypt(encrypted: string | null): {
	token: string | null;
	fault?: "DECRYPT_FAILED";
} {
	if (!encrypted) {
		return { token: null };
	}
	try {
		return { token: decryptApiKey(encrypted) };
	} catch {
		return { token: null, fault: "DECRYPT_FAILED" };
	}
}

/**
 * `safeDecrypt`'s result, reshaped into the `{ token, credentialFault }`
 * fragment every `resolveFreshRepoTokenForRow` branch spreads into its
 * returned `ResolvedRepoToken`. `credentialFault` is set ONLY when `token` is
 * null — a successful decrypt never carries a fault.
 */
function decryptedField(encrypted: string | null): {
	token: string | null;
	credentialFault?: "ABSENT" | "DECRYPT_FAILED";
} {
	const { token, fault } = safeDecrypt(encrypted);
	if (token !== null) {
		return { token };
	}
	return { token: null, credentialFault: fault ?? "ABSENT" };
}

/**
 * Resolve a currently-valid GitLab OAuth access token for a project-repo
 * integration, refreshing through the shared single-flight helper when the
 * stored token is near expiry. Requires env-configured client credentials;
 * returns a null token when they're missing or the exchange fails (caller falls
 * back to the stored token). Never throws.
 *
 * The GitLab path carries the SAME hazard as GitHub's (see
 * `RepoTokenRefreshFault`): missing `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET`
 * is a deployment misconfiguration, not a customer problem, and it fails every
 * GitLab integration on the deployment at once. `getValidGitLabAccessToken`
 * throws on failure rather than returning null, which makes the seam unusually
 * clean: `GitLabReauthRequiredError` is the ONE throw that means the customer's
 * grant is genuinely dead (`invalid_grant` / `invalid_token`, and its own doc
 * records that it is deliberately not raised for a bare 401/403). Everything
 * else reaching this catch — a network failure, a 5xx, a database error — is
 * ours.
 */
async function resolveValidGitLabToken(integrationId: string): Promise<{
	token: string | null;
	platformFault?: RepoTokenRefreshFault;
}> {
	const clientId = process.env.GITLAB_CLIENT_ID;
	const clientSecret = process.env.GITLAB_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		return { token: null, platformFault: "MISSING_CLIENT_CREDENTIALS" };
	}
	try {
		return {
			token: await getValidGitLabAccessToken({
				// Cast matches the convention at the other production call sites (the
				// repo-health-check activity, gitlab-oauth): the structural db type in
				// get-valid-access-token.ts uses `args: unknown` accessors the real
				// PrismaClient doesn't satisfy without help.
				db: db as never,
				integrationId,
				clientId,
				clientSecret,
				source: "project",
				refresh: refreshGitLabToken,
			}),
		};
	} catch (error) {
		console.warn("[repo-auth] GitLab token resolution failed", {
			integrationId,
			error: error instanceof Error ? error.message : String(error),
		});
		if (error instanceof GitLabReauthRequiredError) {
			return { token: null };
		}
		return { token: null, platformFault: "INTERNAL" };
	}
}

/**
 * A stored access token expiring within this window counts as near-expiry and
 * is proactively refreshed. Matches the buffer the project-repo refresh helper
 * uses to decide a concurrent refresher's token is still fresh, so the two
 * agree on what "needs refreshing" means.
 */
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

/**
 * The credential columns every repo-auth consumer needs. Structurally satisfied
 * by `getProjectReposForCodeSearch()` rows and by a direct
 * `projectRepositoryIntegration` select — so callers that already hold a row
 * resolve a token without paying for a second read.
 */
export interface RepoCredentialRow {
	integrationId: string;
	provider: RepositoryProvider;
	authMethod: RepositoryAuthMethod;
	encryptedAccessToken: string | null;
	encryptedRefreshToken: string | null;
	encryptedPat: string | null;
	tokenExpiresAt: Date | null;
	updatedAt: Date;
}

export interface ResolvedRepoToken {
	token: string | null;
	authMethod: RepositoryAuthMethod | null;
	provider: RepositoryProvider | null;
	/**
	 * True when `token` is the stored credential handed back after a refresh
	 * failed AND the stored token is already past its expiry — i.e. it is very
	 * likely dead.
	 *
	 * It is still returned rather than nulled because the clone paths recover by
	 * *using* it: a `git` auth failure is what drives
	 * `forceReExchangeRepoCredentials`. But a caller with a working alternative
	 * credential (the code-search route's personal-OAuth fallback) must be able
	 * to tell "probably dead" from "fine", or it would return the dead token and
	 * never reach the alternative.
	 */
	stale?: boolean;
	/**
	 * Set ONLY when `token` is null, distinguishing WHY: `"ABSENT"` when there
	 * was no ciphertext to decrypt (a genuinely missing credential — the
	 * customer's to fix), vs `"DECRYPT_FAILED"` when ciphertext was present but
	 * `decryptApiKey` threw (a platform fault — a lost/rotated encryption key,
	 * corrupted ciphertext — never the customer's to fix, and never something
	 * reconnecting the repository can repair). `sync-pipeline-results.ts` reads
	 * this to keep a platform-wide decryption outage from misclassifying as
	 * "every customer's credential went missing at once" — which would log the
	 * outage at warn instead of error and tell every affected customer to
	 * reconnect a repository that reconnecting cannot fix.
	 */
	credentialFault?: "ABSENT" | "DECRYPT_FAILED";
	/**
	 * Set when we ATTEMPTED to refresh this credential and the attempt failed
	 * for a reason that is ours, not the customer's — no deployment OAuth client
	 * credentials, a token-endpoint outage, our own database throwing. See
	 * `RepoTokenRefreshFault`.
	 *
	 * Unlike `credentialFault`, this can accompany a NON-null `token`: the
	 * fallback on a failed refresh is to hand back the stored (likely expired)
	 * access token, so the caller still gets something to try. That is exactly
	 * why the flag has to travel with it — the provider will answer 401, and a
	 * consumer reading only the 401 would blame the customer's credential for a
	 * fault that hit every integration on the deployment at once.
	 *
	 * Absent means no refresh was attempted, the refresh succeeded, OR it failed
	 * for a reason this type does not distinguish. That last case is NOT proof
	 * the customer's grant is dead: it also covers ambiguous and request-side
	 * codes (a bare 4xx, `invalid_request`) where blaming either party is a
	 * guess. `refreshProjectRepoGitHubTokenWithOutcome` returns a positive
	 * `grantRejected` for the genuine article, but this type does not yet carry
	 * it, so a consumer here cannot tell "the customer must reconnect" apart
	 * from "we could not tell". Treat absence as "no verdict" and reserve
	 * reconnect prompts for a positive rejection — see the scheduled repo
	 * health check for the three-outcome shape this should grow into.
	 */
	refreshFault?: RepoTokenRefreshFault;
}

/**
 * True when the stored access token is at or near its expiry, OR when we do not
 * know its expiry at all.
 *
 * Unknown expiry must mean "refresh", not "never expires". Both providers issue
 * tokens that DO expire (GitHub App ~8h, GitLab ~2h), and both connect flows
 * legitimately persist `tokenExpiresAt: null` when the provider's token
 * response omits `expires_in` — see the GitLab OAuth callback. Reading null as
 * long-lived meant such a row was never refreshed and served a dead token
 * indefinitely. `getValidGitLabAccessToken` already treats unknown expiry as
 * needs-refresh; this now agrees with it instead of short-circuiting before it
 * gets the chance to run.
 *
 * This is only ever consulted for OAuth rows that carry a refresh token —
 * PAT rows return earlier and genuinely have no expiry — so a long-lived
 * credential is never pointlessly refreshed.
 */
export function isRepoTokenNearExpiry(row: {
	tokenExpiresAt: Date | null;
}): boolean {
	if (!row.tokenExpiresAt) {
		return true;
	}
	return row.tokenExpiresAt.getTime() <= Date.now() + TOKEN_REFRESH_BUFFER_MS;
}

/** True only when the stored access token is ACTUALLY past its expiry. */
function isHardExpired(row: { tokenExpiresAt: Date | null }): boolean {
	return (
		row.tokenExpiresAt != null && row.tokenExpiresAt.getTime() <= Date.now()
	);
}

/**
 * Resolve a currently-usable token from a credential row the caller already
 * holds. This is the canonical read — see the module doc for why no consumer
 * may decrypt `encryptedAccessToken` itself.
 *
 * PATs are returned as stored. GitHub OAuth rows refresh through the shared
 * CAS-protected helper when near expiry; GitLab OAuth rows resolve through the
 * shared single-flight helper (which does its own expiry check). When a refresh
 * fails but the stored token has not *actually* expired yet — we were only
 * inside the proactive buffer — the stored token is reused, so a transient
 * GitHub 5xx or a missing app credential does not yank access away up to a
 * minute early. Never throws.
 */
export async function resolveFreshRepoTokenForRow(
	row: RepoCredentialRow,
	ctx?: { userId?: string | null; organizationId?: string | null },
): Promise<ResolvedRepoToken> {
	const { provider, authMethod } = row;

	if (authMethod === "PAT") {
		return { ...decryptedField(row.encryptedPat), authMethod, provider };
	}

	if (provider === "GITHUB" && row.encryptedRefreshToken) {
		if (!isRepoTokenNearExpiry(row)) {
			return {
				...decryptedField(row.encryptedAccessToken),
				authMethod,
				provider,
			};
		}
		// Never throws (reports a null token on failure).
		const refreshed = await refreshProjectRepoGitHubTokenWithOutcome({
			integrationId: row.integrationId,
			encryptedRefreshToken: row.encryptedRefreshToken,
			expectedUpdatedAt: row.updatedAt,
			userId: ctx?.userId ?? undefined,
			organizationId: ctx?.organizationId ?? undefined,
		});
		if (refreshed.token) {
			return { token: refreshed.token, authMethod, provider };
		}
		// Refresh failed — hand back the stored token anyway. `tokenExpiresAt`
		// is only our estimate (it is a synthesized 8h guess whenever GitHub
		// omitted `expires_in`), so the stored token may well still work; and
		// when it does not, the clone paths' auth-error detection drives
		// `forceReExchangeRepoCredentials` into a real recovery. Returning null
		// here would deny them the attempt that triggers that self-heal — but
		// flag it stale so a caller holding a working alternative can prefer it.
		return {
			...decryptedField(row.encryptedAccessToken),
			authMethod,
			provider,
			stale: isHardExpired(row),
			// Travels WITH the fallback token: the provider is about to reject
			// it, and only this says whether that rejection is the customer's
			// grant or our failed refresh.
			refreshFault: refreshed.platformFault,
		};
	}

	if (provider === "GITLAB") {
		// Same near-expiry gate as GitHub: without it every GitLab read pays for
		// `getValidGitLabAccessToken`'s own row re-read, even for a healthy token.
		if (!isRepoTokenNearExpiry(row)) {
			return {
				...decryptedField(row.encryptedAccessToken),
				authMethod,
				provider,
			};
		}
		const gitlab = await resolveValidGitLabToken(row.integrationId);
		if (gitlab.token) {
			return { token: gitlab.token, authMethod, provider };
		}
		return {
			...decryptedField(row.encryptedAccessToken),
			authMethod,
			provider,
			stale: isHardExpired(row),
			refreshFault: gitlab.platformFault,
		};
	}

	// GitHub without a stored refresh token, Azure DevOps under OAuth, or any
	// other shape — best-effort decrypt of the stored access token.
	return {
		...decryptedField(row.encryptedAccessToken),
		authMethod,
		provider,
	};
}

/**
 * Resolve a fresh, usable token for a project-repo integration by id. Scoped to
 * `projectId` so an integration id can't resolve a token for another project's
 * row. Delegates to `resolveFreshRepoTokenForRow` — prefer that directly when
 * you already hold the row.
 */
export async function resolveFreshRepoToken(input: {
	integrationId: string;
	projectId: string;
	userId?: string | null;
	organizationId?: string | null;
}): Promise<ResolvedRepoToken> {
	const row = await db.projectRepositoryIntegration.findFirst({
		where: { id: input.integrationId, projectId: input.projectId },
		select: {
			provider: true,
			authMethod: true,
			encryptedAccessToken: true,
			encryptedRefreshToken: true,
			encryptedPat: true,
			tokenExpiresAt: true,
			updatedAt: true,
		},
	});
	if (!row) {
		return { token: null, authMethod: null, provider: null };
	}
	return resolveFreshRepoTokenForRow(
		{ ...row, integrationId: input.integrationId },
		{ userId: input.userId, organizationId: input.organizationId },
	);
}

/**
 * Force a fresh OAuth access token for a project-repo integration even when the
 * stored one still looks unexpired. Returns whether a usable token was minted;
 * the caller re-reads credentials (via `resolveFreshRepoToken`) after a success.
 * GitHub OAuth rows re-exchange via `refreshProjectRepoGitHubToken`
 * (`forceReExchange: true`); GitLab OAuth rows resolve a valid token via the
 * shared GitLab helper; every other shape (PAT, missing refresh token) resolves
 * `{ refreshed: false }`. Best-effort: never throws.
 */
export async function forceReExchangeRepoCredentials(input: {
	integrationId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<{ refreshed: boolean }> {
	try {
		const row = await db.projectRepositoryIntegration.findUnique({
			where: { id: input.integrationId },
			select: {
				provider: true,
				authMethod: true,
				encryptedRefreshToken: true,
				updatedAt: true,
			},
		});
		if (!row || row.authMethod !== "OAUTH" || !row.encryptedRefreshToken) {
			return { refreshed: false };
		}
		if (row.provider === "GITHUB") {
			const { token } = await refreshProjectRepoGitHubTokenWithOutcome({
				integrationId: input.integrationId,
				encryptedRefreshToken: row.encryptedRefreshToken,
				expectedUpdatedAt: row.updatedAt,
				userId: input.userId,
				organizationId: input.organizationId ?? undefined,
				// We have PROOF (a clone auth failure) the stored token is dead, so a
				// not-yet-elapsed `tokenExpiresAt` must not short-circuit the exchange.
				forceReExchange: true,
			});
			return { refreshed: Boolean(token) };
		}
		if (row.provider === "GITLAB") {
			const { token } = await resolveValidGitLabToken(
				input.integrationId,
			);
			return { refreshed: Boolean(token) };
		}
		return { refreshed: false };
	} catch (error) {
		console.warn("[repo-auth] forced credential re-exchange failed", {
			integrationId: input.integrationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { refreshed: false };
	}
}

/**
 * Flag a project-repo integration as needing a user reconnect (TOKEN_EXPIRED)
 * and fire the credential-expiry notification ONCE, on a genuine transition INTO
 * that state. Mirrors the dead-token branch in the on-demand refresh helper —
 * same per-integration dedupe-keyed notification, so racing paths never double
 * a row. Best-effort: never throws.
 */
export async function markRepoReauthRequired(input: {
	integrationId: string;
	reason: string;
}): Promise<void> {
	try {
		const statusResult = await setIntegrationStatus(
			input.integrationId,
			"TOKEN_EXPIRED",
			input.reason,
		);
		// The scheduled health check notifies on transition only; this path
		// consumed the ACTIVE→TOKEN_EXPIRED flip, so it must own the notification
		// or the configuring user would never hear about it.
		if (
			statusResult.statusChanged &&
			statusResult.previousStatus !== "TOKEN_EXPIRED"
		) {
			await notifyReauthRequired(input.integrationId);
		}
	} catch (error) {
		console.warn("[repo-auth] mark-reauth-required failed", {
			integrationId: input.integrationId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Best-effort credential-expiry notification to the configuring user — same
 * recipient, deep link, and dedupe-keyed helper the repo health check and the
 * on-demand refresh use. Never throws.
 */
async function notifyReauthRequired(integrationId: string): Promise<void> {
	try {
		const integration = await db.projectRepositoryIntegration.findUnique({
			where: { id: integrationId },
			select: {
				projectId: true,
				provider: true,
				repositoryOwner: true,
				repositoryName: true,
				configuredByUserId: true,
				project: { select: { name: true, organizationId: true } },
			},
		});
		// No configuring user (removed) ⇒ no actionable recipient.
		if (!integration?.configuredByUserId) {
			return;
		}
		await createRepoIntegrationCredentialNotification({
			recipientUserId: integration.configuredByUserId,
			organizationId: integration.project.organizationId ?? null,
			integrationId,
			projectId: integration.projectId,
			projectName: integration.project.name,
			provider: integration.provider,
			repositoryOwner: integration.repositoryOwner,
			repositoryName: integration.repositoryName,
			status: "TOKEN_EXPIRED",
			// Context-relative deep link to the project's Settings tab — the same
			// target the health-check + on-demand-refresh notifications use.
			link: `projects/${integration.projectId}?tab=settings`,
		});
	} catch (error) {
		console.warn(
			"[repo-auth] reauth-required notification dispatch failed",
			{
				integrationId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}
