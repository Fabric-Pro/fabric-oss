/**
 * Why a repository-credential REFRESH failed, when the reason is ours rather
 * than the customer's.
 *
 * The problem this exists to solve is the same one `ResolvedRepoToken`'s
 * `credentialFault` solves one seam earlier, at a different seam. Both GitHub's
 * `refreshProjectRepoGitHubToken` and the GitLab path collapse several
 * unrelated outcomes into a bare `null`:
 *
 *  - the deployment has no OAuth client credentials configured at all,
 *  - the provider's token endpoint is down, unreachable, or answering
 *    something unparseable,
 *  - our own database/transaction threw,
 *  - the customer's grant is genuinely dead (revoked, expired, de-authorized).
 *
 * The resolver then falls back to the expired STORED access token and hands it
 * to the caller. The provider answers 401, and a consumer that only sees "401"
 * classifies it as the customer's rejected credential — so a deployment-wide
 * loss of `FABRIC_GITHUB_CLIENT_ID` / `FABRIC_GITHUB_CLIENT_SECRET`, or a
 * provider outage, silently downgrades a platform-wide fault into a per-tenant
 * warning across EVERY expired integration at once. That is precisely the
 * inversion `credentialFault` was added to prevent, and it is not hypothetical:
 * `sanitizeCredential`'s doc in `@repo/utils/oauth-refresh` records seven weeks
 * of staging refreshes failing because a BOM rode along inside `client_id`,
 * with nothing any user could have fixed by reconnecting.
 *
 * Presence of a fault means "platform" — a consumer should treat the failure as
 * OURS (loud, never downgraded, never a "reconnect the repository" prompt).
 * Absence means either the refresh succeeded or it failed for a reason that
 * genuinely points at the customer's grant.
 */
export type RepoTokenRefreshFault =
	/**
	 * The deployment has no usable OAuth client credentials for this provider —
	 * neither env vars nor a stored OAuth-app record. No refresh was even
	 * attempted, so nothing here says anything about the customer's grant.
	 */
	| "MISSING_CLIENT_CREDENTIALS"
	/**
	 * The token endpoint could not be reached, or answered in a way that says
	 * nothing about the grant: a network failure, a 5xx, an unparseable body,
	 * or a rejection of OUR client rather than the user's token.
	 */
	| "PROVIDER_UNAVAILABLE"
	/**
	 * The refresh path itself threw — a database error, a pool timeout, a bug.
	 * Never the customer's.
	 */
	| "INTERNAL";

/**
 * Map an `OAuthRefreshFailure.errorCode` (see `@repo/utils/oauth-refresh`) to a
 * platform fault, or `undefined` when the failure genuinely points at the
 * customer's grant.
 *
 * Deliberately conservative: only codes that CANNOT be the customer's grant map
 * to a fault. `invalid_grant` and every other unrecognized RFC 6749 code fall
 * through to `undefined`, because misreading a dead grant as a platform outage
 * would suppress the one signal that tells a customer to reconnect. A 4xx other
 * than 429 without a parseable OAuth error body is also left unmapped — GitHub
 * answers HTTP 404 both for a corrupted `client_id` and for a refresh token a
 * concurrent caller already rotated away, so the status alone cannot separate
 * them, and the safer default is to keep blaming neither side loudly.
 */
const PROVIDER_UNAVAILABLE_ERROR_CODES: ReadonlySet<string> = new Set([
	// `refreshOAuthToken`'s own synthesized codes: the fetch threw, or the
	// endpoint answered 2xx with a body that could not be parsed.
	"network_error",
	"invalid_response",
	// RFC 6749 §5.2 — the provider rejecting OUR client, not the user's token.
	// This is the BOM-in-`client_id` failure mode described above, verbatim.
	"invalid_client",
	"unauthorized_client",
	// RFC 6749 §5.2 defines both of these as unambiguously server-side: an
	// unexpected condition at the authorization server, and a temporary
	// overload/maintenance. `refreshOAuthToken` passes a parsed provider error
	// code through verbatim, so a token endpoint answering
	// `{"error":"temporarily_unavailable"}` reaches this function — and left
	// unmapped it would fall through to the fallback token, a 401, and a
	// `CREDENTIAL_REJECTED` reconnect prompt for a provider-wide outage.
	"server_error",
	"temporarily_unavailable",
]);

