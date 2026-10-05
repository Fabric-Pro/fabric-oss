/**
 * The deployment a command talks to is identified by its origin: scheme, host
 * and port, nothing else. A hook, a saved sign-in and a request are all bound
 * to one, so the same spelling has to come out of every path that names one.
 */

export const DEFAULT_ORIGIN = "https://fabric.pro";

/**
 * What every command says when the deployment it was told to use, by
 * `--base-url`, `FABRIC_BASE_URL` or the saved profile, is not a URL. It is
 * never replaced by the default deployment: that would put another
 * deployment's credential on a request meant for this address.
 */
export const BAD_BASE_URL_LINE =
	"The deployment address is not a URL. Use --base-url https://example.com";

/**
 * The origin a deployment's own tarball was packed for. The bundle build
 * defines it (tsup `define`); the npm build and the tests leave it undefined,
 * so the identifier may not exist at all.
 */
declare const __FABRIC_BAKED_ORIGIN__: string | undefined;

/**
 * `https://host[:port]` for an `http(s)` URL, or `null` for anything else. A
 * path, query, fragment or userinfo is dropped rather than refused: a
 * deployment is its origin, and `https://host/app/` names `https://host`.
 */
export function normalizeOrigin(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return null;
	}
	return url.origin;
}

/** The deployment this build was packed for, or `undefined` for any other build. */
export function bakedOrigin(): string | undefined {
	if (typeof __FABRIC_BAKED_ORIGIN__ !== "string") {
		return undefined;
	}
	return normalizeOrigin(__FABRIC_BAKED_ORIGIN__) ?? undefined;
}
