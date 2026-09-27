/**
 * Coding Instructions' adapter for the shared selection tree (Fizzy #2750
 * §4). Pure. The dialog keeps what it kept before the tree: the synced
 * folder (`root`: `null` while nothing is ticked, which only the dialog
 * knows; `""` for the repository root), the project's COMPLETE saved rule
 * list, and the staged edits against it (`ExclusionEdits`,
 * `../../../lib/instructions-sync-exclusions`). Every row's membership is
 * derived from those, never stored:
 *
 *  - a FILE inside the root is in or out by the sync's own matcher on its
 *    own path (`syncExclusionMatcher`: the root's `.fabricignore` or the
 *    staged project list, behind the built-in rules), exactly as the sync
 *    plans it; a file that is not a regular file (a symbolic link) is out
 *    before any rule;
 *  - a FOLDER inside the root is out as a whole only when a rule provably
 *    covers its whole subtree (a literal `F/**` for it, or a `**\/name/**`
 *    or anchored `a/b/**` rule, as the defaults and built-ins are written);
 *    otherwise it is the aggregate of the listed files beneath it: all in →
 *    in, some out by a member rule → mixed, all out → out ("aggregate",
 *    which never disables what is below it). Default and built-in skips never
 *    make a folder mixed;
 *  - the root's own row is in, or mixed when a member rule leaves something
 *    below it out; outside the root, a folder is out and ticking it moves
 *    the root there, and a file is out and cannot be ticked.
 *
 * What a click would do is decided per operation, from the edit it would
 * stage and the list that results: adding a rule (unticking) is refused by a
 * replacing `.fabricignore`, unknown rules, a full list (the defaults a
 * first custom rule copies in counted), a name with `*` or `?`, or a pattern
 * too long to store; removing rules (ticking) is refused only by the first
 * two, never by capacity or spelling. A row out because of a rule the tree
 * cannot change (a project glob that is no listed row's own pattern, a
 * default or built-in rule, a symbolic link) is disabled with that rule
 * named. So is a partial row (the root, or a folder inside it) when no rule
 * at or below it is a listed row's own: a click on an indeterminate box
 * checks it, and checking never leaves anything out or clears the root.
 *
 * "Member" rules are the ones a person wrote: the project's own list or the
 * `.fabricignore`, less any rule that is one of the defaults (a project
 * that set its own list keeps the defaults in it, and those still read as
 * defaults).
 */
import {
	ALWAYS_IGNORE_GLOBS,
	canonicalKey,
	DEFAULT_IGNORE_GLOBS,
	type IgnoreLayer,
	PROJECT_IGNORE_GLOB_LIMITS,
} from "@repo/instructions";
import {
	type ExclusionEdits,
	folderExclusionPattern,
	NO_EXCLUSION_EDITS,
	sameRule,
	savedRulesRemovedBy,
	stagedProjectGlobs,
	syncExclusionMatcher,
	toggleExclusion,
} from "../../../lib/instructions-sync-exclusions";
import {
	isStrictlyInside,
	type RepositoryTreeIndex,
	type RepositoryTreeNode,
} from "./repository-tree";
import type {
	SelectionMembership,
	SelectionMessage,
	SelectionRow,
	SelectionSummaryModel,
} from "./selection-row";

/** What the dialog keeps (file comment). */
export type InstructionsSelection = {
	/** `null`: nothing ticked yet. `""`: the repository root. */
	root: string | null;
	edits: ExclusionEdits;
};

/** The synced folder's `.fabricignore`, as far as the dialog knows it. */
export type InstructionsIgnoreFile =
	/** No file, one with no rules, or one the sync drops (too large). */
	| { kind: "none" }
	| { kind: "rules"; rules: readonly string[] }
	| { kind: "loading" }
	| { kind: "failed" };

/** Whether the rules that decide each row are known. */
type InstructionsRulesStatus = "known" | "loading" | "failed";

