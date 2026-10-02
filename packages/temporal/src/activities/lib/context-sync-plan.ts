/**
 * What a Living Memory sync run plans from its inventory (design 2026-09-23
 * §4.3, §5.3.1 steps 4–7, Fizzy #2657): which selected paths are present,
 * each selected folder's ignore policy, each entry's identity and verdict,
 * the member's left-out paths (Fizzy #2750 §5.5), and the plan receipt the
 * run writes once. Pure: no I/O, no clock. The activity reads the ignore
 * files and the file bytes; everything decided about them is decided here.
 *
 * Not re-exported from the activities barrel.
 */
import type {
	ContextSyncAttentionReason,
	ContextSyncPlan,
} from "@repo/database";
import type { ContextInventoryEntry } from "./context-sync-inventory";
import {
	buildContextIgnoreRules,
	CONTEXT_IGNORE_FILENAME,
	type ContextIgnoreRules,
	contextStorageKey,
	hasTextExtension,
	isAtOrUnderLeftOutKey,
	isExcludedDirectlySelectedFile,
	isInFabricDirectory,
	isRegularFileMode,
	isUnderProtectedPrefix,
	matchContextEntry,
	protectedPrefixFor,
	relativeToSelectedFolder,
} from "./context-sync-rules";

/**
 * Kept files one run may apply (§8): the apply ledger's bound,
 * `CONTEXT_SYNC_MAX_OUTCOMES` in `@repo/database`. A literal rather than
 * that import, so loading this module reads nothing from the database
 * package (the activities barrel loads it into every worker test).
 */
export const MAX_CONTEXT_SYNC_KEPT = 5_000;
/** Bytes one run may read and store (§5.3.1 step 7, §8). */
export const MAX_CONTEXT_SYNC_TOTAL_BYTES = 50 * 1024 * 1024;
/** The plan receipt's attention list (§4.3): at most 100 items … */
const PLAN_ATTENTION_ITEMS = 100;
/** … each key at most 200 characters. `attentionCount` is the full count. */
const PLAN_ATTENTION_KEY_CHARS = 200;

export type AttentionItem = { key: string; reason: ContextSyncAttentionReason };

/** How a selected path appears in the pinned commit. */
export type SelectedPathShape =
	/** Entries under `path/`, or the whole repository with any entry. */
	| { path: string; kind: "folder" }
	/** An entry AT `path`, whatever its mode: present, even when unsupported. */
	| { path: string; kind: "file"; entry: ContextInventoryEntry }
	/** Nothing at or under it (§5.3.1 step 4: `path-missing`). */
	| { path: string; kind: "missing" };

/**
 * The selected path an entry belongs to, if any. Selected paths are
 * canonical and none is a prefix of another (`configure`), so at most one
 * matches; whole segments only, so `docs` never owns `docs-archive/a.md`.
 */
function ownerOf(
	paths: readonly string[],
	entryPath: string,
): { path: string; asFile: boolean } | null {
	for (const selected of paths) {
		if (selected === "") {
			return { path: selected, asFile: false };
		}
		if (entryPath === selected) {
			return { path: selected, asFile: true };
		}
		if (entryPath.startsWith(`${selected}/`)) {
			return { path: selected, asFile: false };
		}
	}
	return null;
}

/**
 * Present vs missing per selected path (§5.3.1 step 4): present means ANY
 * entry at or under it, of any mode — a selected file that is now a symlink
 * is present and excluded, never "missing".
 */
export function selectedPathShapes(
	paths: readonly string[],
	entries: readonly ContextInventoryEntry[],
): SelectedPathShape[] {
	const files = new Map<string, ContextInventoryEntry>();
	const folders = new Set<string>();
	for (const entry of entries) {
		const owner = ownerOf(paths, entry.path);
		if (!owner) {
			continue;
		}
		if (owner.asFile) {
			files.set(owner.path, entry);
		} else {
			folders.add(owner.path);
		}
	}
	return paths.map((path): SelectedPathShape => {
		if (folders.has(path)) {
			return { path, kind: "folder" };
		}
		const entry = files.get(path);
		return entry
			? { path, kind: "file", entry }
			: { path, kind: "missing" };
	});
}

/** The repository path of a selected folder's own ignore file. */
export function contextIgnorePathFor(folder: string): string {
	return folder === ""
		? CONTEXT_IGNORE_FILENAME
		: `${folder}/${CONTEXT_IGNORE_FILENAME}`;
}

/** A selected folder's ignore policy, as the activity found it. */
export type ContextIgnorePolicy =
	/** No `.contextignore`: the default exclusions alone. */
	| { kind: "defaults" }
	| { kind: "file"; text: string }
	/**
	 * A symlink, a submodule, a file over 64 KiB or one that is not UTF-8
	 * text: the policy cannot be evaluated, so the folder is protected.
	 */
	| { kind: "unreadable" };

