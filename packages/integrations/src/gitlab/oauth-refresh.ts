/**
 * Stand-alone OAuth refresh helper for GitLab.
 *
 * Lives in @repo/integrations so both the api package (oauth callbacks),
 * the temporal package (step activities), and the new MCP-config refresh
 * helper can share a single implementation. Previously this lived in
 * `packages/api/.../gitlab-oauth.ts` and was duplicated inline inside the
 * Temporal resolver — both call sites should now import from here.
 *
 * Note: GitLab requires `application/x-www-form-urlencoded` for token
 * exchange and refresh (NOT JSON).
 */

/**
 * Thrown when GitLab has permanently rejected the stored grant — an
 * `invalid_grant` or `invalid_token` OAuth error from the token endpoint.
 * Callers should surface a one-shot "Reconnect GitLab" prompt and call
 * `markNeedsReauth` to persist the state across the tenant's stores.
 *
 * Deliberately NOT thrown for a bare 401/403: an HTTP status alone does not
 * identify the user's grant as the thing that failed. See the classification
 * comment in `refreshGitLabToken`.
 */
export class GitLabReauthRequiredError extends Error {
	/**
	 * Ciphertext of the refresh token this rejection actually describes, as
	 * read from the row before it was posted. Writers use it as a version
	 * token so the condemning write can only land while the row still holds
	 * that exact value — see `createGitLabRefreshFailureWriter`.
	 *
	 * Stamped by `refreshMcpConfigToken`, which is the only layer that knows
	 * which stored value a given attempt spent (its rotation-race retry posts
	 * a DIFFERENT token from the one first loaded). Undefined when the error
	 * comes straight from the token exchange, which has no row context.
	 */
	spentEncryptedRefreshToken?: string;

	constructor(message = "NEEDS_REAUTH") {
		super(message);
		this.name = "GitLabReauthRequiredError";
	}
}

/**
 * Thrown when a refresh is declined locally because the circuit breaker
 * has already condemned the credential (`MCPConfig.needsReauth`). No
 * provider contact happened, so this says nothing new about the grant —
 * callers must NOT record it as a refresh failure. The row is already
 * flagged; incrementing its diagnostics again only muddies triage.
 */
export class GitLabRefreshSuppressedError extends Error {
	constructor(message = "REFRESH_SUPPRESSED") {
		super(message);
		this.name = "GitLabRefreshSuppressedError";
	}
}

/**
 * Thrown when the provider rejected the refresh token this call posted, but
 * the token stored on the row has since been rotated by a concurrent
 * refresh. The rejection is then stale evidence about a credential that has
 * already been replaced — it says nothing about the grant that is now live.
 *
 * Deliberately NOT a `GitLabReauthRequiredError`: it must reach callers as
 * an ordinary failure so the request degrades to REST and the diagnostics
 * are recorded, WITHOUT condemning a grant the next request will use
 * successfully. Raised only by `refreshMcpConfigToken`, never by the token
 * exchange itself — see the rotation invariant there.
 */
export class GitLabRefreshRaceLostError extends Error {
	constructor(message = "REFRESH_RACE_LOST") {
		super(message);
		this.name = "GitLabRefreshRaceLostError";
	}
}

const GITLAB_TOKEN_URL = "https://gitlab.com/oauth/token";

/**
 * Upper bound on the token-exchange HTTP call. Without this, `fetch` has no
 * timeout of its own — undici's default headers timeout is 300s — so a slow
 * or hanging GitLab response can run far longer than the Postgres advisory
 * lock that wraps this exchange (see `REFRESH_LOCK_TRANSACTION_TIMEOUT_MS` in
 * `@repo/database/prisma/queries/lib/refresh-lock-key`). That transaction
 * budget is a bound, not a guarantee, unless every bounded call inside it is
 * ALSO bounded: 10s here leaves headroom under the 20s transaction timeout
 * for the in-tx MCP capability probe (`probeGitLabMcp`, bounded to
 * `GITLAB_MCP_PROBE_DEFAULT_TIMEOUT_MS` = 2s — see `probe-mcp.ts`) plus the
 * transaction's own DB round-trips (lock acquisition, re-read, persist).
 *
 * What this bound actually guarantees is narrower than "GitLab cannot outrun
 * the lock": it guarantees this PROCESS gives up on the HTTP call in time for
 * the transaction to still be open when it decides what to do next — i.e.
 * the persist that follows a successful exchange is never attempted against
 * an already-rolled-back transaction. It does NOT prove anything about
 * GitLab's own state at the moment of the abort: the request may have
 * already reached GitLab and the rotation may already have committed
 * server-side before the client gave up waiting on the response. That
 * unknown-outcome window is inherent to any client-side timeout, not
 * something this bound closes — it only keeps a slow response from silently
 * corrupting OUR transaction's outcome.
 *
 * A `TimeoutError`/`AbortError` from this bound must NOT be classified as
 * `GitLabReauthRequiredError` — every catch below (and every consumer that
 * gates `needsReauth` on `instanceof GitLabReauthRequiredError`) only throws
 * that type on evidence that GitLab rejected the GRANT itself
 * (`invalid_grant` / `invalid_token`), never on a request that never got a
 * response. An aborted fetch propagates unchanged as an ordinary rejection,
 * which is exactly what keeps a slow provider from condemning a live
 * credential.
 */
