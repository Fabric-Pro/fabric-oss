/**
 * Git's object id of a file's bytes, computed locally.
 *
 * A blob is hashed as `blob <size>\0<bytes>`. The id's length says the
 * repository's object format: 40 hex characters for SHA-1, 64 for SHA-256, and
 * the same bytes have a different id in each, so a caller that holds an id
 * hashes the way that id was made.
 */
import { createHash } from "node:crypto";

export type GitObjectFormat = "sha1" | "sha256";

export function objectFormatOf(oid: string): GitObjectFormat | null {
	if (/^[0-9a-f]{40}$/.test(oid)) {
		return "sha1";
	}
	if (/^[0-9a-f]{64}$/.test(oid)) {
		return "sha256";
	}
	return null;
}

export function gitBlobOid(
	bytes: Uint8Array,
	format: GitObjectFormat = "sha1",
): string {
	return createHash(format)
		.update(`blob ${bytes.byteLength}\0`)
		.update(bytes)
		.digest("hex");
}

/** Do these bytes have the id `oid`? */
export function matchesBlobOid(bytes: Uint8Array, oid: string): boolean {
	const format = objectFormatOf(oid);
	return format !== null && gitBlobOid(bytes, format) === oid;
}
