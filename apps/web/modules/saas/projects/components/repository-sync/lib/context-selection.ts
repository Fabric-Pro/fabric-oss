/**
 * Living Memory's adapter for the shared selection tree, and the one
 * reducer both the tree and the typed "Add a path" input use (Fizzy #2750
 * §5.7). Pure.
 *
 * The selection is what `configure` stores: the selected `paths` (at most
 * 50, none inside another; `""` the whole repository) and the
 * `excludedPaths` left out inside them (at most 200, each strictly inside
 * one selected path, none inside another). A selected folder is live: files
 * added to it later sync too.
 *
 * `listTree` returns every entry with `configure`'s own verdict on its path
 * (`selectRefusal`, `excludeRefusal`); whether an entry would actually sync
 * is decided here with the rules the run itself uses
 * (`@repo/instructions/context-sync-rules`): a file inside a ticked folder is
 * judged against the default exclusions RELATIVE TO THAT FOLDER (so
 * `skills/x.md` under a ticked root is left out by `skills/`), while a file
 * ticked directly is judged by its basename only, as the run does (so the
 * same file, ticked on its own, syncs). Only text files sync, a symbolic
 * link never does, a `.fabric` segment never does, and a folder's
 * `.contextignore` is read as its policy, never synced.
 *
 * Membership is computed over the whole listing and selection. Rule-based
 * skips never make a folder mixed; what the member left out does, and so,
 * for a folder that is not selected itself, do selected paths inside it.
 */
import {
	contextSyncPathSpellingProblem,
	createContextDefaultRules,
	defaultRuleForDirectlySelectedFile,
	hasContextTextExtension,
	isContextIgnorePolicyFile,
	isExcludedDirectlySelectedFile,
	isInContextSyncFabricDirectory,
} from "@repo/instructions/context-sync-rules";
import { CONTEXT_SYNC_MAX_PATHS } from "../../../lib/context-repository-sync";
import {
	ancestorsOf,
	isStrictlyInside,
	type RepositoryTreeEntry,
	type RepositoryTreeIndex,
	type RepositoryTreeNode,
} from "./repository-tree";
import type {
	SelectionMembership,
	SelectionMessage,
	SelectionRow,
	SelectionSummaryModel,
} from "./selection-row";

/** At most this many left-out paths (`configure`'s own bound). */
export const CONTEXT_SYNC_MAX_EXCLUDED_PATHS = 200;

/** One `listTree` entry, with `configure`'s verdict on its path. */
export type ContextRepositoryTreeEntry = RepositoryTreeEntry & {
	/** Absent when the path may be selected. */
	selectRefusal?: "INVALID_PATH" | "EXCLUDED_PATH";
	/** Absent when the path may be left out. */
	excludeRefusal?:
		| "INVALID_PATH"
		| "EXCLUDED_PATH"
		| "EXCLUDED_PATH_POLICY_FILE";
};

export type ContextSelection = {
	paths: readonly string[];
	excludedPaths: readonly string[];
};

export const EMPTY_CONTEXT_SELECTION: ContextSelection = {
	paths: [],
	excludedPaths: [],
};

/** What one click (or a typed path) does to the selection. */
export type ContextAction =
	/** Tick a path outside every selection: select it, absorbing what is below. */
	| { type: "include"; path: string }
	/** Untick a selected path: drop it and what is left out inside it. */
	| { type: "unselect"; path: string }
	/** Untick a path inside a selected folder: leave it out. */
	| { type: "exclude"; path: string }
	/** Tick a partial folder inside a selection: nothing below left out. */
	| { type: "clearExclusionsBelow"; path: string }
	/** Tick a left-out path: it syncs again. */
	| { type: "reinclude"; path: string }
	| { type: "selectAll" }
	| { type: "selectNone" };

export type ContextActionResult =
	| { ok: true; selection: ContextSelection }
	| { ok: false; code: "TOO_MANY_PATHS" | "TOO_MANY_EXCLUDED_PATHS" };

