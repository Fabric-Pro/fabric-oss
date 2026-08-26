/**
 * What a provider's non-2xx response actually MEANS, in words a reader can act
 * on.
 *
 * Every client here used to answer the same way: any 401 **or 403** became
 * "authentication failed — check the connected token and its scope", and the
 * provider's own response body was thrown away unread. That is wrong in a
 * specific and expensive direction. On GitHub a 403 is the status for at least
 * four unrelated conditions, and only one of them is a credential problem:
 *
 *  - the primary rate limit (403 with `x-ratelimit-remaining: 0`);
 *  - a secondary/abuse limit (403 with `retry-after`);
 *  - SAML SSO authorisation, where the credential is valid but has never been
 *    authorised for the org (403 with an `x-github-sso` header carrying the URL
 *    that authorises it);
 *  - a genuinely missing permission — the only case the old message described.
 *
 * Telling somebody to reconnect a working credential because they were rate
 * limited is the exact regression PR #2303 fixed in `checkPatHealth`. It was
 * reintroduced here independently, which is what a copied line does when the
 * reasoning behind it is not written down.
 *
 * The other half of the fix is simply keeping the body. GitHub says
 * "Resource protected by organization SAML enforcement" or "API rate limit
 * exceeded for ..." in plain English; discarding that and substituting a guess
 * is how a failure becomes undiagnosable from the outside — which is precisely
 * what happened to the Foundry bench, where a 403 sat unexplained because the
 * one sentence that would have explained it was never read.
 *
 * Pure and transport-free: takes a status, headers and body, returns a string.
 * No network, no clock — so every branch is unit-testable without a provider.
 */

import { scrubAndTrim } from "@repo/utils/scrub-secrets";

/** Enough of a provider's own message to diagnose, bounded so a log stays readable. */
const MAX_BODY_CHARS = 300;

export type ProviderKind = "github" | "gitlab" | "azure-devops";

/**
 * What the caller must DO about it. Kept alongside the prose because a caller
 * that wants to retry needs the distinction as data, not as a string to grep.
 */
export type ProviderFailureKind =
	| "RATE_LIMITED"
	| "SSO_REQUIRED"
	| "FORBIDDEN"
	| "UNAUTHENTICATED"
	| "OTHER";

export interface ProviderHttpFailure {
	kind: ProviderFailureKind;
	/**
	 * One sentence naming the cause and the remedy. Safe to show a user as-is —
	 * deliberately free of JSON, stack traces and provider jargon.
	 */
	message: string;
	/**
	 * Exactly what the provider sent back, unedited apart from whitespace and a
	 * length bound.
	 *
	 * Kept SEPARATE from `message` rather than appended to it. Concatenating the
	 * two produced a single sentence with a JSON blob in the middle, which is
	 * unreadable in the one place it is shown and unusable in the other: a
	 * person triaging wants the summary, and a person debugging wants the raw
	 * body. The surface can now show the first and reveal the second on hover.
	 */
	providerDetail: string | null;
}

/**
 * An HTTP failure from a provider, carrying the classification with it.
 *
 * A plain `Error` loses everything but the string, and the string is what gets
 * recorded — so the raw body would be gone by the time anything could display
 * it. Thrown and caught inside the same activity, so the extra fields survive.
 */
export class ProviderHttpError extends Error {
	readonly kind: ProviderFailureKind;
	readonly status: number;
	readonly providerDetail: string | null;

	constructor(input: {
		message: string;
		kind: ProviderFailureKind;
		status: number;
		providerDetail: string | null;
	}) {
		super(input.message);
		this.name = "ProviderHttpError";
		this.kind = input.kind;
		this.status = input.status;
		this.providerDetail = input.providerDetail;
	}
}

/** The scope each provider needs for test results, named where it is asked for. */
const REQUIRED_SCOPE: Record<ProviderKind, string> = {
	github: "Actions: read",
	gitlab: "read_api",
	"azure-devops": "Test Management: Read",
};

const PROVIDER_LABEL: Record<ProviderKind, string> = {
	github: "GitHub",
	gitlab: "GitLab",
	"azure-devops": "Azure DevOps",
};

/**
 * Case-insensitive header read.
 *
 * `Headers` already lowercases, but this also accepts a plain object so the
 * classifier can be unit-tested without constructing a `Headers` — and a plain
 * object preserves whatever case the caller wrote.
 */
function readHeader(
	headers: Headers | Record<string, string>,
	name: string,
): string | null {
	if (typeof (headers as Headers).get === "function") {
		return (headers as Headers).get(name);
	}
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(
		headers as Record<string, string>,
	)) {
		if (key.toLowerCase() === lower) {
			return value;
		}
	}
	return null;
}

function trimBody(body: string, secrets: readonly string[]): string {
	return scrubAndTrim(body, secrets, MAX_BODY_CHARS);
}

