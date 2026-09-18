/**
 * The one writer every file this feature creates goes through — instruction
 * files, the lock, and the Claude Code settings file alike.
 *
 * It exists because there were three writers before and only one of them was
 * guarded. `.claude -> ..` or `.fabric -> ..` in a checkout turned `init` and
 * `sync` into writes outside the destination, because the hook and the lock
 * never asked the question the instruction files did. A guard that only some
 * writes call is not a guard.
 *
 * What every write proves first:
 *
 *   1. The destination is canonicalised once with `realpath`. Lexical
 *      resolution is not enough — `/tmp` is a symlink on macOS, so the
 *      literal string a user passes and the directory they mean are
 *      routinely different, and containment has to be decided on the real
 *      one. The destination itself is resolved rather than refused for that
 *      reason; everything BELOW it is held to the stricter rule.
 *   2. No segment between the root and the file is a symlink. Checked with
 *      `lstat`, from the first child down to and including the target.
 *   3. The deepest existing ancestor's `realpath` is still inside the root.
 *      Layer 2 answers "is this a link"; this answers "did anything else —
 *      a bind mount, a replaced directory — move it".
 *   4. The temp file is created with `wx` and an unpredictable name, so a
 *      pre-planted file is an error rather than a file we write through.
 *   5. The parent is re-checked immediately before `rename`, closing the
 *      window between the walk and the write.
 *
 * Bytes are preserved exactly: no newline conversion, no re-encoding. The
 * server hashes these files and so does the next sync.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import { describeRejection, type PathCheck } from "./paths.js";

/**
 * The modes a published file may carry.
 *
 * The server derives exactly these two from an upload, so anything else is a
 * malformed or hostile manifest rather than a file that needs it. An
 * allow-list rather than a mask, because masking with `0o7777` preserves
 * setuid, setgid, sticky and every write bit — a manifest asking for `04777`
 * would have been honoured.
 */
const ALLOWED_MODES = new Set([0o644, 0o755]);

export function isAllowedMode(mode: number | null | undefined): boolean {
	if (mode === null || mode === undefined) {
		return true;
	}
	if (!Number.isInteger(mode) || mode < 0) {
		return false;
	}
	// A manifest records the full `st_mode` (`0o100644`), so compare on the
	// permission bits and require the file-type bits to be a regular file or
	// absent.
	const type = mode & 0o170000;
	if (type !== 0 && type !== 0o100000) {
		return false;
	}
	return ALLOWED_MODES.has(mode & 0o7777);
}

/** The permission bits to apply, or null when none were published. */
export function permissionBits(mode: number | null | undefined): number | null {
	if (mode === null || mode === undefined) {
		return null;
	}
	return mode & 0o7777;
}

/**
 * Canonicalise the destination once, for every subsequent check to resolve
 * against. Created if missing: `--dest` naming a directory that does not
 * exist yet is an ordinary first sync.
 */
export async function resolveDestinationRoot(
	destination: string,
): Promise<string> {
	await mkdir(destination, { recursive: true });
	return realpath(destination);
}

/**
 * Where a relative path lands under an already-canonical root, or why it may
 * not land at all. `relativePath` must already have passed
 * `checkRelativePath`.
 */