export const GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

export interface GitLabRefreshResponse {
	access_token: string;
	token_type?: string;
	expires_in?: number;
	refresh_token?: string;
	created_at?: number;
	scope?: string;
}

/**
 * Derive the token endpoint for a given GitLab instance. Self-hosted
 * instances (e.g. `https://gitlab.example.com`) need their own host —
 * hardcoding gitlab.com here breaks the MCPConfig refresh path the
 * moment a customer points at their own server. Trailing slashes on
 * `baseUrl` are tolerated.
 */
function resolveTokenUrl(baseUrl?: string): string {
	if (!baseUrl) {
		return GITLAB_TOKEN_URL;
	}
	return `${baseUrl.replace(/\/$/, "")}/oauth/token`;
}

export async function refreshGitLabToken(
	refreshToken: string,
	clientId: string,
	clientSecret: string,
	options?: { baseUrl?: string },
): Promise<GitLabRefreshResponse> {
	const tokenUrl = resolveTokenUrl(options?.baseUrl);
	const body = new URLSearchParams({
		client_id: clientId,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	// Only include client_secret for confidential clients (not DCR public clients)
	if (clientSecret) {
		body.set("client_secret", clientSecret);
	}

	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
		// See GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS above. This same signal also
		// covers every body read below (`response.json()`, both branches): a
		// timeout firing after headers already arrived throws the identical
		// DOMException from THOSE reads, not just from this call. The
		// classification below never matches a DOMException, and the non-OK
		// branch explicitly rethrows one unchanged rather than folding it
		// into its generic status Error — see that branch's comment — so an
		// abort anywhere in this function reaches the caller as an ordinary
		// failure, never a dead-grant verdict.
		signal: AbortSignal.timeout(GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS),
	});

	if (!response.ok) {
		let body: { error?: string; error_description?: string } = {};
		try {
			body = (await response.json()) as typeof body;
		} catch (err) {
			// A body-read abort reuses the SAME AbortSignal as the fetch
			// call above: when the timeout fires after non-OK headers have
			// already arrived (so `response.ok` is already decided), THIS
			// read is what actually throws — not `fetch` itself. That is
			// not "the body wasn't JSON", it's "we never read a body at
			// all", and it must propagate UNCHANGED rather than fall
			// through to the generic status Error below: folding it in
			// would erase the one thing downstream needs to recognise it as
			// a no-verdict transient outcome (see `isNoVerdictTransientError`
			// in source.ts) rather than a strike against the refresh
			// circuit breaker.
			if (
				err instanceof DOMException &&
				(err.name === "TimeoutError" || err.name === "AbortError")
			) {
				throw err;
			}
			// Body wasn't JSON (HTML error page, empty response). There is no
			// OAuth error code to classify on, so it falls through to the
			// plain Error below.
		}
		// This classification is load-bearing downstream: consumers gate
		// `MCPConfig.needsReauth` on the error TYPE, not the message, and that
		// flag is ENFORCED — a config carrying it is refused at MCP client
		// creation and filtered out of tool discovery, and nothing but a fresh
		// OAuth grant performed by the USER clears it. So the typed error may
		// only be thrown on evidence that the user's grant specifically is
		// dead: `invalid_grant` (refresh token revoked, expired or already
		// used) and `invalid_token`. An HTTP status does not carry that
		// meaning and must not be used:
		//   - OAuth answers 401 for `invalid_client` too, i.e. the OAuth
		//     APPLICATION's credentials are wrong or revoked. Reconnecting
		//     cannot fix that, so condemning every user's grant over it is
		//     the worst available response.
		//   - A 403 can be instance policy, an authentication ban, or a proxy
		//     sitting in front of a self-hosted instance — none grant-specific.
		//   - A body that didn't parse says nothing at all.
		// Suppressing retries for application/configuration errors is a real
		// need, but it wants its own state and backoff; it must NOT reuse this
		// user-grant breaker, whose only exit is a user action that would not
		// help. Everything undecisive stays a plain Error so a transient or
		// misattributed failure can't condemn a working credential.
		if (body.error === "invalid_grant" || body.error === "invalid_token") {
			throw new GitLabReauthRequiredError();
		}
		throw new Error(`GitLab token refresh failed: ${response.status}`);
	}

	const data = (await response.json()) as GitLabRefreshResponse & {
		error?: string;
		error_description?: string;
	};

	// Same rule as the !response.ok branch above: GitLab can answer 200 with
	// an OAuth error body, and a dead grant must reach callers as the typed
	// error or the credential is never condemned. Only these two codes
	// qualify — every other `error` falls through to the plain Error below.
	if (data.error === "invalid_grant" || data.error === "invalid_token") {
		throw new GitLabReauthRequiredError();
	}
	if (data.error) {
		throw new Error(
			`GitLab token refresh error: ${data.error_description || data.error}`,
		);
	}

	if (!data.access_token) {
		throw new Error("No access token in GitLab refresh response");
	}

	return data;
}
