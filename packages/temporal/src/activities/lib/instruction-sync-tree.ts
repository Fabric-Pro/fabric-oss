/**
 * Tree inventory for the repository sync (design 2026-09-23 §5.3.2 steps 5,
 * 8, 10). Pure functions over `git ls-tree -r -z` output. Not re-exported from
 * the activities barrel.
 */

export type TreeEntry = {
	/** The path in the repository, byte-exact: sparse patterns and `lstat` use it. */
	repoPath: string;
	/** `repoPath` relative to the configured root, before `validateRelativePath`. */
	relPath: string;
	gitMode: "100644" | "100755";
	oid: string;
};

export type LsTreeSummary = {
	files: TreeEntry[];
	/** Symlinks, submodules, other modes and non-UTF-8 names under the root. */
	excludedCount: number;
	/** Every entry under the root, kept or not: what the inventory cap counts. */
	underRoot: number;
};

const RECORD = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Bounds a single NUL-free record (review S4; widened in fix round 2 after a
 * blocking defect in the first bound). The record holds the FULL repository
 * path -- `rootPath` + `/` + `relPath` -- and each of those two segments can
 * legally run up to `SNAPSHOT_LIMITS.maxPathBytes` (512) on its own, so a
 * real record can be over 1 KiB even before the header; a tighter bound
 * derived from a single `maxPathBytes` undercounted that and rejected a
 * legitimate record depending on where the chunk boundary fell. 64 KiB has
 * wide headroom over any legal record, and the NUL search above already
 * starts at the previous `pending.length`, so buffering up to this size
 * costs one bounded `Buffer.concat`, not the quadratic re-scan this bound
 * exists to cut off for a hostile, NUL-free object name.
 */
const MAX_RECORD_BYTES = 65_536;

/**
 * A streaming parser: `ls-tree -z` ends every record with NUL and never
 * quotes paths, so a record is `<mode> SP <type> SP <oid> TAB <path> NUL`
 * with the path as raw bytes. The header is split off as bytes before the
 * path is decoded, so a TAB or a non-UTF-8 byte inside a path cannot shift
 * the fields.
 */
export function createLsTreeParser(input: {
	rootPath: string;
	maxEntries: number;
}): {
	push(chunk: Buffer): "ok" | "limit";
	finish(): LsTreeSummary;
} {
	const prefix = input.rootPath === "" ? "" : `${input.rootPath}/`;
	const files: TreeEntry[] = [];
	let excludedCount = 0;
	let underRoot = 0;
	let pending: Buffer = Buffer.alloc(0);

	const consume = (record: Buffer): void => {
		const tab = record.indexOf(0x09);
		if (tab < 0) {
			return;
		}
		const header = RECORD.exec(
			record.subarray(0, tab + 1).toString("latin1"),
		);
		if (!header) {
			return;
		}
		let repoPath: string;
		try {
			repoPath = UTF8.decode(record.subarray(tab + 1));
		} catch {
			underRoot++;
			excludedCount++;
			return;
		}
		if (prefix !== "" && !repoPath.startsWith(prefix)) {
			// The root itself as a blob, or a pathspec match outside it.
			if (repoPath === input.rootPath) {
				underRoot++;
				excludedCount++;
			}
			return;
		}
		underRoot++;
		const [, mode, type, oid] = header;
		if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
			excludedCount++;
			return;
		}
		files.push({
			repoPath,
			relPath: repoPath.slice(prefix.length),
			gitMode: mode,
			oid: oid as string,
		});
	};

	return {
		push(chunk) {
			// The NUL search after concatenation starts at the previous
			// `pending.length` (review S4): everything before that offset was
			// already scanned with no NUL found on an earlier call, so
			// re-scanning it here on every chunk is what made a long,
			// NUL-free record cost O(n^2) rather than O(n).
			const previousLength = pending.length;
			pending =
				previousLength === 0 ? chunk : Buffer.concat([pending, chunk]);
			let nul = pending.indexOf(0, previousLength);
			while (nul >= 0) {
				consume(pending.subarray(0, nul));
				pending = pending.subarray(nul + 1);
				if (underRoot > input.maxEntries) {
					return "limit";
				}
				nul = pending.indexOf(0);
			}
			if (pending.length > MAX_RECORD_BYTES) {
				return "limit";
			}
			return "ok";
		},
		finish() {
			if (pending.length > 0) {
				consume(pending);
				pending = Buffer.alloc(0);
			}
			return { files, excludedCount, underRoot };
		},
	};
}

/**
 * One non-cone sparse-checkout pattern naming exactly this file (spec §5.3.2
 * step 8): anchored with `/`, and every character gitignore syntax treats
 * specially escaped with a backslash, so `x[1].md` never also selects
 * `x1.md`. Leading and trailing spaces are escaped because gitignore strips
 * trailing ones. The planner refuses `*`, `?` and a trailing space already;
 * they are escaped anyway so this function is correct on its own.
 */