export async function assertSafeTarget(
	root: string,
	relativePath: string,
): Promise<PathCheck> {
	const target = path.resolve(root, relativePath);
	if (target === root || !target.startsWith(root + path.sep)) {
		return {
			ok: false,
			reason: "escapes_destination",
			detail: relativePath,
		};
	}

	const segments = relativePath.split("/");
	let current = root;
	let deepestExisting = root;
	for (const [index, segment] of segments.entries()) {
		current = path.join(current, segment);
		const stats = await lstatOrNull(current);
		if (stats === null) {
			// Everything below here is about to be created, and a path that
			// does not exist cannot be a link to somewhere else.
			break;
		}
		if (stats.isSymbolicLink()) {
			return { ok: false, reason: "symlink", detail: current };
		}
		// An ANCESTOR that is not a directory. `lstat` on anything below it
		// answers ENOTDIR, which used to read as "absent" — so a regular file
		// at `z` let `z/child.md` pass the whole-plan preflight and fail in
		// `makeParents` after earlier entries had already been written.
		if (index < segments.length - 1 && !stats.isDirectory()) {
			return { ok: false, reason: "not_a_directory", detail: current };
		}
		deepestExisting = current;
	}

	// Layer 3. `lstat` said no component IS a link; this says the components
	// still resolve where they appeared to.
	if (deepestExisting !== root) {
		const canonical = await realpath(deepestExisting).catch(() => null);
		if (
			canonical !== null &&
			canonical !== root &&
			!canonical.startsWith(root + path.sep)
		) {
			return {
				ok: false,
				reason: "escapes_destination",
				detail: relativePath,
			};
		}
	}

	return { ok: true, path: target };
}

/**
 * `assertSafeTarget`, plus: whatever is already at the final path must be an
 * ordinary file.
 *
 * `assertSafeTarget` answers "may this land here" — no symlinked component,
 * nothing resolving outside the root. It does not answer "is the thing
 * already there a file". A directory at a manifest path passed it, and the
 * eventual `rename` refused, but only after earlier entries in the same plan
 * had already been written. A fifo, socket or device node would be opened and
 * written through. Both are now refusals, and the caller runs this over EVERY
 * manifest and delete path before it mutates anything.
 */
export async function assertWritableTarget(
	root: string,
	relativePath: string,
): Promise<PathCheck> {
	const check = await assertSafeTarget(root, relativePath);
	if (!check.ok) {
		return check;
	}
	const stats = await lstatOrNull(check.path);
	if (stats === null) {
		return check;
	}
	if (stats.isSymbolicLink()) {
		return { ok: false, reason: "symlink", detail: check.path };
	}
	if (!stats.isFile()) {
		return { ok: false, reason: "not_a_regular_file", detail: check.path };
	}
	return check;
}

/**
 * Read a file under an already-canonical root, through the same guard every
 * write goes through, or `null` when it is not there.
 *
 * READS need the walk as much as writes do. The ledger check and the planner
 * used to `path.join` and `lstat` directly, which meant a lock path of
 * `../outside` read outside the destination, and an ancestor replaced by a
 * symlink was followed to wherever it pointed — hashing, and possibly loading
 * into memory, a file this tool has no business opening. A refusal is the
 * answer in both cases, not a hash.
 */
