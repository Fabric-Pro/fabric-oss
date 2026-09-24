/**
 * Turning a plan into files, with two rules that decide the shape of
 * everything below.
 *
 * First: verify every byte before writing any byte. Each entry's sha256 is
 * checked against the manifest up front, so a corrupt or tampered archive
 * aborts with nothing written at all, rather than half a tree of good files
 * and one bad one. The caller then does not rewrite the lock, so the next run
 * plans from the last known-good state.
 *
 * Second: every write goes through `safe-write.ts` — the same writer the
 * lock and the Claude Code settings file use. Symlink refusal, canonical
 * containment, exclusive temp creation and the pre-rename recheck all live
 * there, so there is exactly one implementation of "may this land here".
 */
import { createHash } from "node:crypto";
import { chmod } from "node:fs/promises";
import { describeRejection } from "./paths.js";
import { hashLocalFile, type PlanEntry, type SyncPlan } from "./plan.js";
import {
	assertWritableTarget,
	deleteFileSafely,
	isAllowedMode,
	permissionBits,
	writeFileSafely,
} from "./safe-write.js";

export interface ApplyResult {
	written: string[];
	deleted: string[];
	/** Paths whose mode was corrected without rewriting their bytes. */
	remoded: string[];
	/**
	 * Paths the plan meant to delete that no longer matched the hash it
	 * decided on — someone edited them between planning and now, so they were
	 * left where they are.
	 */
	keptModified: string[];
	/**
	 * Planned writes left alone because the file changed after planning: an
	 * editor saved over a file the plan meant to update, or created one where
	 * it meant to add (Decision 37). Only when `keepLocalEdits` is set.
	 */
	keptEdited: string[];
}

export interface ApplyInput {
	/** An already-canonical destination from `resolveDestinationRoot`. */
	root: string;
	plan: SyncPlan;
	/** Extracted archive entries, keyed by the manifest path. */
	contents: Map<string, Uint8Array>;
	/**
	 * Re-hash each write's target just before writing it, and leave it alone
	 * when it no longer holds what the plan saw (`PlanEntry.localSha256`).
	 * The CLI sets it unless `sync --repair` was given (spec §6.4).
	 */
	keepLocalEdits?: boolean;
}

export async function applyPlan(input: ApplyInput): Promise<ApplyResult> {
	const { root, plan, contents } = input;

	// ---- Phase 1: prove the whole plan before touching the tree ----------
	//
	// EVERY path the plan names, including the ones it does not intend to
	// write. A `verified` entry is one whose local bytes already match, and a
	// symlink pointing at those bytes used to reach exactly that verdict: no
	// write, no check, and a lock written over a path that is not a file.
	// This runs before the platform and mode short-circuits further down for
	// the same reason — a check that only some plans reach is not a check.
	for (const entry of [
		...plan.writes,
		...plan.verified,
		...plan.deletes,
		...plan.keptRenamed,
		// Never written, but the lock is about to record it as a synced
		// file, so it has to be one.
		...plan.keptEdited,
	]) {
		const check = await assertWritableTarget(root, entry.path);
		if (!check.ok) {
			throw new Error(
				`Refusing to sync: ${describeRejection(check)}. Nothing was written.`,
			);
		}
	}

	for (const entry of plan.writes) {
		if (!isAllowedMode(entry.mode)) {
			throw new Error(
				`Refusing to sync: ${entry.path} asks for file mode ${(entry.mode ?? 0).toString(8)}, and only 644 and 755 are accepted. Nothing was written.`,
			);
		}
		const bytes = contents.get(entry.path);
		if (!bytes) {
			throw new Error(
				`The downloaded bundle is missing ${entry.path}. Nothing was written.`,
			);
		}
		const actual = createHash("sha256").update(bytes).digest("hex");
		if (actual !== entry.sha256) {
			throw new Error(
				`Checksum mismatch for ${entry.path}: the published snapshot expects ${entry.sha256} and the downloaded bundle contains ${actual}. Nothing was written.`,
			);
		}
	}

	// ---- Phase 2: apply --------------------------------------------------
	const written: string[] = [];
	const deleted: string[] = [];
	const remoded: string[] = [];
	const keptModified: string[] = [];
	const keptEdited: string[] = [];

	for (const entry of plan.writes) {
		// Planning ran before the download and the extraction, and an editor
		// saving in that window must not lose the save: the same window the
		// expected hash on each delete below closes (Decision 37). What is
		// left is the moment between this read and the rename, which no
		// portable file API closes.
		//
		// A re-hash of `null` — the target vanished after planning — proceeds
		// with the write rather than counting as kept: planning would have
		// called that same absence `added`, not a conflicting edit, so this
		// keeps apply time agreeing with plan time (review finding, Fizzy
		// #2540).
		if (input.keepLocalEdits && entry.localSha256 !== undefined) {
			const currentLocalHash = await hashLocalFile(root, entry.path);
			if (
				currentLocalHash !== null &&
				currentLocalHash !== entry.localSha256
			) {
				keptEdited.push(entry.path);
				continue;
			}
		}
		// Non-null: phase 1 refused the whole plan if any byte was missing.
		const bytes = contents.get(entry.path) as Uint8Array;
		await writeFileSafely({
			root,
			relativePath: entry.path,
			bytes,
			mode: entry.mode ?? null,
		});
		written.push(entry.path);
	}

	// A file whose bytes already match still has to carry the published
	// mode: a script that arrives non-executable is as broken as one that
	// arrives with the wrong contents, and `verified` would otherwise never
	// fix it.
	for (const entry of plan.verified) {
		if (await applyMode(root, entry)) {
			remoded.push(entry.path);
		}
	}

	for (const entry of plan.deletes) {
		// The hash the plan decided on travels with the unlink. Planning ran
		// before the download, the extraction and every write above, and an
		// editor saving in that window would otherwise have its work deleted
		// on the strength of a hash that no longer describes the file.
		if (entry.sha256 === undefined) {
			throw new Error(
				`Refusing to delete ${entry.path}: the plan carries no hash for it.`,
			);
		}
		const outcome = await deleteFileSafely(root, entry.path, entry.sha256);
		if (outcome === "deleted") {
			deleted.push(entry.path);
		} else if (outcome === "modified") {
			keptModified.push(entry.path);
		}
	}
	// Directories are deliberately left behind. An empty directory is
	// harmless; removing one races with anything the developer put in it.

	return { written, deleted, remoded, keptModified, keptEdited };
}

/** Returns true when a mode was actually applied. */
async function applyMode(root: string, entry: PlanEntry): Promise<boolean> {
	const bits = permissionBits(entry.mode);
	if (bits === null || process.platform === "win32") {
		return false;
	}
	if (!isAllowedMode(entry.mode)) {
		throw new Error(
			`Refusing to sync: ${entry.path} asks for file mode ${(entry.mode ?? 0).toString(8)}, and only 644 and 755 are accepted.`,
		);
	}
	// The same guard the writes use: a `chmod` is a mutation too, and phase 1
	// proving this path was a regular file does not make it one now.
	const check = await assertWritableTarget(root, entry.path);
	if (!check.ok) {
		throw new Error(`Refusing to sync: ${describeRejection(check)}.`);
	}
	try {
		await chmod(check.path, bits);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}