/** The policy of an ignore-file entry that is not a regular file. */
export function ignorePolicyForEntry(
	entry: ContextInventoryEntry | undefined,
): ContextIgnorePolicy | "read" {
	if (!entry) {
		return { kind: "defaults" };
	}
	return entry.type === "blob" && isRegularFileMode(entry.mode)
		? "read"
		: { kind: "unreadable" };
}

/** The policy of an ignore file's bytes; `null` is "over the 64 KiB cap". */
export function ignorePolicyFromBytes(
	bytes: Uint8Array | null,
): ContextIgnorePolicy {
	if (bytes === null) {
		return { kind: "unreadable" };
	}
	try {
		return {
			kind: "file",
			text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		};
	} catch {
		return { kind: "unreadable" };
	}
}

/** An entry the rules keep: to be checked out, measured and classified. */
export type ContextSyncCandidate = {
	key: string;
	repoPath: string;
};

export type ContextTreePlan = {
	/** Sorted by key. */
	candidates: ContextSyncCandidate[];
	/** Every planning-time attention item, in discovery order (never capped). */
	attention: AttentionItem[];
	/** Storage keys of attention items that have one: never written, never pruned. */
	protectedKeys: Set<string>;
	protectedPrefixes: string[];
	missingPaths: string[];
	excludedCount: number;
	/**
	 * The member's left-out paths that apply: those inside a selected path
	 * present as a folder, sorted. One under a selected FILE is dormant.
	 */
	excludedKeys: string[];
};

/**
 * The left-out paths that apply to this inventory (Fizzy #2750 §5.5): each
 * strictly inside a selected path present as a FOLDER. One under a selected
 * path that is a file never leaves the file out or changes its shape, and
 * one under a missing path has nothing to leave out; neither is frozen.
 * Left-out paths are canonical, so each is its own storage key.
 */
function effectiveLeftOutKeys(
	excludedPaths: readonly string[],
	shapes: readonly SelectedPathShape[],
): string[] {
	const folders = shapes
		.filter((shape) => shape.kind === "folder")
		.map((shape) => shape.path);
	const keys = excludedPaths.filter((excluded) =>
		folders.some((folder) =>
			folder === "" ? excluded !== "" : excluded.startsWith(`${folder}/`),
		),
	);
	return [...new Set(keys)].sort(compareKeys);
}

/**
 * §5.3.1 steps 5–6 over the inventory. Per entry, in the CLI's order
 * (`packages/cli/src/lib/context-sync/plan.ts`): the folder's rules (a path
 * they cannot evaluate is `invalid-path`, an ignored one `excluded`), then
 * the mode (anything but a regular file is `excluded`), then the identity
 * (a backslash or a refused key is `invalid-path`), then the extension
 * (`excluded`). A directly selected file is judged by its basename against
 * the default exclusions instead of a folder's rules. Any entry with a
 * `.fabric` segment in its repository path is `excluded`, whether selected
 * directly or through a folder (Fizzy #2704). A folder whose policy is
 * unreadable contributes nothing but its protected prefix and one attention
 * item.
 *
 * Collisions come first (Fizzy #2750 §5.5): every owned entry with a
 * storage key is counted BEFORE any of the filters above, an unreadable
 * policy or a left-out path removes one. Entries whose keys collide byte for
 * byte are all `invalid-path` and their key is protected, whatever each
 * would otherwise have been — a symlink, an ignored or non-text twin still
 * shares the key, so the prune must never delete the row either could
 * claim. Without left-out paths the only change this makes to a plan is
 * that collision's own attention and protection (a protected key is never
 * written, so neither twin is a candidate).
 *
 * The member's left-out paths apply to entries inside a selected folder, by
 * storage key (NFC, whole segments), never raw bytes: an entry whose key is
 * at or under one is `excluded`, never a candidate — even under a folder
 * whose policy is unreadable — unless its key collides (above). Presence
 * (`shapes`) is computed on the unfiltered inventory, so a folder whose
 * contents are all left out is still present.
 */
