/**
 * Which walked files are text this command may send, and the hash each one is
 * known by.
 *
 * A first cut that only sends text: an allow-list of extensions, bytes that
 * decode as UTF-8 without a single replacement, no NUL, something other than
 * whitespace, and at most the server's 2 MiB. Everything else is SKIPPED with
 * a reason the report shows, never sent to be refused — the server applies
 * the same rules (`upsertSyncedContext`) and would only say no.
 */
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * The server's ceiling on one synced file (`MAX_SYNCED_CONTEXT_BYTES` in
 * `packages/api/modules/projects/lib/upsert-synced-context.ts`).
 */
export const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024;

/** Compared lower-cased, so `README.MD` is text too. */
const CONTEXT_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	".md",
	".markdown",
	".txt",
	".json",
	".yaml",
	".yml",
]);

/**
 * Why a file under the folder was not sent.
 *
 *  - `unsupported-type`   not one of the text extensions, or not a regular file
 *  - `binary`             not valid UTF-8, or contains NUL
 *  - `empty`              no bytes, or only whitespace
 *  - `too-large`          over 2 MiB of UTF-8
 *  - `invalid-path`       a path the server would refuse (`detail` carries the
 *                         server's reason word) or one two files would share
 *  - `symlink`            never followed, never sent
 *  - `ignored`            the lock names it but the ignore rules now leave it
 *                         out; its server entry is kept
 *  - `repository-managed` the server refused a create, a replace, a move or
 *                         a `--prune` delete because a Living Memory
 *                         repository sync owns this path (`detail` carries
 *                         the server's own sentence); final, and never
 *                         retried with `--force`. Set after the send, not by
 *                         the planner, but reported through the same
 *                         `skipped` group as the reasons decided before it.
 */
type ContextSkipReason =
	| "unsupported-type"
	| "binary"
	| "empty"
	| "too-large"
	| "invalid-path"
	| "symlink"
	| "ignored"
	| "repository-managed";

export interface SkippedContextFile {
	path: string;
	reason: ContextSkipReason;
	detail?: string;
}

const HAS_NON_WHITESPACE = /\S/;

export function hasTextExtension(relativePath: string): boolean {
	return CONTEXT_TEXT_EXTENSIONS.has(
		path.posix.extname(relativePath).toLowerCase(),
	);
}

/**
 * The file's text, or why it is not text worth sending.
 *
 * `ignoreBOM: true` keeps a leading byte-order mark IN the string. The server
 * hashes the string it receives; had the decoder stripped the BOM, the hash
 * the server stores would differ from the hash of the bytes on disk, and an
 * untouched file would look changed to every later push.
 *
 * `fatal: true` is what makes "decodes as UTF-8" mean anything: the default
 * decoder replaces invalid bytes with U+FFFD silently, which would upload a
 * rewritten file.
 */
export function classifyContextBytes(
	bytes: Uint8Array,
):
	| { ok: true; content: string }
	| { ok: false; reason: "binary" | "empty" | "too-large" } {
	if (bytes.byteLength > MAX_CONTEXT_FILE_BYTES) {
		return { ok: false, reason: "too-large" };
	}
	let content: string;
	try {
		content = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(bytes);
	} catch {
		return { ok: false, reason: "binary" };
	}
	// Valid UTF-8 can still hold U+0000, which Postgres `text` cannot store
	// and the server refuses.
	if (content.includes("\u0000")) {
		return { ok: false, reason: "binary" };
	}
	// The server's own emptiness test: nothing but whitespace (a lone BOM
	// counts as whitespace to `\s`).
	if (!HAS_NON_WHITESPACE.test(content)) {
		return { ok: false, reason: "empty" };
	}
	return { ok: true, content };
}

/**
 * sha256 hex over the UTF-8 bytes of the content — the server's
 * `hashContextContent`, byte for byte, with nothing normalised first. It is
 * the compare-and-swap token a replace presents, and the lock records it.
 */
export function hashContextContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}
