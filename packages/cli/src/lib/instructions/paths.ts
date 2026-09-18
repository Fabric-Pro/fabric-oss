/**
 * Path safety for the file-writing half of this CLI.
 *
 * The paths this module guards arrive from a server response and from a zip
 * archive, and they are about to become filesystem writes on a developer's
 * machine. That makes the check local: the server validates paths on upload,
 * but a client that trusts a remote path list has moved the decision to the
 * wrong side of the wire. Nothing here asks the network anything.
 *
 * Three layers, and they answer different questions:
 *
 *   `checkRelativePath`      is this STRING safe to turn into a write?
 *   `isReservedPath`         is this path one this feature refuses to own?
 *   `collisionKey`           do two safe strings name the same file anyway?
 *
 * The filesystem half — symlinks, canonical containment, atomic writes —
 * lives in `safe-write.ts`, because it needs a resolved destination root and
 * these functions deliberately do not.
 */

type PathRejectReason =
	| "empty"
	| "absolute"
	| "traversal"
	| "backslash"
	| "control_char"
	| "trailing_separator"
	| "trailing_dot_or_space"
	| "reserved_device_name"
	| "alternate_data_stream"
	| "reserved_path"
	| "not_a_regular_file"
	| "escapes_destination"
	| "symlink"
	| "not_a_directory"
	| "collision";

export interface PathRejection {
	ok: false;
	reason: PathRejectReason;
	/** The offending path, as given, or the link that was in the way. */
	detail: string;
}

export type PathCheck = { ok: true; path: string } | PathRejection;

const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * Names Windows resolves to a device rather than a file, with or without an
 * extension: `NUL`, `nul.txt` and `CON.md` all reach the device. Writing the
 * tree on Windows would silently discard those files; worse, a manifest could
 * use one to make a write look like it happened.
 */
const RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/**
 * Paths this feature refuses to write or delete, whatever a manifest or a
 * lock says.
 *
 * `.git` is the obvious one: a lock is a plain JSON file inside the checkout,
 * so anything that can edit it could otherwise name `.git/config` — a file
 * whose current hash is easy to know — and have the next sync unlink it.
 * `.fabric` is here because the lock lives there and must never be able to
 * authorise its own deletion or replacement through the manifest path.
 */
const RESERVED_ROOTS = [".git", ".fabric"] as const;

/**
 * Single files this feature refuses to own, as opposed to whole roots.
 *
 * `.claude/settings.local.json` is the file `init` itself writes. Instruction
 * files legitimately live elsewhere under `.claude/` — skills, commands — so
 * reserving the whole root would refuse the feature's own content; reserving
 * this one path stops a published manifest from overwriting the session hook
 * that was just installed, and stops the resulting lock from later
 * authorising its deletion.
 */
const RESERVED_EXACT_PATHS = [".claude/settings.local.json"] as const;

/**
 * NUL and friends, found by character code rather than by a regular
 * expression.
 *
 * A character class cannot say this here. Written as unicode escapes, the
 * formatter rewrites each escape into the character it names, which puts
 * a literal NUL byte in this source file and makes git treat it as binary.
 * A loop says the same thing and stays readable in a diff.
 */