function sorted(paths: readonly string[]): string[] {
	return [...paths].sort();
}

/**
 * The selection after one action. Adding (a new selected path, a new
 * left-out path) checks its cap AFTER absorbing what the new path covers;
 * removing never checks a cap.
 */
export function applyContextAction(
	selection: ContextSelection,
	action: ContextAction,
): ContextActionResult {
	const { paths, excludedPaths } = selection;
	switch (action.type) {
		case "selectAll":
			return { ok: true, selection: { paths: [""], excludedPaths: [] } };
		case "selectNone":
			return { ok: true, selection: EMPTY_CONTEXT_SELECTION };
		case "include": {
			const next = paths.filter(
				(path) =>
					path !== action.path &&
					!isStrictlyInside(action.path, path),
			);
			next.push(action.path);
			if (next.length > CONTEXT_SYNC_MAX_PATHS) {
				return { ok: false, code: "TOO_MANY_PATHS" };
			}
			return {
				ok: true,
				selection: {
					paths: sorted(next),
					excludedPaths: excludedPaths.filter(
						(path) => !isStrictlyInside(action.path, path),
					),
				},
			};
		}
		case "unselect":
			return {
				ok: true,
				selection: {
					paths: paths.filter((path) => path !== action.path),
					excludedPaths: excludedPaths.filter(
						(path) => !isStrictlyInside(action.path, path),
					),
				},
			};
		case "exclude": {
			const next = excludedPaths.filter(
				(path) =>
					path !== action.path &&
					!isStrictlyInside(action.path, path),
			);
			next.push(action.path);
			if (next.length > CONTEXT_SYNC_MAX_EXCLUDED_PATHS) {
				return { ok: false, code: "TOO_MANY_EXCLUDED_PATHS" };
			}
			return {
				ok: true,
				selection: { paths, excludedPaths: sorted(next) },
			};
		}
		case "clearExclusionsBelow":
			return {
				ok: true,
				selection: {
					paths,
					excludedPaths: excludedPaths.filter(
						(path) => !isStrictlyInside(action.path, path),
					),
				},
			};
		case "reinclude":
			return {
				ok: true,
				selection: {
					paths,
					excludedPaths: excludedPaths.filter(
						(path) => path !== action.path,
					),
				},
			};
	}
}

const MESSAGE_PREFIX = "tree.selection";

function message(
	key: string,
	values?: Record<string, string | number>,
): SelectionMessage {
	return values
		? { key: `${MESSAGE_PREFIX}.${key}`, values }
		: { key: `${MESSAGE_PREFIX}.${key}` };
}

const FABRIC = message("fabric");
const SYMLINK = message("symlink");
const POLICY_FILE = message("policyFile");
const NON_TEXT = message("nonText");
const INVALID_PATH = message("invalidPath");
const CODING_INSTRUCTIONS_FILE = message("codingInstructionsFile");

/** Why `configure` would refuse `path` as a selected path, if it would. */
function selectRefusalMessage(
	path: string,
	entry: ContextRepositoryTreeEntry | undefined,
): SelectionMessage | null {
	// A folder the provider only implied has no verdict of its own: the
	// same per-path rules `configure` applies, from the same module.
	const refusal = entry
		? entry.selectRefusal
		: contextSyncPathSpellingProblem(path) !== null
			? "INVALID_PATH"
			: isInContextSyncFabricDirectory(path) ||
					defaultRuleForDirectlySelectedFile(path) !== null
				? "EXCLUDED_PATH"
				: undefined;
	if (refusal === undefined) {
		return null;
	}
	if (refusal === "INVALID_PATH") {
		return INVALID_PATH;
	}
	if (isInContextSyncFabricDirectory(path)) {
		return FABRIC;
	}
	return isContextIgnorePolicyFile(path)
		? POLICY_FILE
		: CODING_INSTRUCTIONS_FILE;
}

