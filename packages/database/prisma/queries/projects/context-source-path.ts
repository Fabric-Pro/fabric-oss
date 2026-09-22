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
 */

export const MAX_CONTEXT_SOURCE_PATH_LENGTH = 512;

export type ContextSourcePathErrorReason =
	| "empty"
	| "absolute"
	| "dot-segment"
	| "trailing-slash"
	| "control-character"
	| "too-long";

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
};

export class ContextSourcePathError extends Error {
	readonly reason: ContextSourcePathErrorReason;

	constructor(reason: ContextSourcePathErrorReason) {
		super(REASON_MESSAGES[reason]);
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
