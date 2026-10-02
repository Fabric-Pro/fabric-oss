/**
 * How OAuth tokens are written down: the prefixes a client sees and the digest
 * the database stores. Dependency-free on purpose, so the authorization server,
 * the entry points that verify a token and the tests that pin the two together
 * all load it without a database client.
 *
 * The digest the plugin writes and the digest a request looks up must come from
 * the same function, or every token reads as unknown.
 */

import { createHash } from "node:crypto";

/** Prefix on the opaque access token a client holds. Not part of the digest. */
export const OAUTH_ACCESS_TOKEN_PREFIX = "fat_";

/** Prefix on the refresh token a client holds. Not part of the digest. */
export const OAUTH_REFRESH_TOKEN_PREFIX = "frt_";

export function hashOAuthToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}
