import { SNAPSHOT_LIMITS } from "./limits";

export type PathRejectReason =
	| "empty"
	| "absolute"
	| "traversal"
	| "drive"
	| "unc"
	| "too_long"
	| "too_deep"
	| "control_char";

export type PathValidation =
	| { ok: true; path: string }
	| { ok: false; reason: PathRejectReason };

/**
 * Why a NAME cannot be stored, as opposed to why a PATH is unsafe. Kept as
 * its own vocabulary because the two questions are asked at different moments
 * and of different paths — see `validatePortableName`.
 */
export type PortableNameRejectReason =
	| "trailing_dot_or_space"
	| "reserved_device_name"
	/**
	 * A character Windows refuses in a filename: `< > : " | ? *`. A colon
	 * additionally names an NTFS alternate data stream, which is why the
	 * message says so.
	 */
	| "forbidden_character";

export type PortableNameValidation =
	| { ok: true }
	/** `segment` is the offending name, which is what a person has to rename. */
	| { ok: false; reason: PortableNameRejectReason; segment: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/;
const LEADING_DOT_SLASH = /^(\.\/)+/;

/**
 * Names Windows resolves to a device rather than a file, with or without an
 * extension: `NUL`, `nul.txt` and `CON.md` all reach the device.
 */
const RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/**
 * Windows strips a trailing dot or space from a name, so `a.md.` and `a.md `
 * both open `a.md`.
 */
const TRAILING_DOT_OR_SPACE = /[. ]$/;

/**
 * The characters Windows will not put in a filename: `< > : " | ? *`.
 *
 * `/` is absent because it is the separator and is handled structurally; `\`
 * likewise. The rest are refused outright rather than escaped — a file whose
 * name a checkout cannot create is a file the whole manifest fails on.
 */
const FORBIDDEN_NAME_CHARACTER = /[<>:"|?*]/;

export function validateRelativePath(input: string): PathValidation {
	if (input.length === 0) {
		return { ok: false, reason: "empty" };
	}
	if (CONTROL_CHAR.test(input)) {
		return { ok: false, reason: "control_char" };
	}
	if (input.startsWith("\\\\")) {
		return { ok: false, reason: "unc" };
	}
	if (DRIVE_LETTER.test(input)) {
		return { ok: false, reason: "drive" };
	}
	let normalized = input.replace(/\\/g, "/");
	if (normalized.startsWith("/")) {
		return { ok: false, reason: "absolute" };
	}
	normalized = normalized
		.replace(LEADING_DOT_SLASH, "")
		.replace(/\/{2,}/g, "/");
	const segments = normalized.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) {
		return { ok: false, reason: "empty" };
	}
	if (segments.some((s) => s === "." || s === "..")) {
		return { ok: false, reason: "traversal" };
	}
	const joined = segments.join("/");
	if (
		new TextEncoder().encode(joined).length > SNAPSHOT_LIMITS.maxPathBytes
	) {
		return { ok: false, reason: "too_long" };
	}
	if (segments.length > SNAPSHOT_LIMITS.maxDepth) {
		return { ok: false, reason: "too_deep" };
	}
	return { ok: true, path: joined };
}

/**
 * The key two paths share when a filesystem would treat them as ONE file.
 *
 * Lowercasing alone is not enough. macOS stores names in a normalised form
 * and compares case-insensitively, so `café.md` written as NFC and the same
 * name written as NFD are one file with two spellings — two rows in a
 * snapshot, two entries in a manifest, and one file on disk, with whichever
 * one is written second silently winning.
 *
 * Deliberately platform-independent: a pair that would collide on macOS is
 * refused on Linux too, because the alternative is a version that installs
 * cleanly for one developer and loses a file for the next.
 *
 * The CLI carries a byte-identical copy of this function for the paths it
 * receives; see the note in `validateRelativePath` for why.
 */
export function collisionKey(input: string): string {
	return input.normalize("NFC").toLowerCase();
}

/**
 * Why a path cannot join a tree the guard has already been shown.
 *
 * `duplicate`: the same file under another spelling (see `collisionKey`).
 * `file-directory`: one path needs a name to be a FILE while another needs
 * the same name to be a DIRECTORY — `docs` next to `docs/a.md`. No
 * filesystem can hold both, so a version carrying that pair installs
 * nowhere: the checkout fails on whichever of the two it writes second.
 * `conflictsWith` is the already-added path on the other side of the pair.
 */
export type TreeCollision =
	| { kind: "duplicate"; path: string }
	| { kind: "file-directory"; path: string; conflictsWith: string };

/**
 * An incremental check that a set of file paths can coexist as one tree on
 * disk. Shared by every boundary that assembles a tree from paths it was
 * handed — the browser preview and the upload procedure today — so the rule
 * is written once and the two cannot disagree about what installs.
 *
 * Every added file's `collisionKey` is recorded, and so is the key of each
 * of its directory prefixes, cut on segment boundaries only (so `docs.md`
 * and `docs/a.md` share nothing). A new path is refused when its own key is
 * an existing file (duplicate) or an existing directory, or when one of its
 * directory prefixes is an existing file. A refused path is NOT recorded:
 * the caller is expected to stop, and recording it would make the next
 * report name a path that was never accepted.
 *
 * Paths are expected already normalised by `validateRelativePath`.
 */
export function createTreeCollisionGuard(): {
	add(path: string): TreeCollision | null;
} {
	const files = new Map<string, string>();
	// Directory key -> the first file that made it a directory, which is the
	// path a later conflicting file is reported against.
	const directories = new Map<string, string>();
	return {
		add(path) {
			const key = collisionKey(path);
			if (files.has(key)) {
				return { kind: "duplicate", path };
			}
			const fileUnder = directories.get(key);
			if (fileUnder !== undefined) {
				return {
					kind: "file-directory",
					path,
					conflictsWith: fileUnder,
				};
			}
			const segments = path.split("/");
			const prefixKeys: string[] = [];
			for (let i = 1; i < segments.length; i++) {
				const prefixKey = collisionKey(segments.slice(0, i).join("/"));
				const file = files.get(prefixKey);
				if (file !== undefined) {
					return {
						kind: "file-directory",
						path,
						conflictsWith: file,
					};
				}
				prefixKeys.push(prefixKey);
			}
			files.set(key, path);
			for (const prefixKey of prefixKeys) {
				if (!directories.has(prefixKey)) {
					directories.set(prefixKey, path);
				}
			}
			return null;
		},
	};
}

/**
 * Is every SEGMENT of this path a name a checkout can actually write?
 *
 * Separate from `validateRelativePath` on purpose, and the separation is not
 * cosmetic — it is what keeps two things from going wrong:
 *
 *  - A folder upload filters ignored files. `generated/CON.md` inside an
 *    ignored directory is not part of the version at all, and refusing the
 *    whole upload because of a name nobody asked to store would make the
 *    ignore rules useless. So portability is asked AFTER ignore matching,
 *    about the files that will actually be kept.
 *  - A path already IN a published version is grandfathered: it was admitted
 *    before these rules existed and its rows are inherited untouched. The one
 *    thing a person must still be able to do with such a file is DELETE it,
 *    and a delete names a path the database confirms is in the base. Asking
 *    this question about a delete would refuse the repair and leave the file
 *    permanently stuck.
 *
 * Structural safety — absolute, traversal, control characters, empty segments
 * — is the other function's, applies to every path and every operation, and
 * always runs first.
 *
 * The rules themselves are Windows's, applied everywhere: a version that
 * stores on Linux and cannot be installed on Windows is a version that is
 * broken for whoever pulls it, and they find out at `fabric instructions sync`
 * — as a whole refused manifest — rather than here.
 *
 * `packages/cli/src/lib/instructions/paths.ts` carries the same rules for the
 * paths it receives, because the published CLI cannot depend on this private
 * package; `portable-names-agree-with-cli.test.ts` is what keeps the two
 * honest.
 */
export function validatePortableName(path: string): PortableNameValidation {
	for (const segment of path.split("/")) {
		if (segment.length === 0) {
			// Structural, and already refused by `validateRelativePath`.
			continue;
		}
		if (TRAILING_DOT_OR_SPACE.test(segment)) {
			return { ok: false, reason: "trailing_dot_or_space", segment };
		}
		if (RESERVED_DEVICE_NAME.test(segment)) {
			return { ok: false, reason: "reserved_device_name", segment };
		}
		// `a.md:stream` addresses an NTFS alternate data stream on `a.md`,
		// which is a write to a file nobody named. The colon is listed with
		// the other characters Windows refuses in a filename, because a name
		// containing any of them cannot be created there at all — `*` and `?`
		// are glob metacharacters to the shell as well, and `<`, `>` and `|`
		// are redirection operators, so such a name is also a hazard in every
		// script that touches the tree.
		if (FORBIDDEN_NAME_CHARACTER.test(segment)) {
			return { ok: false, reason: "forbidden_character", segment };
		}
	}
	return { ok: true };
}

/**
 * A sentence a person can act on: which file, what is wrong with the name,
 * and what to change. The reason token stays on the validation result for
 * code to branch on; this is what reaches a human or an agent.
 */
export function describePortableNameRefusal(
	path: string,
	refusal: Extract<PortableNameValidation, { ok: false }>,
): string {
	switch (refusal.reason) {
		case "reserved_device_name":
			return `"${path}" cannot be stored: "${refusal.segment}" is a device name on Windows, so a checkout there could never write this file. Rename it to something other than CON, PRN, AUX, NUL, COM1-COM9 or LPT1-LPT9.`;
		case "trailing_dot_or_space":
			return `"${path}" cannot be stored: "${refusal.segment}" ends in a dot or a space, which Windows removes, so it would open a different file. Remove the trailing character and try again.`;
		case "forbidden_character":
			return `"${path}" cannot be stored: "${refusal.segment}" contains a character Windows will not put in a filename (one of < > : " | ? *), so a checkout there could never write this file. A colon additionally names an alternate data stream rather than a file. Rename it without that character and try again.`;
	}
}