export function refreshFaultForOAuthErrorCode(
	errorCode: string,
): RepoTokenRefreshFault | undefined {
	if (PROVIDER_UNAVAILABLE_ERROR_CODES.has(errorCode)) {
		return "PROVIDER_UNAVAILABLE";
	}
	const httpStatus = /^http_(\d{3})$/.exec(errorCode)?.[1];
	if (!httpStatus) {
		return undefined;
	}
	const status = Number(httpStatus);
	// 5xx is the server failing. 429 is rate limiting at the token endpoint —
	// throttling says nothing about whether the grant is still valid, and
	// treating it as a dead credential would tell a customer to reconnect a
	// credential that is fine and would have refreshed on the next attempt.
	return status >= 500 || status === 429 ? "PROVIDER_UNAVAILABLE" : undefined;
}

/**
 * Codes where the provider explicitly named the REFRESH TOKEN as the problem.
 *
 * Deliberately much narrower than "no platform fault". Absence of a fault is a
 * catch-all: it covers a genuinely dead grant, but also every ambiguous code —
 * including the bare HTTP 404 that GitHub returns both for a corrupted
 * `client_id` and for a refresh token a concurrent caller already rotated away.
 * The per-integration advisory lock normally prevents that race, but its own
 * comment records a rolling-deploy window where it reopens.
 */
const GRANT_REJECTED_ERROR_CODES: ReadonlySet<string> = new Set([
	// GitHub's code for exactly this, verbatim from the token endpoint:
	// {"error":"bad_refresh_token","error_description":"The refresh token
	// passed is incorrect or expired."}
	"bad_refresh_token",
	// RFC 6749 §5.2 — the grant is invalid, expired, or revoked.
	"invalid_grant",
]);

/**
 * True when the provider stated that the GRANT was rejected, so telling the
 * user to reconnect is warranted.
 *
 * Use this — NOT the absence of a `RepoTokenRefreshFault` — before flipping
 * status or notifying anyone. Absence of a fault is a catch-all that also
 * covers ambiguous and request-side codes: the bare HTTP 404 GitHub returns for
 * a corrupted `client_id`, and RFC codes like `invalid_request`,
 * `unsupported_grant_type` and `invalid_scope` that describe OUR request rather
 * than the customer's grant. Treating those as a rejected grant sends a
 * "reconnect GitHub" notification for a deployment misconfiguration — the exact
 * inversion `RepoTokenRefreshFault` exists to prevent. Ambiguous codes belong
 * in neither bucket: retry quietly and blame nobody.
 */
export function isGrantRejected(errorCode: string): boolean {
	return GRANT_REJECTED_ERROR_CODES.has(errorCode);
}

/**
 * True only for codes where the provider named the stored REFRESH TOKEN itself,
 * so no future exchange of it can possibly succeed.
 *
 * Strictly narrower than {@link isGrantRejected}, and deliberately so: this one
 * gates the sticky `refreshTokenRejectedAt` marker, which retires the row from
 * the scheduled health check. A status flip self-heals on the next successful
 * refresh; retirement removes the very sweep that would have delivered it, so a
 * false positive strands a live connection until someone reconnects by hand.
 *
 * `invalid_grant` is excluded for that reason. RFC 6749 also uses it when a
 * grant was issued to a DIFFERENT client, so a deployment resolving the wrong
 * (but valid) OAuth app would permanently retire connections whose grants are
 * perfectly alive under the correct client. `bad_refresh_token` carries no such
 * second meaning — it is GitHub-specific and names the token.
 */
export function isRefreshTokenRejected(errorCode: string): boolean {
	return errorCode === "bad_refresh_token";
}
