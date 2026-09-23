/**
 * The one stored spelling of a synced knowledge file's path (Fizzy #2616).
 *
 * The path is half of the row's key (`@@unique([projectId, sourcePath])`), so
 * every spelling of the same file has to normalise to the same string, and a
 * string that could never name a file inside the caller's working tree has to
 * be refused rather than stored:
 *
 *  - NFC first, so a decomposed name (macOS) and a composed one (everywhere
 *    else) are one key;
 *  - `\` becomes `/`, repeated separators collapse, and leading `./` goes;
 *  - an absolute path (`/…`, `\\server\…`, or any drive-letter prefix,
 *    including the drive-relative `C:a.md`) is refused: it names a place on
 *    one machine, not a file in the project;
 *  - a `.` or `..` segment is refused anywhere, not resolved: resolving
 *    `docs/../a.md` would silently make two different requests mean one row,
 *    and a leading `..` escapes the tree altogether;
 *  - a trailing separator is refused, because it names a directory;
 *  - control characters (C0, DEL, C1) and format characters (`\p{Cf}`:
 *    zero-width characters, bidi overrides and isolates, U+FEFF) are
 *    refused. A format character is invisible, and the path's basename
 *    becomes the default title and the audit `resourceName`, so it would let
 *    two paths that read identically be different keys, or make a name read
 *    as something it is not;
 *  - at most {@link MAX_CONTEXT_SOURCE_PATH_LENGTH} characters, measured
 *    AFTER normalising.
 *
 * Pure: no Prisma, no I/O. Throws {@link ContextSourcePathError}, which the
 * API layer maps to a 400.
 *
 * `normalizeContextSourcePathPrefix` applies the same rules to the folder a
 * contexts-list filter selects (Fizzy #2620).
 */

export const MAX_CONTEXT_SOURCE_PATH_LENGTH = 512;

export type ContextSourcePathErrorReason =
	| "empty"
	| "absolute"
	| "dot-segment"
	| "trailing-slash"
	| "control-character"
	| "too-long"
	// Raised only by the directory-prefix filter, which refuses these
	// spellings instead of rewriting them (see
	// `normalizeContextSourcePathPrefix`).
	| "backslash"
	| "empty-segment";

/** The reasons `normalizeContextSourcePathPrefix` can refuse a prefix for. */
export type ContextSourcePathPrefixErrorReason = Exclude<
	ContextSourcePathErrorReason,
	"empty" | "trailing-slash"
>;

const REASON_MESSAGES: Record<ContextSourcePathErrorReason, string> = {
	empty: "sourcePath is empty",
	absolute:
		"sourcePath is absolute; pass the file's relative path inside the project's working tree",
	"dot-segment":
		"sourcePath may not contain '.' or '..' segments; pass the file's relative path inside the project's working tree",
	"trailing-slash": "sourcePath names a directory; pass a file's path",
	"control-character":
		"sourcePath contains a control character or an invisible format character (zero-width, bidi override, byte-order mark)",
	"too-long": `sourcePath is longer than ${MAX_CONTEXT_SOURCE_PATH_LENGTH} characters`,
	backslash: "sourcePath contains a backslash; separate folders with '/'",
	"empty-segment": "sourcePath contains an empty segment ('//')",
};

const PREFIX_REASON_MESSAGES: Record<
	ContextSourcePathPrefixErrorReason,
	string
> = {
	absolute:
		"sourcePathPrefix is absolute; pass a folder's relative path inside the project's working tree",
	"dot-segment":
		"sourcePathPrefix may not contain '.' or '..' segments; pass a folder's relative path inside the project's working tree",
	"control-character":
		"sourcePathPrefix contains a control character or an invisible format character (zero-width, bidi override, byte-order mark)",
	"too-long": `sourcePathPrefix leaves no room for a file name within ${MAX_CONTEXT_SOURCE_PATH_LENGTH} characters`,
	backslash:
		"sourcePathPrefix contains a backslash; separate folders with '/'",
	"empty-segment":
		"sourcePathPrefix contains an empty segment ('//'); pass a folder's relative path such as 'docs/guides'",
};

export class ContextSourcePathError extends Error {
	readonly reason: ContextSourcePathErrorReason;

	constructor(
		reason: ContextSourcePathErrorReason,
		message: string = REASON_MESSAGES[reason],
	) {
		super(message);
		this.name = "ContextSourcePathError";
		this.reason = reason;
	}
}

