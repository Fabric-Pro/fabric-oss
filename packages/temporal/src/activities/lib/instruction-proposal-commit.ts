/**
 * The proposal commit (Fizzy #2563 spec §7 steps 2 to 8): the full base tree
 * at `baseCommitSha` plus one normalised effective delta under `rootPath`,
 * committed with the frozen context's metadata, so every build of one
 * proposal produces the same SHA.
 *
 * Step 1 (clone, pinned fetch, credentials) and step 9 (store, recheck,
 * push) belong to the open activity; this module never touches the network
 * and never pushes.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
	collisionKey,
	type PullRequestContext,
	validateRelativePath,
} from "@repo/instructions";
import {
	commitTree,
	type DiffTreeEntry,
	diffTreeEntries,
	type RawTreeEntry,
	readBaseTree,
	type TreeDeltaEntry,
	writeProposalTree,
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

const sha256Hex = (bytes: Buffer): string =>
	createHash("sha256").update(bytes).digest("hex");

const byPath = (a: DiffTreeEntry, b: DiffTreeEntry): number =>
	a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function sameEntries(
	actual: readonly DiffTreeEntry[],
	expected: readonly DiffTreeEntry[],
): boolean {
	if (actual.length !== expected.length) {
		return false;
	}
	const a = [...actual].sort(byPath);
	const e = [...expected].sort(byPath);
	return a.every(
		(entry, i) =>
			entry.status === e[i]?.status &&
			entry.path === e[i]?.path &&
			entry.oldMode === e[i]?.oldMode &&
			entry.newMode === e[i]?.newMode &&
			entry.newOid === e[i]?.newOid,
	);
}

export type ProposalCommitResult =
	| { ok: true; sha: string }
	| { ok: false; code: "TREE_CONFLICT" | "STORAGE_FAILED" | "GIT_FAILED" };

/**
 * Spec §7 steps 2 to 8, in order. `entries` is `listTreeRaw` of the base
 * commit under `context.rootPath`, `dir` the clone at `context.baseCommitSha`.
 * `GIT_FAILED` here is the verifier's verdict (a commit that is not exactly
 * the delta), which is never retryable; a git command that fails throws
 * `GitCommandError` for the caller to classify. A storage read that fails
 * (other than by cancellation) or a re-hash mismatch is `STORAGE_FAILED`.
 */
export async function buildProposalCommit(input: {
	dir: string;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	context: PullRequestContext;
	delta: EffectiveDelta;
	entries: readonly RawTreeEntry[];
	readBytes(key: string): Promise<Buffer>;
}): Promise<ProposalCommitResult> {
	const { context, signal, env, dir } = input;
	const plan = planTree(input.entries, input.delta, context.rootPath);
	if (!plan.ok) {
		return { ok: false, code: "TREE_CONFLICT" };
	}

	// Step 5: the promoted bytes, re-hashed. The snapshot's sha256 is never
	// used as a git blob id; `hash-object` computes that below.
	const bytes = new Map<FileRow, Buffer>();
	for (const write of plan.writes) {
		let data: Buffer;
		try {
			data = await input.readBytes(write.row.storageKey);
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}
			return { ok: false, code: "STORAGE_FAILED" };
		}
		if (sha256Hex(data) !== write.row.sha256) {
			return { ok: false, code: "STORAGE_FAILED" };
		}
		bytes.set(write.row, data);
	}

	// Step 6: base tree into a private index, then the delta.
	const indexFile = path.join(dir, ".git", "fabric-proposal-index");
	await readBaseTree({
		dir,
		sha: context.baseCommitSha,
		indexFile,
		env,
		signal,
	});
	const delta: TreeDeltaEntry[] = [
		...plan.writes.map((w) => ({
			path: w.repoPath,
			mode: w.mode,
			bytes: bytes.get(w.row) as Buffer,
		})),
		...plan.deletes.map((d) => ({
			path: d.repoPath,
			delete: true as const,
		})),
	];
	const { tree, blobIds } = await writeProposalTree({
		dir,
		indexFile,
		delta,
		env,
		signal,
	});

	// Step 7: frozen metadata only.
	const sha = await commitTree({
		dir,
		tree,
		parent: context.baseCommitSha,
		author: context.author,
		committer: context.committer,
		message: context.message,
		date: context.committedAt,
		env,
		signal,
	});

	// Step 8: the commit must be exactly the delta (status, raw path, mode,
	// blob id), every path under the root; anything else is never pushed.
	const zero = "0".repeat(context.baseCommitSha.length);
	const expected: DiffTreeEntry[] = [
		...plan.writes.map((w) => {
			const oldMode = plan.modifiedModes.get(w.repoPath);
			return {
				status: oldMode === undefined ? ("A" as const) : ("M" as const),
				path: w.repoPath,
				oldMode: oldMode ?? "000000",
				newMode: w.mode,
				newOid: blobIds.get(w.repoPath) as string,
			};
		}),
		...plan.deletes.map((d) => ({
			status: "D" as const,
			path: d.repoPath,
			oldMode: d.mode,
			newMode: "000000",
			newOid: zero,
		})),
	];
	const actual = await diffTreeEntries({
		dir,
		from: context.baseCommitSha,
		to: sha,
		env,
		signal,
	});
	if (!sameEntries(actual, expected)) {
		return { ok: false, code: "GIT_FAILED" };
	}
	return { ok: true, sha };
}
