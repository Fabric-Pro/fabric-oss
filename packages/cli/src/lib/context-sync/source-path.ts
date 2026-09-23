/**
 * The server's rule for a synced context file's path, mirrored so a file the
 * server would refuse is skipped here with the same reason word instead of
 * costing a request that can only fail.
 *
 * The authority is `normalizeContextSourcePath` in
 * `packages/database/prisma/queries/projects/context-source-path.ts`; this is
 * a copy rather than an import because `@fabricorg/cli` is published to npm
 * and that package is private. Keep the two in step: the reason words below
 * are the server's `ContextSourcePathErrorReason` values.
 *
 *  - NFC first, so a decomposed name (macOS) and a composed one are one key;
 *  - `\` becomes `/`, repeated separators collapse, a leading `./` goes;
 *  - absolute paths (`/…`, `\\server\…`, any drive-letter prefix) refused;
 *  - a `.` or `..` segment refused anywhere;
 *  - a trailing separator refused;
 *  - C0, DEL, C1 and format (`\p{Cf}`) characters refused;
 *  - at most 512 characters after normalising.
 */

const MAX_CONTEXT_SOURCE_PATH_LENGTH = 512;

type ContextSourcePathProblem =
	| "empty"
	| "absolute"
	| "dot-segment"
	| "trailing-slash"
	| "control-character"
	| "too-long";

export type ContextSourcePathCheck =
	| { ok: true; sourcePath: string }
	| { ok: false; reason: ContextSourcePathProblem };

// Written with escapes so this file itself carries no such characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_OR_FORMAT_CHARACTER = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;

function hasControlOrFormatCharacter(value: string): boolean {
	return CONTROL_OR_FORMAT_CHARACTER.test(value);
}

export function normalizeContextSourcePath(
	input: string,
): ContextSourcePathCheck {
	const slashed = input.normalize("NFC").replace(/\\/g, "/");

	if (hasControlOrFormatCharacter(slashed)) {
		return { ok: false, reason: "control-character" };
	}
	// Before collapsing, so `//server/share` is still recognisably absolute.
	if (slashed.startsWith("/") || DRIVE_LETTER_PREFIX.test(slashed)) {
		return { ok: false, reason: "absolute" };
	}

	let path = slashed.replace(/\/{2,}/g, "/");
	while (path.startsWith("./")) {
		path = path.slice(2);
	}

	if (path.length === 0) {
		return { ok: false, reason: "empty" };
	}
	if (path.endsWith("/")) {
		return { ok: false, reason: "trailing-slash" };
	}
	if (
		path.split("/").some((segment) => segment === "." || segment === "..")
	) {
		return { ok: false, reason: "dot-segment" };
	}
	if (path.length > MAX_CONTEXT_SOURCE_PATH_LENGTH) {
		return { ok: false, reason: "too-long" };
	}
	return { ok: true, sourcePath: path };
}