// C0 controls, DEL, the C1 block, and every format character (`\p{Cf}`, which
// needs the `u` flag): zero-width space/joiners, bidi embeddings, overrides
// and isolates, the byte-order mark. Written with escapes so the source file
// itself carries no such characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_OR_FORMAT_CHARACTER = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;

/**
 * True when `value` holds a character the path refuses as a
 * `control-character`: C0, DEL, C1 or a format character. Exported so a
 * synced file's title, which is shown and audited like the path's basename,
 * is held to the same rule.
 */
export function hasControlOrFormatCharacter(value: string): boolean {
	return CONTROL_OR_FORMAT_CHARACTER.test(value);
}

export function normalizeContextSourcePath(input: string): string {
	const slashed = input.normalize("NFC").replace(/\\/g, "/");

	if (hasControlOrFormatCharacter(slashed)) {
		throw new ContextSourcePathError("control-character");
	}
	// Checked before collapsing, so `//server/share` (a UNC path once its
	// backslashes are converted) is still recognisably absolute.
	if (slashed.startsWith("/") || DRIVE_LETTER_PREFIX.test(slashed)) {
		throw new ContextSourcePathError("absolute");
	}

	let path = slashed.replace(/\/{2,}/g, "/");
	while (path.startsWith("./")) {
		path = path.slice(2);
	}

	if (path.length === 0) {
		throw new ContextSourcePathError("empty");
	}
	if (path.endsWith("/")) {
		throw new ContextSourcePathError("trailing-slash");
	}
	if (
		path.split("/").some((segment) => segment === "." || segment === "..")
	) {
		throw new ContextSourcePathError("dot-segment");
	}
	if (path.length > MAX_CONTEXT_SOURCE_PATH_LENGTH) {
		throw new ContextSourcePathError("too-long");
	}
	return path;
}

function prefixError(
	reason: ContextSourcePathPrefixErrorReason,
): ContextSourcePathError {
	return new ContextSourcePathError(reason, PREFIX_REASON_MESSAGES[reason]);
}

/**
 * The directory a contexts-list filter selects synced files under (Fizzy
 * #2620), spelled so it can be compared as a string prefix of the stored
 * keys {@link normalizeContextSourcePath} produces.
 *
 * Returns `""` for the tree's root (`""`, `.`, `./`), meaning "every synced
 * file". Otherwise returns the directory path with exactly one trailing
 * `/`, so `docs` selects `docs/a.md` and `docs/guides/b.md` but never
 * `docs-archive/c.md`, and `docs` and `docs/` are one filter.
 *
 * The rules are the file-path rules, applied to a directory: NFC, a leading
 * `./` stripped, and refusals for control/format characters, an absolute
 * path, a `.` or `..` segment, and a result that leaves no room for a file
 * name within {@link MAX_CONTEXT_SOURCE_PATH_LENGTH} characters. Two
 * spellings the file-path helper
 * rewrites are refused here instead — a backslash and an empty segment
 * (`docs//guides`) — because a stored key never contains either, so a
 * prefix holding one could only ever match nothing, silently.
 *
 * Pure: no Prisma, no I/O. Throws {@link ContextSourcePathError}, which the
 * API layer maps to a 400. The result is NOT escaped for SQL `LIKE`; a
 * caller building a `startsWith` filter has to do that itself.
 */
export function normalizeContextSourcePathPrefix(input: string): string {
	const value = input.normalize("NFC");

	if (hasControlOrFormatCharacter(value)) {
		throw prefixError("control-character");
	}
	if (value.includes("\\")) {
		throw prefixError("backslash");
	}
	if (value.startsWith("/") || DRIVE_LETTER_PREFIX.test(value)) {
		throw prefixError("absolute");
	}

	let path = value;
	while (path.startsWith("./")) {
		path = path.slice(2);
	}
	if (path === "" || path === ".") {
		return "";
	}
	if (path.endsWith("/")) {
		path = path.slice(0, -1);
	}

	const segments = path.split("/");
	if (segments.some((segment) => segment === "")) {
		throw prefixError("empty-segment");
	}
	if (segments.some((segment) => segment === "." || segment === "..")) {
		throw prefixError("dot-segment");
	}

	// A prefix has to leave room for at least one character of file name
	// under it, or no stored key could ever start with it.
	const prefix = `${path}/`;
	if (prefix.length >= MAX_CONTEXT_SOURCE_PATH_LENGTH) {
		throw prefixError("too-long");
	}
	return prefix;
}