export function planContextTree(input: {
	paths: readonly string[];
	/** Canonical; absent or `[]` leaves nothing out. */
	excludedPaths?: readonly string[];
	entries: readonly ContextInventoryEntry[];
	shapes: readonly SelectedPathShape[];
	policies: ReadonlyMap<string, ContextIgnorePolicy>;
}): ContextTreePlan {
	const attention: AttentionItem[] = [];
	const protectedKeys = new Set<string>();
	const protectedPrefixes: string[] = [];
	const missingPaths: string[] = [];
	let excludedCount = 0;
	const excludedKeys = effectiveLeftOutKeys(
		input.excludedPaths ?? [],
		input.shapes,
	);

	const rulesByFolder = new Map<string, ContextIgnoreRules | null>();
	for (const shape of input.shapes) {
		if (shape.kind === "missing") {
			missingPaths.push(shape.path);
			attention.push({ key: shape.path, reason: "path-missing" });
			continue;
		}
		if (shape.kind !== "folder") {
			continue;
		}
		const policy = input.policies.get(shape.path) ?? { kind: "unreadable" };
		if (policy.kind === "unreadable") {
			rulesByFolder.set(shape.path, null);
			protectedPrefixes.push(protectedPrefixFor(shape.path));
			attention.push({
				key: shape.path,
				reason: "ignore-policy-unreadable",
			});
			continue;
		}
		rulesByFolder.set(
			shape.path,
			buildContextIgnoreRules({
				contextIgnore: policy.kind === "file" ? policy.text : null,
			}),
		);
	}

	/** An entry's storage key, or `null` when it has none. */
	const keyOf = (entry: ContextInventoryEntry): string | null => {
		if (!entry.utf8) {
			return null;
		}
		const key = contextStorageKey(entry.path);
		return key.ok ? key.storageKey : null;
	};

	/** An attention item for an entry, protecting its key when it has one. */
	const needsAttention = (
		entry: ContextInventoryEntry,
		key: string | null,
		reason: ContextSyncAttentionReason,
	) => {
		attention.push({ key: entry.path, reason });
		if (key !== null) {
			protectedKeys.add(key);
		}
	};

	// Byte-identical keys, no case folding, over EVERY owned entry with a
	// key (§5.5): before `.fabric`, the folder's rules, the mode, the
	// extension, an unreadable policy or a left-out path drops one. Every
	// entry on a shared key is `invalid-path` and the key is protected, so
	// the prune never deletes a row two repository paths could claim —
	// whatever became of the twin.
	const owned: Array<{
		entry: ContextInventoryEntry;
		owner: { path: string; asFile: boolean };
		key: string | null;
	}> = [];
	const keyCounts = new Map<string, number>();
	for (const entry of input.entries) {
		const owner = ownerOf(input.paths, entry.path);
		if (!owner) {
			continue;
		}
		const key = keyOf(entry);
		owned.push({ entry, owner, key });
		if (key !== null) {
			keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
		}
	}
	const isCollided = (key: string | null): boolean =>
		key !== null && (keyCounts.get(key) ?? 0) > 1;
	for (const { entry, key } of owned) {
		if (isCollided(key)) {
			needsAttention(entry, key, "invalid-path");
		}
	}

	const candidates: ContextSyncCandidate[] = [];
	for (const { entry, owner, key } of owned) {
		if (isCollided(key)) {
			continue;
		}
		if (owner.asFile) {
			// A left-out path under a selected FILE is dormant:
			// `excludedKeys` holds none, and the file is judged as ever.
			if (isExcludedDirectlySelectedFile(entry.path)) {
				excludedCount++;
				continue;
			}
		} else {
			// Left out by the member, by storage key: excluded, even under a
			// folder whose policy is unreadable.
			if (key !== null && isAtOrUnderLeftOutKey(key, excludedKeys)) {
				excludedCount++;
				continue;
			}
			const rules = rulesByFolder.get(owner.path);
			if (!rules) {
				// Under a protected prefix: neither written nor excluded.
				continue;
			}
			// A selected folder that is, or is inside, `.fabric`: the
			// folder's rules match relative to it and cannot see that
			// segment, so a stored selection fails closed here.
			if (isInFabricDirectory(entry.path)) {
				excludedCount++;
				continue;
			}
			const relative = relativeToSelectedFolder(owner.path, entry.path);
			const match =
				relative === null
					? "unmatchable"
					: matchContextEntry(rules, relative, entry.mode);
			if (match === "unmatchable") {
				needsAttention(entry, key, "invalid-path");
				continue;
			}
			if (match !== "kept") {
				excludedCount++;
				continue;
			}
		}
		if (entry.type !== "blob" || !isRegularFileMode(entry.mode)) {
			excludedCount++;
			continue;
		}
		if (key === null) {
			attention.push({ key: entry.path, reason: "invalid-path" });
			continue;
		}
		if (!hasTextExtension(entry.path)) {
			excludedCount++;
			continue;
		}
		candidates.push({ key, repoPath: entry.path });
	}
	candidates.sort((a, b) => compareKeys(a.key, b.key));

	return {
		candidates,
		attention,
		protectedKeys,
		protectedPrefixes,
		missingPaths,
		excludedCount,
		excludedKeys,
	};
}

