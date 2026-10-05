/**
 * Where a GitLab request may go.
 *
 * A personal GitLab connection records the instance that issued it — from a
 * personal access token's `GITLAB_URL` (or the older `domain` / `url`), from
 * the `baseUrl` of a person's GitLab MCP config, or from an OAuth token
 * endpoint. Every one of those is user-supplied, and every request that
 * carries the connection's token (REST calls, the official MCP endpoint, the
 * refresh and revoke exchanges, uploads, profile and picker lookups) is sent
 * to that instance. So the instance is checked twice:
 *
 *   - when it is read or recorded (`parseGitLabOrigin`): https only, no
 *     embedded credentials, and not a loopback, private, link-local or
 *     cloud-metadata host — an unacceptable address is refused there, never
 *     replaced by gitlab.com;
 *   - when a request leaves (`gitlabOutboundFetch`): anything but gitlab.com
 *     goes through `safeFetchOutbound`, which re-checks the literal host,
 *     refuses a DNS answer that resolves to a non-public address, and refuses
 *     redirects unless the caller handles them itself (`redirect: "manual"`).
 *
 * gitlab.com itself keeps the plain `fetch` it has always used.
 */

import {
	getUnsafeUrlReason,
	safeFetchOutbound,
} from "@repo/utils/url-security";

export const GITLAB_DEFAULT_ORIGIN = "https://gitlab.com";

/** A recorded GitLab instance address that must not be used. */
export class GitLabOriginNotAllowedError extends Error {
	override name = "GitLabOriginNotAllowedError";
}

export type GitLabOriginCheck =
	| { ok: true; origin: string }
	| { ok: false; reason: string };

/**
 * Normalise a recorded GitLab instance address to its origin
 * (`https://host[:port]`, lower-cased), or say why it is refused. A bare host
 * (`gitlab.example.com`) is read as https, as the integration settings form
 * has always done.
 */
export function parseGitLabOrigin(raw: unknown): GitLabOriginCheck {
	if (typeof raw !== "string" || raw.trim() === "") {
		return { ok: false, reason: "the GitLab address is empty" };
	}
	let value = raw.trim();
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		value = `https://${value}`;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, reason: "the GitLab address is not a valid URL" };
	}
	if (url.protocol !== "https:") {
		return { ok: false, reason: "the GitLab address must use https" };
	}
	if (url.username || url.password) {
		return {
			ok: false,
			reason: "the GitLab address must not contain credentials",
		};
	}
	const origin = url.origin.toLowerCase();
	const unsafe = getUnsafeUrlReason(origin);
	if (unsafe) {
		return {
			ok: false,
			reason: `the GitLab address is refused: ${unsafe}`,
		};
	}
	return { ok: true, origin };
}

/** `parseGitLabOrigin`, throwing `GitLabOriginNotAllowedError` on refusal. */
export function assertGitLabOrigin(raw: unknown): string {
	const checked = parseGitLabOrigin(raw);
	if (!checked.ok) {
		throw new GitLabOriginNotAllowedError(checked.reason);
	}
	return checked.origin;
}

/**
 * The fields a stored GitLab credential has recorded its instance under, in
 * precedence order: the integration settings form's `GITLAB_URL`, then the
 * older `domain` and `url` (the shapes the workflow credential mapper and the
 * connection tests still read).
 */
const GITLAB_CREDENTIAL_ORIGIN_FIELDS = [
	"GITLAB_URL",
	"domain",
	"url",
] as const;

export type GitLabCredentialOrigin =
	| { present: false }
	| ({ present: true } & GitLabOriginCheck);

/**
 * The instance a stored credential names, across every historical field. The
 * first field that is present decides: an invalid value there is refused, not
 * skipped in favour of a later field or of gitlab.com.
 */
export function credentialGitLabOrigin(
	credential: Record<string, unknown>,
): GitLabCredentialOrigin {
	for (const field of GITLAB_CREDENTIAL_ORIGIN_FIELDS) {
		const value = credential[field];
		if (
			value === undefined ||
			value === null ||
			(typeof value === "string" && value.trim() === "")
		) {
			continue;
		}
		return { present: true, ...parseGitLabOrigin(value) };
	}
	return { present: false };
}

/**
 * The instance a stored GitLab connection credential belongs to: its issuer's
 * origin when it records one, otherwise whichever historical field names it,
 * otherwise gitlab.com. A present but refused value is refused — never
 * replaced by a later field or by gitlab.com.
 */
export function storedGitLabOrigin(
	credential: Record<string, unknown>,
): GitLabOriginCheck {
	const issuer = credential.issuer;
	if (typeof issuer === "object" && issuer !== null && "origin" in issuer) {
		return parseGitLabOrigin((issuer as { origin: unknown }).origin);
	}
	const named = credentialGitLabOrigin(credential);
	return named.present ? named : { ok: true, origin: GITLAB_DEFAULT_ORIGIN };
}

function originOf(url: string): string | null {
	try {
		return new URL(url).origin.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Fetch a URL built from a GitLab connection's instance. gitlab.com keeps the
 * plain `fetch`. Any other host must be https and goes through
 * `safeFetchOutbound`: the literal host and every resolved address are
 * checked, and a redirect is refused unless `init.redirect` is `"manual"`.
 */
export async function gitlabOutboundFetch(
	input: string | URL,
	init?: RequestInit,
): Promise<Response> {
	const url = typeof input === "string" ? input : input.toString();
	const origin = originOf(url);
	if (origin === GITLAB_DEFAULT_ORIGIN) {
		return fetch(url, init);
	}
	if (!origin?.startsWith("https://")) {
		throw new GitLabOriginNotAllowedError(
			"the GitLab address must use https",
		);
	}
	return safeFetchOutbound(url, init);
}
