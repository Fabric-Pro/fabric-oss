/**
 * Proposal commits. The effective delta and the tree-conflict check (Fizzy
 * #2563 spec §7 steps 2 to 4) decide whether a proposal's rows apply to a
 * repository tree at all; a member proposal branch append (Fizzy #2738) runs
 * both before it writes. `buildBranchCommit` builds and verifies the branch's
 * commit. #2563's own per-proposal commit builder was retired with that path
 * (Fizzy #2748).
 *
 * Nothing here touches the network or pushes.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import path from "node:path";
import {
	collisionKey,
	type TreeEntry,
	validateRelativePath,
} from "@repo/instructions";
import {
	commitTree,
	type DiffTreeEntry,
	diffTreeEntries,
	type RawTreeEntry,
	readBaseTree,
	writeResolvedTree,
} from "./instruction-sync-git";

/** The file-row fields the delta needs; `path` is relative to the root. */
export type FileRow = {
	path: string;
	sha256: string;
	mode: number | null;
	storageKey: string;
};

export type EffectiveDelta = {
	/** Proposal rows with no base row on their key. */
	added: FileRow[];
	/** Proposal rows whose base row on the same key has another sha256. */
	modified: FileRow[];
	/** Base rows with no proposal row on their key. */
	deleted: FileRow[];
};

/**
 * The one key a Fabric path and a repository path share: the path as
 * `validateRelativePath` normalises it (separators, `./`, duplicate slashes),
 * then NFC. A repository that stores `café.md` decomposed (NFD) and a
 * proposal row that stores it composed (NFC) are one file under this key
 * (Review Focus 1), so a modification changes the repository's own entry
 * instead of adding a second spelling. Null when the path is not one Fabric
 * could store at all.
 */
function pathKey(relative: string): string | null {
	const v = validateRelativePath(relative);
	return v.ok ? v.path.normalize("NFC") : null;
}

const rowKey = (row: FileRow): string =>
	pathKey(row.path) ?? row.path.normalize("NFC");

/**
 * Spec §7 step 3: added, modified and deleted, on path (by `pathKey`) and
 * sha256, computed once from the base snapshot's rows and the proposal's.
 * A mode-only difference is not a change: changed rows omit `mode` today.
 */
export function computeEffectiveDelta(
	base: readonly FileRow[],
	proposal: readonly FileRow[],
): EffectiveDelta {
	const baseByKey = new Map(base.map((row) => [rowKey(row), row]));
	const proposalKeys = new Set(proposal.map(rowKey));
	const added: FileRow[] = [];
	const modified: FileRow[] = [];
	for (const row of proposal) {
		const before = baseByKey.get(rowKey(row));
		if (!before) {
			added.push(row);
		} else if (before.sha256 !== row.sha256) {
			modified.push(row);
		}
	}
	const deleted = base.filter((row) => !proposalKeys.has(rowKey(row)));
	return { added, modified, deleted };
}

type MappedEntry = {
	entry: RawTreeEntry;
	/** Path relative to the root; null for a non-UTF-8 name. */
	rel: string | null;
	key: string | null;
};

type TreePlan =
	| {
			ok: true;
			/** Repository path, mode and source row of every write, in delta order. */
			writes: Array<{
				repoPath: string;
				mode: "100644" | "100755";
				row: FileRow;
			}>;
			deletes: Array<{ repoPath: string; mode: string }>;
			modifiedModes: Map<string, string>;
	  }
	| { ok: false };

function relativeTo(rootPath: string, repoPath: string): string | null {
	if (rootPath === "") {
		return repoPath;
	}
	if (repoPath === rootPath) {
		return "";
	}
	return repoPath.startsWith(`${rootPath}/`)
		? repoPath.slice(rootPath.length + 1)
		: null;
}

const isRegularBlob = (entry: RawTreeEntry): boolean =>
	entry.type === "blob" &&
	(entry.mode === "100644" || entry.mode === "100755");

/** A new path is `100755` only when its row explicitly recorded 0755 (spec §7 step 3). */
function addedMode(row: FileRow): "100644" | "100755" {
	return row.mode != null && (row.mode & 0o7777) === 0o755
		? "100755"
		: "100644";
}

/**
 * Spec §7 steps 2 and 4. Every raw entry under the root, symlinks and
 * gitlinks included, is mapped to its `pathKey`; two on one key, or the root
 * itself being an entry, is a conflict. A modified or deleted row must map to
 * a regular blob. An added row must not equal, sit under, contain, or share a
 * `collisionKey` with any entry that remains in the new tree (an entry the
 * delta deletes does not remain, so a case-only rename is not a conflict).
 */