/** Why `configure` would refuse `path` as a left-out path, if it would. */
function excludeRefusalMessage(
	path: string,
	entry: ContextRepositoryTreeEntry | undefined,
): SelectionMessage | null {
	const refusal = entry
		? entry.excludeRefusal
		: contextSyncPathSpellingProblem(path) !== null
			? "INVALID_PATH"
			: isInContextSyncFabricDirectory(path)
				? "EXCLUDED_PATH"
				: isContextIgnorePolicyFile(path)
					? "EXCLUDED_PATH_POLICY_FILE"
					: undefined;
	switch (refusal) {
		case undefined:
			return null;
		case "INVALID_PATH":
			return INVALID_PATH;
		case "EXCLUDED_PATH":
			return FABRIC;
		case "EXCLUDED_PATH_POLICY_FILE":
			return POLICY_FILE;
	}
}

type RowPlan = { row: SelectionRow; action: ContextAction | null };

export type ContextSelectionModel = {
	selection: ContextSelection;
	row: (node: RepositoryTreeNode) => SelectionRow;
	/** What a click on this row does, or `null` when it cannot be clicked. */
	actionFor: (node: RepositoryTreeNode) => ContextAction | null;
	/** Listed files that would sync; `null` without a listing. */
	includedFileCount: number | null;
};