export async function readFileSafely(
	root: string,
	relativePath: string,
): Promise<{ bytes: Uint8Array; mode: number } | null> {
	const check = await assertWritableTarget(root, relativePath);
	if (!check.ok) {
		throw new Error(`Refusing to sync: ${describeRejection(check)}.`);
	}
	const stats = await lstatOrNull(check.path);
	if (stats === null) {
		return null;
	}
	try {
		return { bytes: await readFile(check.path), mode: stats.mode };
	} catch (error) {
		// Removed between the `lstat` and the `open`: absent is the honest
		// answer, and the caller plans to write it.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

/**
 * The canonical form of a destination that must NOT be created.
 *
 * `resolveDestinationRoot` makes the directory, which is right for a sync and
 * wrong for `check`, an informational command. A destination that does not
 * exist has no lock either, so the literal resolved path is a fine answer.
 */
export async function resolveExistingRoot(
	destination: string,
): Promise<string> {
	return realpath(destination).catch(() => path.resolve(destination));
}

/**
 * Create every missing parent directory of `relativePath`, one segment at a
 * time, refusing a symlink at each step.
 *
 * `mkdir(..., { recursive: true })` cannot be used for this: it follows an
 * existing symlinked component silently, which is the whole thing being
 * defended against.
 */
async function makeParents(root: string, relativePath: string): Promise<void> {
	const segments = relativePath.split("/").slice(0, -1);
	let current = root;
	for (const segment of segments) {
		current = path.join(current, segment);
		const stats = await lstatOrNull(current);
		if (stats === null) {
			await mkdir(current).catch(async (error: NodeJS.ErrnoException) => {
				// A concurrent writer got there first. Re-check what landed
				// rather than assuming it is a directory.
				if (error.code !== "EEXIST") {
					throw error;
				}
				const raced = await lstatOrNull(current);
				if (raced?.isSymbolicLink()) {
					throw new Error(
						`Refusing to sync: ${describeRejection({ ok: false, reason: "symlink", detail: current })}.`,
					);
				}
			});
			continue;
		}
		if (stats.isSymbolicLink()) {
			throw new Error(
				`Refusing to sync: ${describeRejection({ ok: false, reason: "symlink", detail: current })}.`,
			);
		}
		if (!stats.isDirectory()) {
			throw new Error(
				`Refusing to sync: ${describeRejection({ ok: false, reason: "not_a_directory", detail: current })}.`,
			);
		}
	}
}

/**
 * Write one file atomically under an already-canonical root.
 *
 * `relativePath` must have passed `checkRelativePath` and any policy check
 * the caller owns (reserved paths, collisions) BEFORE this is called — this
 * function enforces the filesystem invariants, not the feature's rules.
 */
export async function writeFileSafely(input: {
	root: string;
	relativePath: string;
	bytes: Uint8Array;
	mode?: number | null;
}): Promise<void> {
	const check = await assertSafeTarget(input.root, input.relativePath);
	if (!check.ok) {
		throw new Error(`Refusing to sync: ${describeRejection(check)}.`);
	}
	if (!isAllowedMode(input.mode)) {
		throw new Error(
			`Refusing to sync: ${input.relativePath} asks for file mode ${(input.mode ?? 0).toString(8)}, and only 644 and 755 are accepted.`,
		);
	}

	await makeParents(input.root, input.relativePath);

	const target = check.path;
	const directory = path.dirname(target);
	// The identity of the directory we are about to create the temp file in.
	// Cleanup below unlinks BY PATH, and a path no longer names the same
	// directory once something has swapped it; unlinking then would delete a
	// stranger's file and leave the real temp behind. Node has no
	// handle-relative unlink, so the next best thing is to refuse to clean up
	// through a path that has moved.
	const directoryBefore = await lstatOrNull(directory);
	// Unpredictable, so a pre-planted temp file cannot be waiting for us, and
	// `wx` so creating one that already exists is an error rather than a
	// write through whatever is there.
	const temporary = path.join(
		directory,
		`.${path.basename(target)}.${randomBytes(8).toString("hex")}.tmp`,
	);

	let handle: FileHandle | null = null;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(input.bytes);
		const bits = permissionBits(input.mode);
		if (bits !== null && process.platform !== "win32") {
			await handle.chmod(bits);
		}
		await handle.close();
		handle = null;

		// The walk above happened before the file was written. Re-check the
		// parent now, so a directory swapped for a link in between cannot
		// receive the rename.
		const parentStats = await lstatOrNull(directory);
		if (parentStats === null || parentStats.isSymbolicLink()) {
			throw new Error(
				`Refusing to sync: ${describeRejection({ ok: false, reason: "symlink", detail: directory })}.`,
			);
		}
		const targetStats = await lstatOrNull(target);
		if (targetStats?.isSymbolicLink()) {
			throw new Error(
				`Refusing to sync: ${describeRejection({ ok: false, reason: "symlink", detail: target })}.`,
			);
		}

		await rename(temporary, target);
	} catch (error) {
		await handle?.close().catch(() => {});
		if (await isSameDirectory(directory, directoryBefore)) {
			await unlink(temporary).catch(() => {});
		}
		throw error;
	}
}

/** Does this path still name the directory we checked earlier? */
async function isSameDirectory(
	directory: string,
	before: Stats | null,
): Promise<boolean> {
	if (before === null) {
		return false;
	}
	const now = await lstatOrNull(directory);
	return now !== null && now.dev === before.dev && now.ino === before.ino;
}

export type DeleteOutcome = "deleted" | "missing" | "modified";

/**
 * Remove one file under an already-canonical root — but only if it is still
 * the file the caller decided to remove.
 *
 * The plan hashes a departed file during planning, and a download, an
 * extraction and every write happen between then and here. An unconditional
 * `unlink` therefore deleted whatever was at that path by the time it ran,
 * including an edit the developer had saved in the meantime. The expected
 * hash travels with the request and is checked against the bytes on disk
 * immediately before the unlink; a file that no longer matches is left alone
 * and reported as kept.
 *
 * Residual, stated rather than hidden: a write landing between that hash and
 * the `unlink` is still lost. Node offers no way to unlink a specific inode,
 * so closing it entirely would need handle-relative syscalls the runtime does
 * not expose. Concurrent mutation of the destination by the same user during
 * a sync is out of scope for this tool.
 */
export async function deleteFileSafely(
	root: string,
	relativePath: string,
	expectedSha256: string,
): Promise<DeleteOutcome> {
	const check = await assertSafeTarget(root, relativePath);
	if (!check.ok) {
		throw new Error(`Refusing to sync: ${describeRejection(check)}.`);
	}

	const stats = await lstatOrNull(check.path);
	if (stats === null) {
		return "missing";
	}
	if (stats.isSymbolicLink()) {
		throw new Error(
			`Refusing to sync: ${describeRejection({ ok: false, reason: "symlink", detail: check.path })}.`,
		);
	}
	if (!stats.isFile()) {
		throw new Error(
			`Refusing to sync: ${describeRejection({ ok: false, reason: "not_a_regular_file", detail: check.path })}.`,
		);
	}

	let actual: string;
	try {
		actual = createHash("sha256")
			.update(await readFile(check.path))
			.digest("hex");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return "missing";
		}
		throw error;
	}
	if (actual !== expectedSha256) {
		return "modified";
	}

	try {
		await unlink(check.path);
		return "deleted";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return "missing";
		}
		throw error;
	}
}