/**
 * Is this 403 the rate limiter rather than a permission?
 *
 * `x-ratelimit-remaining: 0` is the primary limit; a bare `retry-after` is the
 * secondary/abuse limiter, which does NOT zero the remaining counter. Checking
 * only the first misreads the second as a dead credential.
 */
function isRateLimited(headers: Headers | Record<string, string>): boolean {
	if (readHeader(headers, "retry-after") !== null) {
		return true;
	}
	const remaining = readHeader(headers, "x-ratelimit-remaining");
	return remaining !== null && Number.parseInt(remaining, 10) === 0;
}

/** When the limit lifts, in words, when the provider told us. */
function describeReset(
	headers: Headers | Record<string, string>,
): string | null {
	const retryAfter = readHeader(headers, "retry-after");
	if (retryAfter) {
		const seconds = Number.parseInt(retryAfter, 10);
		return Number.isFinite(seconds)
			? `Retry after ${seconds} second${seconds === 1 ? "" : "s"}.`
			: null;
	}
	const reset = readHeader(headers, "x-ratelimit-reset");
	if (!reset) {
		return null;
	}
	const epochSeconds = Number.parseInt(reset, 10);
	if (!Number.isFinite(epochSeconds)) {
		return null;
	}
	// Formatted as an absolute instant rather than "in N minutes": this string is
	// stored on a sync record and read later, when a relative time would be a lie.
	return `The limit resets at ${new Date(epochSeconds * 1000).toISOString()}.`;
}

/**
 * Classify a provider's failure response.
 *
 * `body` is the raw text the caller already read. It is a parameter rather than
 * something read here because a `Response` body can only be consumed once, and
 * the decision about whether to spend it belongs to the caller.
 */
export function classifyProviderHttpFailure(input: {
	provider: ProviderKind;
	status: number;
	headers: Headers | Record<string, string>;
	body: string;
	secrets?: readonly string[];
}): ProviderHttpFailure {
	const { provider, status, headers, body, secrets = [] } = input;
	const label = PROVIDER_LABEL[provider];
	// Bounded once, here, so every branch reports the same detail and none of
	// them has to remember to.
	const providerDetail = trimBody(body, secrets) || null;

	if (status === 429 || (status === 403 && isRateLimited(headers))) {
		const reset = describeReset(headers);
		return {
			kind: "RATE_LIMITED",
			providerDetail,
			// Says outright that the credential is fine. Someone reading this while
			// their pipeline is red will otherwise reconnect a working token, which
			// costs them an OAuth round trip and fixes nothing.
			message: `${label} rate limit reached — the connected credential is FINE and does not need reconnecting.${
				reset ? ` ${reset}` : ""
			} Fabric will pick the results up on the next sync.`,
		};
	}

	// GitHub answers a credential that is valid but not authorised for an
	// SSO-protected org with a 403 AND the URL that authorises it. Handing that
	// URL over is the difference between a fixable error and a mystery.
	const ssoHeader = readHeader(headers, "x-github-sso");
	if (status === 403 && ssoHeader) {
		return {
			kind: "SSO_REQUIRED",
			providerDetail,
			message: `${label} requires this credential to be authorised for the organization's SAML single sign-on. The credential itself is valid. Authorise it here: ${ssoHeader}`,
		};
	}

	if (status === 401) {
		return {
			kind: "UNAUTHENTICATED",
			providerDetail,
			// 401 is the one that genuinely means "this credential is not good any
			// more" — expired, revoked or wrong. Reconnecting is the right advice
			// here and ONLY here.
			message: `${label} rejected the credential as invalid or expired — reconnect the repository in Settings ▸ Development.`,
		};
	}

	if (status === 403) {
		return {
			kind: "FORBIDDEN",
			providerDetail,
			// Deliberately does NOT say "expired". A 403 that is not a rate limit and
			// not SSO means the credential authenticated fine and was refused the
			// resource, so refreshing or reconnecting it changes nothing — the
			// permission has to be granted. For a GitHub App that is an install-time
			// permission, not an OAuth scope string, and no amount of reconnecting
			// adds it.
			message: `${label} authenticated the credential but refused this resource — it is missing the "${REQUIRED_SCOPE[provider]}" permission, or the app is not installed on this repository. Reconnecting will not add a permission; grant it on the token or app first.`,
		};
	}

	if (status === 404) {
		return {
			kind: "OTHER",
			providerDetail,
			// A 404 here is ambiguous by design on GitHub's part: it is what you get
			// for a repository that does not exist AND for one you may not see, so
			// naming only the first would send someone hunting a typo that is not there.
			message: `${label} returned "not found" — the repository or branch may not exist, or the credential may not be permitted to see it (both answer 404).`,
		};
	}

	return {
		kind: "OTHER",
		providerDetail,
		// No classification to add, so the provider's own words ARE the message.
		message: providerDetail ?? `${label} returned HTTP ${status}.`,
	};
}