export function contextSelectionModel(input: {
	/** The whole listing, or `null` without one. */
	tree: RepositoryTreeIndex<ContextRepositoryTreeEntry> | null;
	selection: ContextSelection;
}): ContextSelectionModel {
	const { selection, tree } = input;
	const selected = new Set(selection.paths);
	const excluded = new Set(selection.excludedPaths);
	/** Folders that hold a selected path below them. */
	const holdsSelected = new Set<string>();
	for (const path of selection.paths) {
		for (const ancestor of ancestorsOf(path)) {
			holdsSelected.add(ancestor);
		}
	}
	/** Folders that hold a left-out path below them. */
	const holdsExcluded = new Set<string>();
	for (const path of selection.excludedPaths) {
		for (const ancestor of ancestorsOf(path)) {
			holdsExcluded.add(ancestor);
		}
	}
	// A fresh matcher per model: it caches every path it answers.
	const rules = createContextDefaultRules();

	/** The selected path `path` is, or is inside. */
	function ownerOf(path: string): string | null {
		if (selected.has(path)) {
			return path;
		}
		for (const ancestor of ancestorsOf(path)) {
			if (selected.has(ancestor)) {
				return ancestor;
			}
		}
		return selected.has("") ? "" : null;
	}

	/** The left-out folder `path` is strictly inside, if any. */
	function excludedAncestorOf(path: string): string | null {
		for (const ancestor of ancestorsOf(path)) {
			if (excluded.has(ancestor)) {
				return ancestor;
			}
		}
		return null;
	}

	/**
	 * Why a path inside the selected folder `owner` does not sync by rule,
	 * judged relative to that folder as the run judges it; `null` when it
	 * syncs.
	 */
	function ruleSkip(
		node: RepositoryTreeNode,
		owner: string,
	): SelectionMessage | null {
		if (isInContextSyncFabricDirectory(node.path)) {
			return FABRIC;
		}
		const file = node.type === "file";
		if (file && node.regular === false) {
			return SYMLINK;
		}
		if (file && isContextIgnorePolicyFile(node.path)) {
			return POLICY_FILE;
		}
		const relative =
			owner === "" ? node.path : node.path.slice(owner.length + 1);
		let rule: string | null;
		try {
			rule = rules.ruleFor(relative, file ? "file" : "directory");
		} catch {
			return INVALID_PATH;
		}
		if (rule !== null) {
			return message("defaultRule", { rule });
		}
		if (file && !hasContextTextExtension(node.path)) {
			return NON_TEXT;
		}
		return null;
	}

	/** Why a directly selected file does not sync, if it does not. */
	function directFileSkip(node: RepositoryTreeNode): SelectionMessage | null {
		if (node.regular === false) {
			return SYMLINK;
		}
		if (isExcludedDirectlySelectedFile(node.path)) {
			return isInContextSyncFabricDirectory(node.path)
				? FABRIC
				: isContextIgnorePolicyFile(node.path)
					? POLICY_FILE
					: CODING_INSTRUCTIONS_FILE;
		}
		return hasContextTextExtension(node.path) ? null : NON_TEXT;
	}

	function withCap(
		action: ContextAction,
		membership: SelectionMembership,
	): RowPlan {
		const result = applyContextAction(selection, action);
		if (!result.ok) {
			return {
				row: {
					membership,
					disabledReason:
						result.code === "TOO_MANY_PATHS"
							? message("tooManyPaths", {
									max: CONTEXT_SYNC_MAX_PATHS,
								})
							: message("tooManyExcluded", {
									max: CONTEXT_SYNC_MAX_EXCLUDED_PATHS,
								}),
				},
				action: null,
			};
		}
		return { row: { membership, disabledReason: null }, action };
	}

	function disabled(reason: SelectionMessage): RowPlan {
		return {
			row: { membership: "out", disabledReason: reason },
			action: null,
		};
	}

	function planFor(node: RepositoryTreeNode): RowPlan {
		const path = node.path;
		const entry = tree?.entryByPath.get(path);
		const owner = ownerOf(path);
		if (owner === path) {
			if (node.type === "file") {
				// Selected, but the run skips it: out, saying why. The
				// selected-paths list is where the stored path is removed.
				const skip = directFileSkip(node);
				return skip
					? disabled(skip)
					: {
							row: { membership: "in", disabledReason: null },
							action: { type: "unselect", path },
						};
			}
			return holdsExcluded.has(path)
				? {
						row: { membership: "mixed", disabledReason: null },
						action: { type: "clearExclusionsBelow", path },
					}
				: {
						row: { membership: "in", disabledReason: null },
						action: { type: "unselect", path },
					};
		}
		if (owner !== null) {
			const excludedAncestor = excludedAncestorOf(path);
			if (excludedAncestor !== null) {
				return disabled(
					message("leftOutBecause", { path: excludedAncestor }),
				);
			}
			if (excluded.has(path)) {
				return {
					row: { membership: "out", disabledReason: null },
					action: { type: "reinclude", path },
				};
			}
			const skip = ruleSkip(node, owner);
			if (skip) {
				return disabled(skip);
			}
			if (node.type === "dir" && holdsExcluded.has(path)) {
				return {
					row: { membership: "mixed", disabledReason: null },
					action: { type: "clearExclusionsBelow", path },
				};
			}
			const refusal = excludeRefusalMessage(path, entry);
			if (refusal) {
				return {
					row: { membership: "in", disabledReason: refusal },
					action: null,
				};
			}
			return withCap({ type: "exclude", path }, "in");
		}
		// Outside every selection.
		const membership: SelectionMembership =
			node.type === "dir" && holdsSelected.has(path) ? "mixed" : "out";
		const refusal = selectRefusalMessage(path, entry);
		if (refusal) {
			return {
				row: { membership, disabledReason: refusal },
				action: null,
			};
		}
		if (node.type === "file") {
			const skip = directFileSkip(node);
			if (skip) {
				return disabled(skip);
			}
		}
		return withCap({ type: "include", path }, membership);
	}

	/** Whether a listed file would sync, by the same rules as its row. */
	function fileSyncs(node: RepositoryTreeNode): boolean {
		const owner = ownerOf(node.path);
		if (owner === null) {
			return false;
		}
		if (owner === node.path) {
			return directFileSkip(node) === null;
		}
		return (
			!excluded.has(node.path) &&
			excludedAncestorOf(node.path) === null &&
			ruleSkip(node, owner) === null
		);
	}

	const plans = new Map<string, RowPlan>();
	function cachedPlan(node: RepositoryTreeNode): RowPlan {
		let plan = plans.get(node.path);
		if (!plan) {
			plan = planFor(node);
			plans.set(node.path, plan);
		}
		return plan;
	}

	return {
		selection,
		row: (node) => cachedPlan(node).row,
		actionFor: (node) => cachedPlan(node).action,
		includedFileCount: tree
			? tree.files.reduce(
					(count, node) => count + (fileSyncs(node) ? 1 : 0),
					0,
				)
			: null,
	};
}