/** What one click does to the selection. */
export type InstructionsAction =
	/** Move the synced folder (or clear it), dropping the staged edits. */
	| { type: "setRoot"; root: string | null }
	/**
	 * Stage `pattern` as left out; for a folder, `coveredFolder` names it so
	 * the staged additions beneath it, which the new pattern covers, go.
	 */
	| { type: "addRule"; pattern: string; coveredFolder: string | null }
	/** Stop leaving these rules' rows out: cancel or stage their removal. */
	| { type: "removeRules"; rules: readonly string[] };

/** A row the member left out by its own rule, re-tickable from the list. */
type InstructionsLeftOut = {
	path: string;
	type: "file" | "dir";
	rule: string;
	action: InstructionsAction;
};

export type InstructionsSelectionModel = {
	selection: InstructionsSelection;
	rules: InstructionsRulesStatus;
	/** The layer beside the built-in rules, once the rules are known. */
	layer: "fabricignore" | "project" | "default" | null;
	row: (node: RepositoryTreeNode) => SelectionRow;
	/** What a click on this row does, or `null` when it cannot be clicked. */
	actionFor: (node: RepositoryTreeNode) => InstructionsAction | null;
	/**
	 * Listed files inside the root the known rules keep; `null` with no
	 * root, no listing, or rules not known.
	 */
	includedFileCount: number | null;
	/** Rows left out by their own rule, not inside another left-out folder. */
	leftOut: readonly InstructionsLeftOut[];
	/** Saved rules the staged edits remove, in their saved spelling. */
	removedSavedRules: readonly string[];
};

const MESSAGE_PREFIX = "tree.selection";

const DEFAULT_KEYS: ReadonlySet<string> = new Set(
	DEFAULT_IGNORE_GLOBS.map(canonicalKey),
);

function message(
	key: string,
	values?: Record<string, string | number>,
): SelectionMessage {
	return values
		? { key: `${MESSAGE_PREFIX}.${key}`, values }
		: { key: `${MESSAGE_PREFIX}.${key}` };
}

const CANT_TELL_YET = message("cantTellYet");
const SYNCS_A_FOLDER = message("syncsAFolder");
const NOT_REGULAR = message("notRegular");
const FABRICIGNORE = message("fabricignore");

/** A rule a person wrote (file comment), in the layer it matched in. */
function isMemberRule(rule: string, layer: IgnoreLayer): boolean {
	return (
		(layer === "project" || layer === "fabricignore") &&
		!DEFAULT_KEYS.has(canonicalKey(rule))
	);
}

/** Why a rule leaves a row out, naming the rule. */
function causeMessage(rule: string, layer: IgnoreLayer): SelectionMessage {
	return message(`cause.${layer}`, { rule });
}

/**
 * A rule every path below some folder provably matches: `a/b/**` (anchored
 * at the synced folder) or `**\/a/b/**` (anywhere), with literal segments.
 * The matcher compiles `F/` as `F/**`, so a trailing `/` is the same shape.
 */
type SubtreeRule = {
	rule: string;
	layer: IgnoreLayer;
	anchored: boolean;
	segments: readonly string[];
};

function subtreeRuleOf(rule: string, layer: IgnoreLayer): SubtreeRule | null {
	let key = canonicalKey(rule);
	if (key.endsWith("/")) {
		key = `${key}**`;
	}
	if (!key.endsWith("/**")) {
		return null;
	}
	let body = key.slice(0, -3);
	let anchored = true;
	if (body.startsWith("**/")) {
		anchored = false;
		body = body.slice(3);
	}
	if (body === "" || /[*?]/.test(body)) {
		return null;
	}
	const segments = body.split("/");
	if (segments.some((segment) => segment === "")) {
		return null;
	}
	return { rule, layer, anchored, segments };
}

/** Whether `rule` covers every path below the folder with these segments. */
function coversFolder(rule: SubtreeRule, folder: readonly string[]): boolean {
	const n = rule.segments.length;
	const matchesAt = (start: number) =>
		rule.segments.every((segment, i) => segment === folder[start + i]);
	if (rule.anchored) {
		return n <= folder.length && matchesAt(0);
	}
	for (let start = 0; start + n <= folder.length; start++) {
		if (matchesAt(start)) {
			return true;
		}
	}
	return false;
}

