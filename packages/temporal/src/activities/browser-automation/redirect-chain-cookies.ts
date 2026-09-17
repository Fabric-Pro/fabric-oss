/**
 * Cookies across a same-origin subresource redirect chain the browser relay
 * follows itself (see `url-guard.ts`).
 *
 * The relay never stores cookies in the browser context. Chromium applies
 * cookies itself, from the `Set-Cookie` headers on the response the relay
 * fulfills, which keeps the request's credentials mode, `Partitioned`,
 * `SameSite` and ordering in Chromium's hands. What remains for the relay
 * is here as pure functions:
 *
 * - `withHopDefaultPath`: a cookie set by a hop other than the one Chromium
 *   requested would be scoped by Chromium to the requested URL's path when
 *   it names no `Path`, so the hop's own default-path is written in.
 * - `fulfillableSetCookies` / `isPartitionedSetCookie`: `Partitioned`
 *   cookies are dropped, because Chromium stores a cookie set through a
 *   fulfilled response without its partition key.
 *
 * Follow-up hops send no `Cookie` header at all (see
 * `followSubresourceRedirects`): a flat `name=value` header cannot be
 * re-scoped by Path, Domain, Secure or SameSite to another URL, so the relay
 * does not guess which cookies Chromium would send there.
 */

/** RFC 6265 section 5.1.4 default-path of a request URL. */
export function defaultCookiePath(url: URL): string {
	const path = url.pathname;
	if (!path.startsWith("/")) {
		return "/";
	}
	const lastSlash = path.lastIndexOf("/");
	return lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
}

type ParsedSetCookie = {
	name: string;
	value: string;
	attributes: Map<string, string>;
};

function parseSetCookie(header: string): ParsedSetCookie | null {
	const [pair, ...rest] = header.split(";");
	const separator = pair.indexOf("=");
	if (separator <= 0) {
		return null;
	}
	const name = pair.slice(0, separator).trim();
	if (!name) {
		return null;
	}
	const attributes = new Map<string, string>();
	for (const attribute of rest) {
		const eq = attribute.indexOf("=");
		const key = (eq === -1 ? attribute : attribute.slice(0, eq))
			.trim()
			.toLowerCase();
		if (key) {
			attributes.set(
				key,
				eq === -1 ? "" : attribute.slice(eq + 1).trim(),
			);
		}
	}
	return { name, value: pair.slice(separator + 1).trim(), attributes };
}

/**
 * Whether a `Set-Cookie` header carries `Partitioned`.
 *
 * Chromium stores a cookie that arrives on a `route.fulfill` response
 * WITHOUT its partition key (verified against Chromium 143: the same header
 * fetched directly is stored partitioned, fulfilled it is stored as an
 * ordinary cookie). Passing one through would widen a CHIPS cookie into a
 * cookie sent under every top-level site, so the relay drops them.
 */
export function isPartitionedSetCookie(header: string): boolean {
	return parseSetCookie(header)?.attributes.has("partitioned") ?? false;
}

/**
 * The `Set-Cookie` headers the relay may fulfill: every header except
 * Partitioned ones, in the order given.
 */
export function fulfillableSetCookies(headers: readonly string[]): {
	kept: string[];
	droppedPartitioned: number;
} {
	const kept = headers.filter((header) => !isPartitionedSetCookie(header));
	return { kept, droppedPartitioned: headers.length - kept.length };
}

/**
 * `header` as received from `hopUrl`, with `Path=<hop default-path>` added
 * when it names no `Path` (or one Chromium would ignore). Otherwise
 * unchanged.
 */
export function withHopDefaultPath(header: string, hopUrl: URL): string {
	const parsed = parseSetCookie(header);
	const path = parsed?.attributes.get("path");
	if (!parsed || path?.startsWith("/")) {
		return header;
	}
	return `${header}; Path=${defaultCookiePath(hopUrl)}`;
}