export function sparsePatternFor(repoPath: string): string {
	const escaped = repoPath
		.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`)
		.replace(/^ +/, (spaces) => spaces.replace(/ /g, "\\ "))
		.replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
	return `/${escaped}`;
}

export function fileModeForGitMode(mode: "100644" | "100755"): number {
	return mode === "100755" ? 0o755 : 0o644;
}

/**
 * The one normalisation every mode-aware comparison in the coding-instructions
 * feature applies before comparing or hashing: `null`/`undefined` reads as
 * the default `0o644`, and anything else is masked down to its permission
 * bits. The mask matters because the wire contract admits more than bare
 * permission bits — `isAllowedMode`
 * (`packages/cli/src/lib/instructions/safe-write.ts`) validates a manifest
 * entry's mode on `mode & 0o7777` and explicitly accepts a full `st_mode`
 * (e.g. `0o100644`) — so two representations of the same permission must
 * compare equal here too. Mirrored in `computeSnapshotDigest`
 * (`packages/instructions/src/manifest.ts`) and `normalizedMode`
 * (`packages/database/prisma/queries/instructions.ts`).
 */
function normalizeMode(mode: number | null | undefined): number {
	return mode == null ? 0o644 : mode & 0o7777;
}

/**
 * Whether the kept tree is the published tree, content AND modes (spec
 * §5.3.2 step 10). A null mode on the published side is an upload's "no mode
 * recorded", read as 0644 — the same normalisation `computeSnapshotDigest`
 * now applies, so a mode-only difference this function reports also moves
 * the digest and is never silently absorbed by a `sinceDigest` comparison.
 */
export function treesEqual(
	kept: readonly { path: string; sha256: string; mode: number }[],
	published: readonly { path: string; sha256: string; mode: number | null }[],
): boolean {
	if (kept.length !== published.length) {
		return false;
	}
	const byPath = new Map(published.map((f) => [f.path, f]));
	return kept.every((f) => {
		const other = byPath.get(f.path);
		return (
			other !== undefined &&
			other.sha256 === f.sha256 &&
			normalizeMode(other.mode) === normalizeMode(f.mode)
		);
	});
}

/**
 * One `ls-tree -r -z` record, kept byte-exact for the proposal commit (Fizzy
 * #2563 spec §7 step 2). Unlike `TreeEntry`, nothing is dropped: symlinks and
 * gitlinks are what collision checks must see, and a non-UTF-8 name keeps its
 * raw bytes with `path: null`.
 */
export type RawTreeEntry = {
	mode: "100644" | "100755" | "120000" | "160000";
	type: "blob" | "commit";
	oid: string;
	/** The repository path exactly as git stores it. */
	rawPath: Buffer;
	/** `rawPath` decoded as UTF-8, or null when it is not valid UTF-8. */
	path: string | null;
};

const RAW_KINDS: Record<string, RawTreeEntry["type"]> = {
	"100644": "blob",
	"100755": "blob",
	"120000": "blob",
	"160000": "commit",
};

/**
 * A streaming parser for `ls-tree -r -z <sha> [-- <root>]`, keeping every
 * entry at or under `rootPath` (compared as bytes, so a non-UTF-8 name is
 * still placed correctly). "invalid" means a record git should never print
 * with `-r` (a tree, or an unknown mode or type): the caller fails rather
 * than let an unseen entry escape the collision checks. "limit" means more
 * than `maxEntries` entries, or one record longer than any legal one.
 */
export function createRawLsTreeParser(input: {
	rootPath: string;
	maxEntries: number;
}): {
	push(chunk: Buffer): "ok" | "limit" | "invalid";
	finish(): { entries: RawTreeEntry[]; invalid: boolean };
} {
	const root = Buffer.from(input.rootPath, "utf8");
	const prefix = Buffer.from(
		input.rootPath === "" ? "" : `${input.rootPath}/`,
		"utf8",
	);
	const entries: RawTreeEntry[] = [];
	let pending: Buffer = Buffer.alloc(0);
	let invalid = false;

	const underRoot = (rawPath: Buffer): boolean =>
		prefix.length === 0 ||
		rawPath.equals(root) ||
		(rawPath.length > prefix.length &&
			rawPath.subarray(0, prefix.length).equals(prefix));

	const consume = (record: Buffer): void => {
		if (record.length === 0) {
			return;
		}
		const tab = record.indexOf(0x09);
		const header =
			tab < 0
				? null
				: /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(
						record.subarray(0, tab).toString("latin1"),
					);
		if (!header) {
			invalid = true;
			return;
		}
		const [, mode, type, oid] = header;
		if (RAW_KINDS[mode as string] !== type) {
			invalid = true;
			return;
		}
		const rawPath = Buffer.from(record.subarray(tab + 1));
		if (!underRoot(rawPath)) {
			return;
		}
		let decoded: string | null;
		try {
			decoded = UTF8.decode(rawPath);
		} catch {
			decoded = null;
		}
		entries.push({
			mode: mode as RawTreeEntry["mode"],
			type: type as RawTreeEntry["type"],
			oid: oid as string,
			rawPath,
			path: decoded,
		});
	};

	return {
		push(chunk) {
			const previousLength = pending.length;
			pending =
				previousLength === 0 ? chunk : Buffer.concat([pending, chunk]);
			let nul = pending.indexOf(0, previousLength);
			while (nul >= 0) {
				consume(pending.subarray(0, nul));
				pending = pending.subarray(nul + 1);
				if (invalid) {
					return "invalid";
				}
				if (entries.length > input.maxEntries) {
					return "limit";
				}
				nul = pending.indexOf(0);
			}
			return pending.length > MAX_RECORD_BYTES ? "limit" : "ok";
		},
		finish() {
			if (pending.length > 0) {
				consume(pending);
				pending = Buffer.alloc(0);
			}
			return { entries, invalid };
		},
	};
}