/** A folder left out as a whole, and the rule that does it. */
type Covering = {
	folder: string;
	rule: string;
	layer: IgnoreLayer;
	/** The folder's own toggle pattern, which ticking it removes. */
	own: boolean;
};

/** A member rule, in the layer it matched in. */
type MemberCause = { rule: string; layer: IgnoreLayer };

type Aggregate = {
	files: number;
	inFiles: number;
	memberOut: number;
	/** Folders below left out as a whole by a member rule. */
	memberFolders: number;
	/** The first member rule that leaves something below out, if any. */
	memberCause: MemberCause | null;
};

const EMPTY_AGGREGATE: Aggregate = {
	files: 0,
	inFiles: 0,
	memberOut: 0,
	memberFolders: 0,
	memberCause: null,
};

function addAggregate(a: Aggregate, b: Aggregate): Aggregate {
	return {
		files: a.files + b.files,
		inFiles: a.inFiles + b.inFiles,
		memberOut: a.memberOut + b.memberOut,
		memberFolders: a.memberFolders + b.memberFolders,
		memberCause: a.memberCause ?? b.memberCause,
	};
}

type FileVerdict =
	| { kind: "in" }
	| { kind: "unknown" }
	| { kind: "notRegular" }
	| { kind: "rule"; rule: string; layer: IgnoreLayer };

type NodeInfo =
	| { place: "root"; aggregate: Aggregate }
	| {
			place: "inside";
			kind: "file";
			relative: string;
			verdict: FileVerdict;
			coveredBy: Covering | null;
	  }
	| {
			place: "inside";
			kind: "dir";
			relative: string;
			coveredBy: Covering | null;
			subtree: Covering | null;
			aggregate: Aggregate;
	  };

type RowPlan = { row: SelectionRow; action: InstructionsAction | null };

/** The status of the rules every row inside the root depends on. */
function instructionsRulesStatus(input: {
	savedGlobs: readonly string[] | null | undefined;
	settingsFailed: boolean;
	ignoreFile: InstructionsIgnoreFile;
}): InstructionsRulesStatus {
	if (input.settingsFailed || input.ignoreFile.kind === "failed") {
		return "failed";
	}
	if (input.savedGlobs === undefined || input.ignoreFile.kind === "loading") {
		return "loading";
	}
	return "known";
}

