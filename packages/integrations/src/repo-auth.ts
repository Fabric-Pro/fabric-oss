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
 * must never mask the underlying clone failure with an error of its own. The
 * one exception is a caller's own `signal`: `resolveFreshRepoToken`,
 * `forceReExchangeRepoCredentials` and `markRepoReauthRequired` accept one,
 * check it between their steps, and throw its `reason` once it has aborted,
 * so a cancelled or out-of-time caller starts no refresh, status write or
 * notification (see `stopIfAborted`). An exchange and the write persisting
 * it, or a status write, already under way runs to its end first; the reason
 * is thrown after it. The reauth notification starts only after the
 * post-write signal check and is waited for only within its own bound. The
 * token helpers also
 * accept a pre-exchange gate (`BeforeExchange`), consulted under the
 * provider's lock immediately before an exchange; what it throws is thrown
 * unchanged.
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
import {
	type BeforeExchange,
	isExchangeRefusal,
	runExchangeGate,
} from "./exchange-gate";
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
 *
 * A GitHub organization's SAML SSO wall arrives as a 403 whose `remote:`
 * lines say "enabled or enforced SAML SSO", "Resource protected by
 * organization SAML enforcement" or "you must re-authorize the OAuth
 * Application": the credential must be re-authorized, so it counts as an
 * authentication failure here (Fizzy #2563), never as a write refusal.
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
		message.includes("http basic: access denied") ||
		message.includes("saml sso") ||
		message.includes("saml enforcement") ||
		message.includes("must re-authorize the oauth application")
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
 * Throws the caller's abort reason once `signal` has aborted. The repo-auth
 * helpers call it between steps: a step already under way is left to finish
 * (a token exchange spends a single-use refresh token, so abandoning one
 * after it was sent can lose the rotated grant), but none starts after.
 */
function stopIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw signal.reason;
	}
}

/** True when `error` is the abort reason of the caller's own signal. */
function isCallerAbort(
	signal: AbortSignal | undefined,
	error: unknown,
): boolean {
	return signal?.aborted === true && error === signal.reason;
}

/**
 * The caller's gate as handed to a provider refresh: consulted through
 * `runExchangeGate` so its refusal is recognized at this layer whatever the
 * refresh does with it.
 */
function gated(gate: BeforeExchange | undefined): BeforeExchange | undefined {
	return gate && (() => runExchangeGate(gate));
}

/**
 * Resolve a currently-valid GitLab OAuth access token for a project-repo
 * integration, refreshing through the shared single-flight helper when the
 * stored token is near expiry. Requires env-configured client credentials;
 * returns a null token when they're missing or the exchange fails (caller falls
 * back to the stored token). Never throws, except the caller's own `signal`
 * reason and what its `beforeExchange` throws to refuse an exchange.
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
async function resolveValidGitLabToken(
	integrationId: string,
	signal?: AbortSignal,
	beforeExchange?: BeforeExchange,
): Promise<{
	token: string | null;
	platformFault?: RepoTokenRefreshFault;
}> {
	// The GitLab refresh is a single-flight shared by every concurrent caller
	// in this process, so one caller's signal is checked before it and never
	// passed into it; its gate is consulted only if it leads the flight.
	stopIfAborted(signal);
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
				beforeExchange: gated(beforeExchange),
			}),
		};
	} catch (error) {
		if (isExchangeRefusal(error)) {
			throw error;
		}
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
 * minute early. Never throws, except the caller's own `signal` reason once it
 * has aborted: checked before a refresh starts and again after it ends (an
 * exchange already sent runs to its end and persists its result first), and
 * passed into GitHub's; and what `beforeExchange` throws to refuse an
 * exchange. A PAT or still-fresh token never consults it.
 */
export async function resolveFreshRepoTokenForRow(
	row: RepoCredentialRow,
	ctx?: {
		userId?: string | null;
		organizationId?: string | null;
		signal?: AbortSignal;
		/** Consulted immediately before an exchange; see `BeforeExchange`. */
		beforeExchange?: BeforeExchange;
	},
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
		// Never throws (reports a null token on failure), except the caller's
		// own abort reason.
		stopIfAborted(ctx?.signal);
		const refreshed = await refreshProjectRepoGitHubTokenWithOutcome({
			signal: ctx?.signal,
			beforeExchange: gated(ctx?.beforeExchange),
			integrationId: row.integrationId,
			encryptedRefreshToken: row.encryptedRefreshToken,
			expectedUpdatedAt: row.updatedAt,
			userId: ctx?.userId ?? undefined,
			organizationId: ctx?.organizationId ?? undefined,
		});
		// The refresh ran to its end and persisted what it rotated; a caller
		// that aborted meanwhile gets its reason, not a token.
		stopIfAborted(ctx?.signal);
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
		const gitlab = await resolveValidGitLabToken(
			row.integrationId,
			ctx?.signal,
			ctx?.beforeExchange,
		);
		stopIfAborted(ctx?.signal);
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
	/** Checked between steps; its reason is thrown once it has aborted. */
	signal?: AbortSignal;
	/** Consulted immediately before an exchange; see `BeforeExchange`. */
	beforeExchange?: BeforeExchange;
}): Promise<ResolvedRepoToken> {
	stopIfAborted(input.signal);
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
	stopIfAborted(input.signal);
	if (!row) {
		return { token: null, authMethod: null, provider: null };
	}
	return resolveFreshRepoTokenForRow(
		{ ...row, integrationId: input.integrationId },
		{
			userId: input.userId,
			organizationId: input.organizationId,
			signal: input.signal,
			beforeExchange: input.beforeExchange,
		},
	);
}

