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
	});

	if (!response.ok) {
		let body: { error?: string; error_description?: string } = {};
		try {
			body = (await response.json()) as typeof body;
		} catch {
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