export function instructionsSelectionModel(input: {
	/** The whole listing, or `null` without one. */
	tree: RepositoryTreeIndex | null;
	selection: InstructionsSelection;
	/** The project's saved list: `null` for no setting, `undefined` until loaded. */
	savedGlobs: readonly string[] | null | undefined;
	settingsFailed: boolean;
	ignoreFile: InstructionsIgnoreFile;
}): InstructionsSelectionModel {
	const { selection, savedGlobs } = input;
	const { root, edits } = selection;
	const rules = instructionsRulesStatus(input);
	const staged =
		savedGlobs === undefined
			? undefined
			: stagedProjectGlobs(savedGlobs, edits);
	const matcher =
		rules === "known"
			? syncExclusionMatcher({
					fabricIgnoreRules:
						input.ignoreFile.kind === "rules"
							? input.ignoreFile.rules
							: null,
					projectGlobs: staged ?? null,
				})
			: null;
	const layer = matcher?.layer ?? null;
	// The built-in rules first, then the layer beside them: the matcher's
	// own lists, so a subtree claim is one the sync would make too.
	const subtreeRules: SubtreeRule[] = matcher
		? [
				...ALWAYS_IGNORE_GLOBS.map((rule) =>
					subtreeRuleOf(rule, "always"),
				),
				...matcher.globs.map((rule) =>
					subtreeRuleOf(rule, matcher.layer),
				),
			].filter((rule): rule is SubtreeRule => rule !== null)
		: [];

	const info = new Map<string, NodeInfo>();
	/** Canonical toggle pattern → the rows inside the root that write it. */
	const togglePatterns = new Map<string, string[]>();
	let includedFileCount: number | null = null;

	const relativeOf = (path: string) =>
		root === "" ? path : path.slice((root as string).length + 1);

	function ownPattern(node: RepositoryTreeNode, relative: string): string {
		return node.type === "dir"
			? folderExclusionPattern(relative)
			: relative;
	}

	function fileVerdict(
		node: RepositoryTreeNode,
		relative: string,
	): FileVerdict {
		if (node.regular === false) {
			return { kind: "notRegular" };
		}
		if (!matcher) {
			return { kind: "unknown" };
		}
		const hit = matcher.match(relative);
		return hit
			? { kind: "rule", rule: hit.rule, layer: hit.layer }
			: { kind: "in" };
	}

	function coveringOf(relative: string, path: string): Covering | null {
		if (!matcher) {
			return null;
		}
		const segments = relative.toLowerCase().split("/");
		const pattern = folderExclusionPattern(relative);
		let own: Covering | null = null;
		for (const rule of subtreeRules) {
			if (!coversFolder(rule, segments)) {
				continue;
			}
			const isOwn =
				rule.layer === "project" &&
				isMemberRule(rule.rule, rule.layer) &&
				sameRule(rule.rule, pattern);
			if (!isOwn) {
				// Another rule leaves it out too: ticking it could not
				// bring it back, so that rule is the one to name.
				return {
					folder: path,
					rule: rule.rule,
					layer: rule.layer,
					own: false,
				};
			}
			own ??= {
				folder: path,
				rule: rule.rule,
				layer: rule.layer,
				own: true,
			};
		}
		return own;
	}

	/** One node inside the root, and what it adds to its parent. */
	function visitInside(
		node: RepositoryTreeNode,
		coveredBy: Covering | null,
	): Aggregate {
		const relative = relativeOf(node.path);
		const key = canonicalKey(ownPattern(node, relative));
		const writers = togglePatterns.get(key);
		if (writers) {
			writers.push(node.path);
		} else {
			togglePatterns.set(key, [node.path]);
		}
		if (node.type === "file") {
			const verdict = fileVerdict(node, relative);
			info.set(node.path, {
				place: "inside",
				kind: "file",
				relative,
				verdict,
				coveredBy,
			});
			const memberOut =
				verdict.kind === "rule" &&
				isMemberRule(verdict.rule, verdict.layer);
			return {
				files: 1,
				inFiles: verdict.kind === "in" ? 1 : 0,
				memberOut: memberOut ? 1 : 0,
				memberFolders: 0,
				memberCause:
					memberOut && verdict.kind === "rule"
						? { rule: verdict.rule, layer: verdict.layer }
						: null,
			};
		}
		const subtree = coveredBy ? null : coveringOf(relative, node.path);
		let aggregate = EMPTY_AGGREGATE;
		for (const child of node.children) {
			aggregate = addAggregate(
				aggregate,
				visitInside(child, coveredBy ?? subtree),
			);
		}
		info.set(node.path, {
			place: "inside",
			kind: "dir",
			relative,
			coveredBy,
			subtree,
			aggregate,
		});
		return subtree && isMemberRule(subtree.rule, subtree.layer)
			? {
					...aggregate,
					memberFolders: aggregate.memberFolders + 1,
					memberCause: {
						rule: subtree.rule,
						layer: subtree.layer,
					},
				}
			: aggregate;
	}

	if (input.tree && root !== null) {
		let rootAggregate = EMPTY_AGGREGATE;
		const visitOutside = (nodes: readonly RepositoryTreeNode[]) => {
			for (const node of nodes) {
				if (root === "") {
					rootAggregate = addAggregate(
						rootAggregate,
						visitInside(node, null),
					);
				} else if (node.path === root) {
					for (const child of node.children) {
						rootAggregate = addAggregate(
							rootAggregate,
							visitInside(child, null),
						);
					}
					info.set(node.path, {
						place: "root",
						aggregate: rootAggregate,
					});
				} else if (
					node.type === "dir" &&
					isStrictlyInside(node.path, root)
				) {
					visitOutside(node.children);
				}
			}
		};
		visitOutside(input.tree.roots);
		if (matcher) {
			includedFileCount = rootAggregate.inFiles;
		}
	}

	/**
	 * Every rule of the staged project list, less the defaults, that is the
	 * same rule as the toggle pattern of a listed row at or below `folder`
	 * (the root: every row inside it), saved or staged, on the list as it
	 * stands. A replacing `.fabricignore` leaves none.
	 */
	function removableAt(folder: string): string[] {
		if (layer !== "project" || !staged) {
			return [];
		}
		const removable: string[] = [];
		for (const rule of staged) {
			const key = canonicalKey(rule);
			if (DEFAULT_KEYS.has(key)) {
				continue;
			}
			const writers = togglePatterns.get(key);
			if (
				writers?.some(
					(path) =>
						folder === root ||
						path === folder ||
						isStrictlyInside(folder, path),
				)
			) {
				removable.push(rule);
			}
		}
		return removable;
	}

	/** Why adding `pattern` for the row at `relative` is refused, if it is. */
	function addBlock(
		relative: string,
		action: Extract<InstructionsAction, { type: "addRule" }>,
	): SelectionMessage | null {
		if (layer === "fabricignore") {
			return FABRICIGNORE;
		}
		if (/[*?]/.test(relative)) {
			return message("wildcard");
		}
		if (action.pattern.length > PROJECT_IGNORE_GLOB_LIMITS.maxGlobLength) {
			return message("tooLong");
		}
		const next = stagedProjectGlobs(
			savedGlobs ?? null,
			applyInstructionsAction(selection, action).edits,
		);
		if ((next ?? []).length > PROJECT_IGNORE_GLOB_LIMITS.maxGlobs) {
			return message("full", {
				max: PROJECT_IGNORE_GLOB_LIMITS.maxGlobs,
			});
		}
		return null;
	}

	function untick(
		relative: string,
		pattern: string,
		coveredFolder: string | null,
		membership: SelectionMembership,
		note: SelectionMessage | null = null,
	): RowPlan {
		const action: InstructionsAction = {
			type: "addRule",
			pattern,
			coveredFolder,
		};
		const block = addBlock(relative, action);
		return block
			? { row: { membership, disabledReason: block, note }, action: null }
			: { row: { membership, disabledReason: null, note }, action };
	}

	/**
	 * A partial row (the root, or a folder inside it) with nothing the tree
	 * can remove: a click on an indeterminate box checks it, and checking
	 * must never leave anything out or clear the root, so the row offers no
	 * click and names the member rule that makes it partial.
	 */
	function partialPlan(folder: string, aggregate: Aggregate): RowPlan {
		const removable = removableAt(folder);
		if (removable.length > 0) {
			return {
				row: { membership: "mixed", disabledReason: null },
				action: { type: "removeRules", rules: removable },
			};
		}
		const cause = aggregate.memberCause;
		return {
			row: {
				membership: "mixed",
				disabledReason: cause
					? message(`partlyLeftOut.${cause.layer}`, {
							rule: cause.rule,
						})
					: CANT_TELL_YET,
			},
			action: null,
		};
	}

	function coveredPlan(covering: Covering): RowPlan {
		return {
			row: {
				membership: "out",
				disabledReason: covering.own
					? message("leftOutBecause", { path: covering.folder })
					: causeMessage(covering.rule, covering.layer),
			},
			action: null,
		};
	}

	function planFor(node: RepositoryTreeNode): RowPlan {
		const found = root === null ? undefined : info.get(node.path);
		if (!found) {
			// Outside the root, or nothing ticked.
			return node.type === "dir"
				? {
						row: { membership: "out", disabledReason: null },
						action: { type: "setRoot", root: node.path },
					}
				: {
						row: {
							membership: "out",
							disabledReason: SYNCS_A_FOLDER,
						},
						action: null,
					};
		}
		if (found.place === "root") {
			const partial =
				matcher !== null &&
				(found.aggregate.memberOut > 0 ||
					found.aggregate.memberFolders > 0);
			if (!partial) {
				return {
					row: { membership: "in", disabledReason: null },
					action: { type: "setRoot", root: null },
				};
			}
			return partialPlan(node.path, found.aggregate);
		}
		if (found.kind === "file") {
			const { verdict, relative } = found;
			if (verdict.kind === "notRegular") {
				return {
					row: { membership: "out", disabledReason: NOT_REGULAR },
					action: null,
				};
			}
			if (verdict.kind === "unknown") {
				return {
					row: {
						membership: "unknown",
						disabledReason: CANT_TELL_YET,
					},
					action: null,
				};
			}
			if (found.coveredBy) {
				return coveredPlan(found.coveredBy);
			}
			if (verdict.kind === "in") {
				return untick(relative, relative, null, "in");
			}
			if (
				verdict.layer === "project" &&
				isMemberRule(verdict.rule, verdict.layer) &&
				sameRule(verdict.rule, relative)
			) {
				return {
					row: { membership: "out", disabledReason: null },
					action: { type: "removeRules", rules: [verdict.rule] },
				};
			}
			return {
				row: {
					membership: "out",
					disabledReason: causeMessage(verdict.rule, verdict.layer),
				},
				action: null,
			};
		}
		// A folder inside the root.
		if (!matcher) {
			return {
				row: { membership: "unknown", disabledReason: CANT_TELL_YET },
				action: null,
			};
		}
		if (found.coveredBy) {
			return coveredPlan(found.coveredBy);
		}
		if (found.subtree) {
			return found.subtree.own
				? {
						row: { membership: "out", disabledReason: null },
						action: {
							type: "removeRules",
							rules: [found.subtree.rule],
						},
					}
				: coveredPlan(found.subtree);
		}
		const { aggregate, relative } = found;
		const pattern = folderExclusionPattern(relative);
		if (aggregate.files > 0 && aggregate.inFiles === 0) {
			// Every listed file is out on its own: not a claim about the
			// subtree, so the rows below keep their own state.
			const note = message("everythingListedLeftOut", {
				path: node.path,
			});
			const removable = removableAt(node.path);
			return removable.length > 0
				? {
						row: { membership: "out", disabledReason: null, note },
						action: { type: "removeRules", rules: removable },
					}
				: {
						row: { membership: "out", disabledReason: note },
						action: null,
					};
		}
		if (aggregate.memberOut > 0 || aggregate.memberFolders > 0) {
			return partialPlan(node.path, aggregate);
		}
		return untick(relative, pattern, relative, "in");
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

	const leftOut: InstructionsLeftOut[] = [];
	if (input.tree && matcher) {
		for (const [path, found] of info) {
			if (found.place !== "inside" || found.coveredBy) {
				continue;
			}
			let rule: string | null = null;
			if (found.kind === "dir" && found.subtree?.own) {
				rule = found.subtree.rule;
			} else if (
				found.kind === "file" &&
				found.verdict.kind === "rule" &&
				found.verdict.layer === "project" &&
				isMemberRule(found.verdict.rule, found.verdict.layer) &&
				sameRule(found.verdict.rule, found.relative)
			) {
				rule = found.verdict.rule;
			}
			if (rule !== null) {
				leftOut.push({
					path,
					type: found.kind,
					rule,
					action: { type: "removeRules", rules: [rule] },
				});
			}
		}
		leftOut.sort((a, b) => a.path.localeCompare(b.path));
	}

	return {
		selection,
		rules,
		layer,
		row: (node) => cachedPlan(node).row,
		actionFor: (node) => cachedPlan(node).action,
		includedFileCount,
		leftOut,
		removedSavedRules: savedRulesRemovedBy(savedGlobs ?? null, edits),
	};
}

/** The selection after one click, or Select all / Select none. */
export function applyInstructionsAction(
	selection: InstructionsSelection,
	action: InstructionsAction,
): InstructionsSelection {
	switch (action.type) {
		case "setRoot":
			// A different folder is a different tree: the staged patterns
			// were relative to the old one.
			return { root: action.root, edits: NO_EXCLUSION_EDITS };
		case "addRule": {
			const prefix =
				action.coveredFolder === null
					? null
					: `${canonicalKey(action.coveredFolder)}/`;
			const add = prefix
				? selection.edits.add.filter(
						(rule) => !canonicalKey(rule).startsWith(prefix),
					)
				: selection.edits.add;
			return {
				root: selection.root,
				edits: toggleExclusion(
					{ add, remove: selection.edits.remove },
					action.pattern,
					true,
				),
			};
		}
		case "removeRules":
			return {
				root: selection.root,
				edits: action.rules.reduce(
					(edits, rule) => toggleExclusion(edits, rule, false),
					selection.edits,
				),
			};
	}
}

/** Select all: the repository root, the saved rules untouched. */
export const SELECT_ALL_INSTRUCTIONS: InstructionsAction = {
	type: "setRoot",
	root: "",
};

/** Select none: nothing ticked, and the dialog's own unticks dropped. */
export const SELECT_NONE_INSTRUCTIONS: InstructionsAction = {
	type: "setRoot",
	root: null,
};

/**
 * The dialog's summary under the tree: what syncs, the live count of listed
 * files that match the known rules (never a promise: the run can still skip
 * a file it cannot read, or refuse the tree), and what the count cannot see.
 */
export function instructionsSummary(input: {
	model: InstructionsSelectionModel;
	listing: "idle" | "loading" | "error" | "unsupported" | "ready";
	truncated: boolean;
}): SelectionSummaryModel {
	const { model } = input;
	const root = model.selection.root;
	if (root === null) {
		return {
			nothingSelected: { key: "summary.nothingSelected" },
			lead: null,
			count: null,
			notes: [],
		};
	}
	const excluded = model.leftOut.length;
	const lead: SelectionMessage =
		root === ""
			? excluded > 0
				? { key: "summary.leadRootExcept", values: { excluded } }
				: { key: "summary.leadRoot" }
			: excluded > 0
				? {
						key: "summary.leadExcept",
						values: { folder: root, excluded },
					}
				: { key: "summary.lead", values: { folder: root } };
	let count: SelectionMessage | null = null;
	if (input.listing === "loading") {
		count = { key: "summary.counting" };
	} else if (input.listing === "ready") {
		if (model.rules === "loading") {
			count = { key: "summary.counting" };
		} else if (model.rules === "failed") {
			count = { key: "summary.cantCount" };
		} else if (model.includedFileCount !== null) {
			count = {
				key: input.truncated
					? "summary.matchTruncated"
					: "summary.matchNow",
				values: { count: model.includedFileCount },
			};
		}
	}
	return {
		nothingSelected: null,
		lead,
		count,
		notes: [{ key: "summary.installedAs" }, { key: "summary.unreadable" }],
	};
}

/**
 * The settings section's summary (Fizzy #2750 §6), which has no listing and
 * no count: the folder, and that the project's rules leave some files out
 * when `getSettings` shows any (its own list, or the defaults it stands for).
 */
export function instructionsSettingsSummary(input: {
	rootPath: string;
	settings:
		| {
				ignoreGlobs: readonly string[] | null;
				defaultIgnoreGlobs: readonly string[];
		  }
		| undefined;
}): SelectionMessage[] {
	const lines: SelectionMessage[] = [
		input.rootPath === ""
			? { key: "summary.leadRoot" }
			: { key: "summary.lead", values: { folder: input.rootPath } },
	];
	const rules = input.settings
		? (input.settings.ignoreGlobs ?? input.settings.defaultIgnoreGlobs)
		: [];
	if (rules.length > 0) {
		lines.push({ key: "summary.projectRulesLeaveOut" });
	}
	return lines;
}
