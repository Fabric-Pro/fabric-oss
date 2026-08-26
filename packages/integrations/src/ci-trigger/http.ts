import { scrubAndTrim } from "@repo/utils/scrub-secrets";
import { getUnsafeUrlReason } from "@repo/utils/url-security";

/**
 * Transport shared by the three CI trigger clients.
 *
 * Triggering runs inside an API request (the user is waiting on the answer), so
 * the bound here is tighter than the worker's 30s fetch timeout: a CI host that
 * has stopped answering should surface as a failed trigger quickly rather than
 * holding the request open.
 */

/** Per-request bound. `fetch` has no default timeout of its own. */
const REQUEST_TIMEOUT_MS = 20_000;

export function ciRequestSignal(): AbortSignal {
	return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

/**
 * Read a response body without letting a parse failure mask the status that
 * actually matters. Providers answer errors with JSON, HTML sign-in pages and
 * empty bodies interchangeably, and the caller only ever wants a short string to
 * quote back.
 *
 * Pass every credential the request carried. The body is quoted into a message
 * that reaches the browser, and a self-managed host or a fronting proxy will
 * echo the request's own `PRIVATE-TOKEN` / `Authorization` header inside a
 * verbose error page. Triggering a run only needs editor-level permission while
 * reading the credential needs an admin, so an unscrubbed body hands the token
 * to someone the credential was deliberately kept from.
 *
 * The results-FETCH direction has always scrubbed; this direction did not, and
 * both now share `scrubAndTrim` so they cannot drift apart again.
 */
export async function readErrorBody(
	res: Response,
	secrets: readonly string[] = [],
): Promise<string> {
	try {
		return scrubAndTrim(await res.text(), secrets);
	} catch {
		return "";
	}
}

/**
 * True when a provider response is a throttle rather than a permission problem.
 * GitHub reuses `403` for both and distinguishes them only by the remaining-quota
 * header, so a rate limit would otherwise be reported as "your token is missing a
 * scope" — sending the user to fix something that is not broken.
 */
export function isRateLimited(res: Response): boolean {
	if (res.status === 429) {
		return true;
	}
	const remaining = res.headers.get("x-ratelimit-remaining");
	return res.status === 403 && remaining === "0";
}

/**
 * Keep a provider-supplied link only if it is really an http(s) URL.
 *
 * `runUrl` is taken from the provider's own response body (GitLab's `web_url`,
 * ADO's `_links.web.href`) and is then rendered as an `href` the user clicks.
 * React does not sanitise `href`, so a `javascript:` or `data:` value would
 * become a live script link — and the GitLab host is customer-controlled, since
 * self-managed instances are supported. Dropping the link is always safe: the
 * run still started, there is simply nothing to click.
 */
export function safeRunUrl(candidate: unknown): string | null {
	if (typeof candidate !== "string" || candidate.length === 0) {
		return null;
	}
	try {
		const url = new URL(candidate);
		return url.protocol === "https:" || url.protocol === "http:"
			? candidate
			: null;
	} catch {
		return null;
	}
}

/**
 * Derive the GitLab REST base (`https://<host>/api/v4`) from a connected repo
 * URL, or `null` when the URL is unparseable, not http(s), or names a non-public
 * literal address. The actual request also uses the shared DNS-validating
 * transport, so a hostname that resolves to a private address is rejected at
 * connection time.
 *
 * This is the canonical definition: the pipeline-results fetcher re-exports it
 * rather than keeping a second copy, so the SSRF guard cannot drift between the
 * path that reads runs and the path that starts them.
 */
export function gitlabApiBaseFromRepoUrl(repositoryUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(repositoryUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return null;
	}
	if (getUnsafeUrlReason(url.toString())) {
		return null;
	}
	return `${url.protocol}//${url.host}/api/v4`;
}