/**
 * `lstat`, with ONLY `ENOENT` meaning "nothing there".
 *
 * `ENOTDIR` used to be folded in here, and it does not mean the same thing at
 * all: it means an ancestor exists and is not a directory. Reading it as
 * "absent" is what let a regular file at `z` pass the preflight for
 * `z/child.md`. Callers that walk a path check the ancestors themselves; this
 * one lets the error through so nothing can mistake the two again.
 */
async function lstatOrNull(target: string) {
	try {
		return await lstat(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

/**
 * Does `candidate` sit inside `root` once both are resolved as far as the
 * filesystem allows?
 *
 * Used for the credential check in `hook.ts`, where the question is about a
 * path that may not exist yet and whose ancestors may be links. Lexical
 * comparison answered it wrongly in both directions: a config file reached
 * through a symlink into the checkout looked outside it, and a destination
 * under a symlinked parent looked like a mismatch.
 */
export async function resolvesInside(
	root: string,
	candidate: string,
): Promise<boolean> {
	const canonicalRoot = await realpath(root).catch(() => path.resolve(root));
	const canonicalCandidate = await realpathDeepest(candidate);
	return (
		canonicalCandidate === canonicalRoot ||
		canonicalCandidate.startsWith(canonicalRoot + path.sep)
	);
}

/**
 * `realpath` of the deepest existing ancestor, with the not-yet-existing tail
 * appended. `realpath` throws on a missing path, and a config file that has
 * not been written yet still has an answer worth having.
 */
async function realpathDeepest(candidate: string): Promise<string> {
	const absolute = path.resolve(candidate);
	const tail: string[] = [];
	let current = absolute;
	for (;;) {
		const resolved = await realpath(current).catch(() => null);
		if (resolved !== null) {
			return tail.length === 0 ? resolved : path.join(resolved, ...tail);
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return absolute;
		}
		tail.unshift(path.basename(current));
		current = parent;
	}
}