/** Code-unit order, the order `Array.prototype.sort` would give strings. */
function compareKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The plan receipt (§4.3): the full attention count, the first 100 items
 * with keys cut to 200 characters, and the kept and protected key sets that
 * are the run's frozen membership and its prune exclusions, beside the
 * member's left-out keys (Fizzy #2750 §5.5), which a retry prunes by
 * without re-reading the selection.
 */
export function buildContextSyncPlan(input: {
	keptKeys: readonly string[];
	excludedCount: number;
	attention: readonly AttentionItem[];
	protectedKeys: ReadonlySet<string>;
	protectedPrefixes: readonly string[];
	missingPaths: readonly string[];
	excludedKeys?: readonly string[];
}): ContextSyncPlan {
	const keptKeys = [...input.keptKeys].sort(compareKeys);
	return {
		keptCount: keptKeys.length,
		excludedCount: input.excludedCount,
		attentionCount: input.attention.length,
		attention: input.attention
			.slice(0, PLAN_ATTENTION_ITEMS)
			.map(({ key, reason }) => ({
				key: key.slice(0, PLAN_ATTENTION_KEY_CHARS),
				reason,
			})),
		protectedPrefixes: [...input.protectedPrefixes],
		missingPaths: [...input.missingPaths],
		keptKeys,
		protectedKeys: [...input.protectedKeys].sort(compareKeys),
		excludedKeys: [...(input.excludedKeys ?? [])].sort(compareKeys),
	};
}

/**
 * Whether a managed row's key may be pruned under this plan (§5.3.1 step 8):
 * never when planned or protected by key (an attention item, a collision);
 * always when at or under one of the member's left-out keys, even under a
 * protected prefix and whether or not the inventory still has it (Fizzy
 * #2750 §5.5); otherwise only when not under a protected prefix. A plan
 * written before left-out keys existed has none.
 */
export function createPruneEligibility(
	plan: ContextSyncPlan,
): (key: string) => boolean {
	const kept = new Set(plan.keptKeys);
	const protectedKeys = new Set(plan.protectedKeys);
	const leftOut = plan.excludedKeys ?? [];
	return (key) => {
		if (kept.has(key) || protectedKeys.has(key)) {
			return false;
		}
		return (
			isAtOrUnderLeftOutKey(key, leftOut) ||
			!isUnderProtectedPrefix(key, plan.protectedPrefixes)
		);
	};
}

/**
 * A retry's content source (§4.3): each planned key's repository path in the
 * pinned commit's inventory, or `null` when one of them is not there exactly
 * once as a regular file — the pinned commit no longer reproduces the plan,
 * which the run reports as `CLONE_FAILED`.
 */
export function repositoryPathsForKeys(
	keys: readonly string[],
	entries: readonly ContextInventoryEntry[],
): Map<string, string> | null {
	const wanted = new Set(keys);
	const found = new Map<string, string | null>();
	for (const entry of entries) {
		if (
			!entry.utf8 ||
			entry.type !== "blob" ||
			!isRegularFileMode(entry.mode)
		) {
			continue;
		}
		const key = contextStorageKey(entry.path);
		if (!key.ok || !wanted.has(key.storageKey)) {
			continue;
		}
		found.set(
			key.storageKey,
			found.has(key.storageKey) ? null : entry.path,
		);
	}
	const paths = new Map<string, string>();
	for (const key of keys) {
		const repoPath = found.get(key);
		if (!repoPath) {
			return null;
		}
		paths.set(key, repoPath);
	}
	return paths;
}

/**
 * The git blob id the pinned commit holds for each of `keys`: only a key that
 * is there exactly once as a regular file has one, so an ambiguous or absent
 * key is simply missing and is read the ordinary way. The inventory already
 * carries every entry's blob id, so asking costs nothing.
 */
export function blobOidsForKeys(
	keys: readonly string[],
	entries: readonly ContextInventoryEntry[],
): Map<string, string> {
	const wanted = new Set(keys);
	const found = new Map<string, string | null>();
	for (const entry of entries) {
		if (
			!entry.utf8 ||
			entry.type !== "blob" ||
			!isRegularFileMode(entry.mode)
		) {
			continue;
		}
		const key = contextStorageKey(entry.path);
		if (!key.ok || !wanted.has(key.storageKey)) {
			continue;
		}
		found.set(key.storageKey, found.has(key.storageKey) ? null : entry.oid);
	}
	const oids = new Map<string, string>();
	for (const [key, oid] of found) {
		if (oid !== null) {
			oids.set(key, oid);
		}
	}
	return oids;
}