function planTree(
	entries: readonly RawTreeEntry[],
	delta: EffectiveDelta,
	rootPath: string,
): TreePlan {
	const mapped: MappedEntry[] = [];
	const byKey = new Map<string, MappedEntry>();
	for (const entry of entries) {
		if (entry.path === null) {
			// A non-UTF-8 name: no Fabric path equals it, sits under it or
			// contains it (a segment-aligned prefix of valid UTF-8 is valid
			// UTF-8), so it only has to survive, which the base tree ensures.
			mapped.push({ entry, rel: null, key: null });
			continue;
		}
		const rel = relativeTo(rootPath, entry.path);
		if (rel === null) {
			continue;
		}
		if (rel === "") {
			// The root itself is a file or a gitlink: nothing can go under it.
			return { ok: false };
		}
		const key = pathKey(rel);
		const item: MappedEntry = { entry, rel, key };
		if (key !== null) {
			if (byKey.has(key)) {
				return { ok: false };
			}
			byKey.set(key, item);
		}
		mapped.push(item);
	}

	const deletes: Array<{ repoPath: string; mode: string }> = [];
	const deletedEntries = new Set<RawTreeEntry>();
	for (const row of delta.deleted) {
		const target = byKey.get(rowKey(row));
		if (!target || !isRegularBlob(target.entry)) {
			return { ok: false };
		}
		deletedEntries.add(target.entry);
		deletes.push({
			repoPath: target.entry.path as string,
			mode: target.entry.mode,
		});
	}

	const writes: Array<{
		repoPath: string;
		mode: "100644" | "100755";
		row: FileRow;
	}> = [];
	const modifiedModes = new Map<string, string>();
	for (const row of delta.modified) {
		const target = byKey.get(rowKey(row));
		if (!target || !isRegularBlob(target.entry)) {
			return { ok: false };
		}
		const repoPath = target.entry.path as string;
		const mode = target.entry.mode as "100644" | "100755";
		modifiedModes.set(repoPath, mode);
		writes.push({ repoPath, mode, row });
	}

	const fileKeys = new Set<string>();
	const directoryKeys = new Set<string>();
	for (const item of mapped) {
		if (item.rel === null || deletedEntries.has(item.entry)) {
			continue;
		}
		const key = collisionKey(item.key ?? item.rel);
		fileKeys.add(key);
		const segments = key.split("/");
		for (let i = 1; i < segments.length; i++) {
			directoryKeys.add(segments.slice(0, i).join("/"));
		}
	}
	for (const row of delta.added) {
		const key = pathKey(row.path);
		if (key === null) {
			return { ok: false };
		}
		const added = collisionKey(key);
		if (fileKeys.has(added) || directoryKeys.has(added)) {
			return { ok: false };
		}
		const segments = added.split("/");
		for (let i = 1; i < segments.length; i++) {
			if (fileKeys.has(segments.slice(0, i).join("/"))) {
				return { ok: false };
			}
		}
		writes.push({
			repoPath: rootPath === "" ? row.path : `${rootPath}/${row.path}`,
			mode: addedMode(row),
			row,
		});
	}
	return { ok: true, writes, deletes, modifiedModes };
}

/** True when the delta cannot be applied to this tree without touching an entry Fabric does not manage. */
export function findTreeConflicts(
	entries: readonly RawTreeEntry[],
	delta: EffectiveDelta,
	rootPath: string,
): boolean {
	return !planTree(entries, delta, rootPath).ok;
}

/**
 * One path a member proposal branch append or revert changes (member
 * proposal branch spec §6.4 step 6, §6.8 step 3): `rawPath` is the
 * repository path, and `after` is the exact tree entry to write there, or
 * `null` to delete it. Unlike an `EffectiveDelta` row, every
 * entry's object id is already known — a new blob an append already hashed,
 * or an existing repository blob a revert is restoring — so nothing here is
 * re-hashed from storage.
 */
export type BranchWritePlanEntry = { rawPath: string; after: TreeEntry | null };

export type BranchCommitResult =
	| { ok: true; sha: string }
	| { ok: false; code: "GIT_FAILED" };

/**
 * Member proposal branch spec §6.4 steps 6-7 (append) and §6.8 step 3
 * (revert): build one commit on an explicit `parent` (the branch's fetched
 * tip, or the branch's base commit on its first push) from a write plan of
 * already-resolved entries, then verify the built commit's diff from
 * `parent` is exactly the plan: an unverified commit is never pushed.
 */
export async function buildBranchCommit(input: {
	dir: string;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	parent: string;
	plan: readonly BranchWritePlanEntry[];
	author: { name: string; email: string };
	committer: { name: string; email: string };
	message: string;
	date: string;
}): Promise<BranchCommitResult> {
	const { dir, env, signal, parent, plan } = input;
	const indexFile = path.join(dir, ".git", "fabric-branch-index");
	await readBaseTree({ dir, sha: parent, indexFile, env, signal });
	const tree = await writeResolvedTree({
		dir,
		indexFile,
		entries: plan,
		env,
		signal,
	});
	const sha = await commitTree({
		dir,
		tree,
		parent,
		author: input.author,
		committer: input.committer,
		message: input.message,
		date: input.date,
		env,
		signal,
	});
	const actual = await diffTreeEntries({
		dir,
		from: parent,
		to: sha,
		env,
		signal,
	});
	if (!matchesBranchWritePlan(actual, plan)) {
		return { ok: false, code: "GIT_FAILED" };
	}
	return { ok: true, sha };
}

const DELETED_MODE = "000000";

/**
 * Whether `actual` (the built commit's diff from `parent`) is exactly `plan`:
 * the same path set, each written path at its plan entry's mode and object
 * id, each deleted path reported as a deletion. `plan` carries no `before`,
 * so this checks the resulting state rather than a full status/oldMode
 * equality; the path-set-size check below rules out an actual entry the plan
 * does not account for.
 */
function matchesBranchWritePlan(
	actual: readonly DiffTreeEntry[],
	plan: readonly BranchWritePlanEntry[],
): boolean {
	if (actual.length !== plan.length) {
		return false;
	}
	const byPath = new Map(actual.map((entry) => [entry.path, entry]));
	return plan.every((entry) => {
		const found = byPath.get(entry.rawPath);
		if (!found) {
			return false;
		}
		if (entry.after === null) {
			return found.status === "D" && found.newMode === DELETED_MODE;
		}
		return (
			found.status !== "D" &&
			found.newMode === entry.after.mode &&
			found.newOid === entry.after.oid
		);
	});
}