function hasControlCharacter(input: string): boolean {
	for (let index = 0; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

/**
 * Is this manifest/archive path safe to turn into a write inside a
 * destination? String-level only — see `safe-write.ts` for the filesystem
 * half.
 */
export function checkRelativePath(input: string): PathCheck {
	if (input.length === 0) {
		return { ok: false, reason: "empty", detail: input };
	}
	if (hasControlCharacter(input)) {
		return { ok: false, reason: "control_char", detail: input };
	}
	if (input.includes("\\")) {
		return { ok: false, reason: "backslash", detail: input };
	}
	if (input.startsWith("/") || DRIVE_LETTER.test(input)) {
		return { ok: false, reason: "absolute", detail: input };
	}
	if (input.endsWith("/")) {
		return { ok: false, reason: "trailing_separator", detail: input };
	}
	const segments = input.split("/");
	if (segments.some((s) => s.length === 0)) {
		// An empty segment means `a//b` or a leading slash already refused
		// above; either way the string is not the path it appears to be.
		return { ok: false, reason: "empty", detail: input };
	}
	if (segments.some((s) => s === "." || s === "..")) {
		return { ok: false, reason: "traversal", detail: input };
	}
	for (const segment of segments) {
		// Windows strips a trailing dot or space from a name, so `a.md.` and
		// `a.md ` both open `a.md`. Two manifest entries that differ only
		// there would be two writes to one file, with the lock claiming both.
		if (/[. ]$/.test(segment)) {
			return {
				ok: false,
				reason: "trailing_dot_or_space",
				detail: input,
			};
		}
		if (RESERVED_DEVICE_NAME.test(segment)) {
			return {
				ok: false,
				reason: "reserved_device_name",
				detail: input,
			};
		}
		// `a.md:stream` addresses an NTFS alternate data stream on `a.md`,
		// which is a write to a file the manifest never named.
		if (segment.includes(":")) {
			return {
				ok: false,
				reason: "alternate_data_stream",
				detail: input,
			};
		}
	}
	return { ok: true, path: input };
}

/**
 * Is this a path this feature refuses to own, whoever asked?
 *
 * Applied to manifest entries AND to lock entries, on writes AND on deletes:
 * the lock is the thing being defended against here, so checking only what
 * the server sent would miss the case entirely.
 */
export function isReservedPath(input: string): boolean {
	const first = input.split("/")[0]?.toLowerCase();
	if (RESERVED_ROOTS.some((root) => first === root)) {
		return true;
	}
	// Compared by collision key, not by string: on a case-insensitive
	// filesystem `.claude/Settings.Local.json` is the same file, and a
	// manifest that spells it differently must not slip past.
	const key = collisionKey(input);
	return RESERVED_EXACT_PATHS.some(
		(reserved) => collisionKey(reserved) === key,
	);
}

/**
 * A key two paths share when the filesystem would treat them as one file.
 *
 * macOS stores names in a normalised form and compares case-insensitively,
 * so `café.md` written as NFC and as NFD are one file with two spellings,
 * and `README.md`/`readme.md` are one file. The server's own collision check
 * catches ordinary case variants; it does not catch Unicode normalisation.
 *
 * Deliberately conservative and platform-independent: a manifest that would
 * collide on macOS is refused on Linux too, because the alternative is a
 * tree that syncs cleanly for one developer and silently loses a file for
 * the next.
 */
export function collisionKey(input: string): string {
	return input.normalize("NFC").toLowerCase();
}

/**
 * The first pair of manifest/lock paths that name the same file, or null.
 */
export function findCollision(
	paths: readonly string[],
): { first: string; second: string } | null {
	const seen = new Map<string, string>();
	for (const candidate of paths) {
		const key = collisionKey(candidate);
		const previous = seen.get(key);
		if (previous !== undefined) {
			return { first: previous, second: candidate };
		}
		seen.set(key, candidate);
	}
	return null;
}

/** A one-line reason a reader can act on. */
export function describeRejection(rejection: PathRejection): string {
	switch (rejection.reason) {
		case "empty":
			return `empty or malformed path (${JSON.stringify(rejection.detail)})`;
		case "absolute":
			return `absolute path refused: ${rejection.detail}`;
		case "traversal":
			return `path traversal refused: ${rejection.detail}`;
		case "backslash":
			return `backslash in path refused: ${rejection.detail}`;
		case "control_char":
			return `control character in path refused: ${JSON.stringify(rejection.detail)}`;
		case "trailing_separator":
			return `path names a directory, not a file: ${rejection.detail}`;
		case "trailing_dot_or_space":
			return `path segment ending in a dot or space refused: ${rejection.detail}`;
		case "reserved_device_name":
			return `reserved device name refused: ${rejection.detail}`;
		case "alternate_data_stream":
			return `colon in path refused: ${rejection.detail}`;
		case "reserved_path":
			return `this tool never writes or deletes ${RESERVED_ROOTS.join(", ")} or ${RESERVED_EXACT_PATHS.join(", ")}: ${rejection.detail}`;
		case "not_a_regular_file":
			return `path is not a regular file: ${rejection.detail}`;
		case "escapes_destination":
			return `path resolves outside the destination: ${rejection.detail}`;
		case "symlink":
			// "follow", not "write through": the same guard now runs for reads
			// — the ledger check and the planner both go through it — and a
			// read-only `check --verify` should not talk about writing.
			return `refusing to follow a symlink: ${rejection.detail}`;
		case "not_a_directory":
			return `a path component is not a directory: ${rejection.detail}`;
		case "collision":
			return `two paths name the same file on a case- or Unicode-insensitive filesystem: ${rejection.detail}`;
	}
}