/**
 * Force a fresh OAuth access token for a project-repo integration even when the
 * stored one still looks unexpired. Returns whether a usable token was minted;
 * the caller re-reads credentials (via `resolveFreshRepoToken`) after a success.
 * GitHub OAuth rows re-exchange via `refreshProjectRepoGitHubToken`
 * (`forceReExchange: true`); GitLab OAuth rows resolve a valid token via the
 * shared GitLab helper; every other shape (PAT, missing refresh token) resolves
 * `{ refreshed: false }`. Best-effort: never throws, except the caller's own
 * `signal` reason once it has aborted (checked before the read, before the
 * exchange and after it has ended and persisted, and passed into GitHub's
 * refresh), and what `beforeExchange` throws to refuse the exchange.
 */
export async function forceReExchangeRepoCredentials(input: {
	integrationId: string;
	userId: string;
	organizationId?: string | null;
	signal?: AbortSignal;
	/** Consulted immediately before the exchange; see `BeforeExchange`. */
	beforeExchange?: BeforeExchange;
}): Promise<{ refreshed: boolean }> {
	try {
		stopIfAborted(input.signal);
		const row = await db.projectRepositoryIntegration.findUnique({
			where: { id: input.integrationId },
			select: {
				provider: true,
				authMethod: true,
				encryptedRefreshToken: true,
				updatedAt: true,
			},
		});
		stopIfAborted(input.signal);
		if (!row || row.authMethod !== "OAUTH" || !row.encryptedRefreshToken) {
			return { refreshed: false };
		}
		if (row.provider === "GITHUB") {
			const { token } = await refreshProjectRepoGitHubTokenWithOutcome({
				signal: input.signal,
				beforeExchange: gated(input.beforeExchange),
				integrationId: input.integrationId,
				encryptedRefreshToken: row.encryptedRefreshToken,
				expectedUpdatedAt: row.updatedAt,
				userId: input.userId,
				organizationId: input.organizationId ?? undefined,
				// We have PROOF (a clone auth failure) the stored token is dead, so a
				// not-yet-elapsed `tokenExpiresAt` must not short-circuit the exchange.
				forceReExchange: true,
			});
			stopIfAborted(input.signal);
			return { refreshed: Boolean(token) };
		}
		if (row.provider === "GITLAB") {
			const { token } = await resolveValidGitLabToken(
				input.integrationId,
				input.signal,
				input.beforeExchange,
			);
			stopIfAborted(input.signal);
			return { refreshed: Boolean(token) };
		}
		return { refreshed: false };
	} catch (error) {
		if (isCallerAbort(input.signal, error) || isExchangeRefusal(error)) {
			throw error;
		}
		console.warn("[repo-auth] forced credential re-exchange failed", {
			integrationId: input.integrationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { refreshed: false };
	}
}

/** Pool admission for the reauth status write's transaction. */
const REAUTH_WRITE_MAX_WAIT_MS = 5_000;
/** The reauth status write's transaction: a read and a conditional update. */
const REAUTH_WRITE_TIMEOUT_MS = 5_000;
/**
 * Each statement inside that transaction. Under its timeout, so the server
 * stops a stuck statement itself instead of leaving it to the rollback.
 */
const REAUTH_STATEMENT_TIMEOUT_MS = 4_000;

/**
 * The longest `markRepoReauthRequired`'s status write can take once begun:
 * pool admission plus its transaction, after which it has committed or
 * rolled back.
 */
export const REPO_REAUTH_WRITE_BOUND_MS =
	REAUTH_WRITE_MAX_WAIT_MS + REAUTH_WRITE_TIMEOUT_MS;

/**
 * The longest the notification after a transition is waited for: its
 * integration read, recipient resolution, preference lookup and fan-out
 * together. Past it (or once the caller stops) the notification is skipped.
 */
export const REPO_REAUTH_NOTIFY_BOUND_MS = 10_000;

/**
 * The longest `markRepoReauthRequired` can take once begun: the bounded
 * status write, then the bounded notification. A caller with a deadline
 * starts it only with this much left.
 */
export const REPO_REAUTH_STEP_BOUND_MS =
	REPO_REAUTH_WRITE_BOUND_MS + REPO_REAUTH_NOTIFY_BOUND_MS;

/**
 * Flag a project-repo integration as needing a user reconnect (TOKEN_EXPIRED)
 * and fire the credential-expiry notification ONCE, on a genuine transition INTO
 * that state. Mirrors the dead-token branch in the on-demand refresh helper —
 * same per-integration dedupe-keyed notification, so racing paths never double
 * a row. The whole step is bounded by `REPO_REAUTH_STEP_BOUND_MS`.
 *
 * The status write commits or rolls back within `REPO_REAUTH_WRITE_BOUND_MS`.
 * The notification is owned by the transition that write made, and is
 * best-effort: the committed status row is what drives the UI's reconnect
 * prompt. It starts only if the caller has not stopped meanwhile, is waited
 * for at most `REPO_REAUTH_NOTIFY_BOUND_MS`, and when cut short is skipped
 * with one info event rather than retried or queued.
 *
 * Never throws, except the caller's own `signal` reason once it has aborted:
 * before the write, between the committed write and the notification, or by
 * the time the step ends.
 */
export async function markRepoReauthRequired(input: {
	integrationId: string;
	reason: string;
	signal?: AbortSignal;
}): Promise<void> {
	stopIfAborted(input.signal);
	let transitioned = false;
	try {
		// Bounded: committed within REPO_REAUTH_WRITE_BOUND_MS of starting or
		// rolled back, so nothing lands after a caller's deadline that sized
		// its reserve to it.
		const statusResult = await db.$transaction(
			async (tx) => {
				await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${REAUTH_STATEMENT_TIMEOUT_MS}ms`}, true)`;
				return setIntegrationStatus(
					input.integrationId,
					"TOKEN_EXPIRED",
					input.reason,
					undefined,
					undefined,
					tx,
				);
			},
			{
				timeout: REAUTH_WRITE_TIMEOUT_MS,
				maxWait: REAUTH_WRITE_MAX_WAIT_MS,
			},
		);
		// The scheduled health check notifies on transition only; this path
		// consumed the ACTIVE→TOKEN_EXPIRED flip, so it owns the notification.
		transitioned =
			statusResult.statusChanged &&
			statusResult.previousStatus !== "TOKEN_EXPIRED";
	} catch (error) {
		console.warn("[repo-auth] mark-reauth-required failed", {
			integrationId: input.integrationId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	// The transition, if any, is durable. A caller that stopped meanwhile
	// gets its reason and starts no notification.
	stopIfAborted(input.signal);
	if (transitioned) {
		await notifyReauthRequired(input.integrationId, input.signal);
	}
	// A caller that stopped during the notification (which was then cut and
	// logged) still gets its reason.
	stopIfAborted(input.signal);
}

/** Why a reauth notification was skipped: the only detail its event logs. */
type NotificationSkip = "timeout" | "aborted";

/**
 * Starts `start()` only while `bound` is live, then races it against the
 * bound: rejects with the bound's reason once it aborts, leaving the work
 * unobserved. Prisma's reads and the notification fan-out take no signal,
 * so the race is what enforces the bound, and the lazy start is what keeps
 * any of them from beginning once it is spent.
 */
function withinBound<T>(
	start: () => Promise<T>,
	bound: AbortSignal,
): Promise<T> {
	if (bound.aborted) {
		return Promise.reject(bound.reason);
	}
	const work = start();
	// A result or failure that lands after the bound must not surface as an
	// unhandled rejection.
	work.catch(() => {});
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(bound.reason);
		bound.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				bound.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				bound.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Best-effort credential-expiry notification to the configuring user — same
 * recipient, deep link, and dedupe-keyed helper the repo health check and the
 * on-demand refresh use. Bounded: every step runs under one
 * `REPO_REAUTH_NOTIFY_BOUND_MS` deadline combined with the caller's signal,
 * and a notification cut short is skipped with one info event. Never throws.
 */
async function notifyReauthRequired(
	integrationId: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	// A timer rather than `AbortSignal.timeout`: the same deadline, and one
	// the tests' fake clock controls.
	const deadline = new AbortController();
	const timer = setTimeout(
		() => deadline.abort(new Error("reauth notification bound")),
		REPO_REAUTH_NOTIFY_BOUND_MS,
	);
	const bound = signal
		? AbortSignal.any([deadline.signal, signal])
		: deadline.signal;
	try {
		const integration = await withinBound(
			() =>
				db.projectRepositoryIntegration.findUnique({
					where: { id: integrationId },
					select: {
						projectId: true,
						provider: true,
						repositoryOwner: true,
						repositoryName: true,
						configuredByUserId: true,
						project: {
							select: { name: true, organizationId: true },
						},
					},
				}),
			bound,
		);
		// No configuring user (removed) ⇒ no actionable recipient.
		const recipientUserId = integration?.configuredByUserId;
		if (!integration || !recipientUserId) {
			return;
		}
		await withinBound(
			() =>
				createRepoIntegrationCredentialNotification({
					recipientUserId,
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
				}),
			bound,
		);
	} catch (error) {
		if (bound.aborted) {
			const reason: NotificationSkip = signal?.aborted
				? "aborted"
				: "timeout";
			// The committed status row already drives the reconnect prompt;
			// only the id and why are logged, never recipients or tokens.
			console.info("[repo-auth] repo_auth.reauth_notification_skipped", {
				event: "repo_auth.reauth_notification_skipped",
				integrationId,
				reason,
			});
			return;
		}
		console.warn(
			"[repo-auth] reauth-required notification dispatch failed",
			{
				integrationId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	} finally {
		clearTimeout(timer);
	}
}