/** Each selected path's type, when the listing says. */
function listedTypeOf(
	tree: RepositoryTreeIndex | null,
	path: string,
): "file" | "dir" | null {
	if (path === "") {
		return "dir";
	}
	return tree?.nodes.get(path)?.type ?? null;
}

/**
 * "Syncs 3 selected paths, except 2 left out": the whole repository, or
 * how many folders and files when the listing names every selected path's
 * type, or "selected paths" when it does not (`tree` is `null` outside the
 * dialog, where no listing is read).
 */
export function contextSummaryLead(
	selection: ContextSelection,
	tree: RepositoryTreeIndex | null,
): SelectionMessage {
	const excluded = selection.excludedPaths.length;
	let what: SelectionMessage;
	if (selection.paths.length === 1 && selection.paths[0] === "") {
		what = { key: "summary.what.wholeRepository" };
	} else {
		const types = selection.paths.map((path) => listedTypeOf(tree, path));
		if (types.every((type) => type !== null)) {
			const folders = types.filter((type) => type === "dir").length;
			const files = types.length - folders;
			what =
				folders > 0 && files > 0
					? {
							key: "summary.what.foldersAndFiles",
							values: { folders, files },
						}
					: folders > 0
						? { key: "summary.what.folders", values: { folders } }
						: { key: "summary.what.files", values: { files } };
		} else {
			what = {
				key: "summary.what.paths",
				values: { count: selection.paths.length },
			};
		}
	}
	return excluded > 0
		? {
				key: "summary.leadExcept",
				values: { excluded },
				fragments: { what },
			}
		: { key: "summary.lead", fragments: { what } };
}

/**
 * The dialog's summary under the tree: what syncs, that later files inside a
 * ticked folder sync too, the live count of listed files that match the
 * known rules (never a promise), and what the count cannot see — a file the
 * run cannot read, and a ticked folder's `.contextignore`, which the tree
 * does not read (shown when a ticked folder's listing has one, or the
 * listing is truncated or unavailable).
 */
export function contextSummary(input: {
	model: ContextSelectionModel;
	tree: RepositoryTreeIndex | null;
	listing: "idle" | "loading" | "error" | "unsupported" | "ready";
	truncated: boolean;
}): SelectionSummaryModel {
	const { selection } = input.model;
	if (selection.paths.length === 0) {
		return {
			nothingSelected: { key: "summary.nothingSelected" },
			lead: null,
			count: null,
			notes: [],
		};
	}
	const folders = selection.paths.filter(
		(path) => listedTypeOf(input.tree, path) !== "file",
	);
	const notes: SelectionMessage[] = [];
	if (folders.length > 0) {
		notes.push({ key: "summary.later" });
	}
	notes.push({ key: "summary.unreadable" });
	const policyListed = folders.some((folder) =>
		input.tree?.nodes.has(
			folder === "" ? ".contextignore" : `${folder}/.contextignore`,
		),
	);
	if (
		folders.length > 0 &&
		(policyListed || input.listing !== "ready" || input.truncated)
	) {
		notes.push({ key: "summary.policyCaveat" });
	}
	let count: SelectionMessage | null = null;
	if (input.listing === "loading") {
		count = { key: "summary.counting" };
	} else if (
		input.listing === "ready" &&
		input.model.includedFileCount !== null
	) {
		count = {
			key: input.truncated
				? "summary.matchTruncated"
				: "summary.matchNow",
			values: { count: input.model.includedFileCount },
		};
	}
	return {
		nothingSelected: null,
		lead: contextSummaryLead(selection, input.tree),
		count,
		notes,
	};
}
