/**
 * Which URLs the web-research endpoint may hand to a page-reading provider.
 *
 * Only public `http(s)` pages by host name: no credentials, no IP literals
 * (public ones included), no local or internal names, at most 2,048
 * characters. The decoded host, path, query and fragment must also pass the
 * confidential-term filter, because the provider sees the whole URL, not only
 * its query string.
 *
 * The typed checks run first so every refusal carries its own reason;
 * `getUnsafeUrlReason` from `@repo/utils/url-security` runs after them as a
 * backstop. Called without a matcher it is the network-only check applied to
 * the address a provider reports after redirects.
 */

import { isIP } from "node:net";
import { domainToUnicode } from "node:url";
import { getUnsafeUrlReason } from "@repo/utils/url-security";
import {
	type ConfidentialMatcher,
	type ConfidentialTermKind,
	findConfidentialMatch,
} from "./confidential-terms";

export const MAX_RESEARCH_URL_LENGTH = 2048;

export type UrlRejectionReason =
	| "too_long"
	| "invalid"
	| "scheme"
	| "credentials"
	| "ip_literal"
	| "local_host"
	| "confidential_term";

export type UrlPolicyResult =
	| { allowed: true; url: URL }
	| {
			allowed: false;
			reason: UrlRejectionReason;
			matchKind?: ConfidentialTermKind;
	  };

// Names reserved for private networks: RFC 6761 and 8375, plus the private
// top-level names RFC 6762 appendix G lists as in common use.
const LOCAL_HOST_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".home.arpa",
	".localdomain",
	".lan",
	".home",
	".corp",
	".intranet",
	".private",
];

/**
 * The parts of a URL a provider sees, for the confidential-term filter (which
 * also percent-decodes). The host is read in Unicode rather than punycode,
 * and "+" counts as a space in every part, as many sites read it in paths too.
 */
function outboundText(url: URL): string {
	return [
		domainToUnicode(url.hostname) || url.hostname,
		url.pathname,
		url.search,
		url.hash,
	]
		.join(" ")
		.replace(/\+/g, " ");
}

function isLocalHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname.endsWith(".") ||
		!hostname.includes(".") ||
		LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
	);
}

export function checkResearchUrl(
	rawUrl: string,
	matcher: ConfidentialMatcher = [],
): UrlPolicyResult {
	if (rawUrl.length > MAX_RESEARCH_URL_LENGTH) {
		return { allowed: false, reason: "too_long" };
	}

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { allowed: false, reason: "invalid" };
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { allowed: false, reason: "scheme" };
	}
	if (url.username !== "" || url.password !== "") {
		return { allowed: false, reason: "credentials" };
	}

	const hostname = url.hostname.toLowerCase();
	// IPv6 hosts keep their brackets in `hostname`; `isIP` wants them gone.
	if (isIP(hostname.replace(/^\[(.*)\]$/, "$1")) !== 0) {
		return { allowed: false, reason: "ip_literal" };
	}
	if (isLocalHost(hostname) || getUnsafeUrlReason(url.href) !== null) {
		return { allowed: false, reason: "local_host" };
	}

	const matchKind = findConfidentialMatch(outboundText(url), matcher);
	if (matchKind) {
		return { allowed: false, reason: "confidential_term", matchKind };
	}

	return { allowed: true, url };
}
