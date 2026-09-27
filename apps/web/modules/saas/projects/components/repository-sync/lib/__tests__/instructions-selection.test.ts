/**
 * Coding Instructions' adapter for the shared selection tree (Fizzy #2750
 * §4, §6, §9): every row judged by the sync's own matcher, folders out as a
 * whole only when a rule provably covers them, per-operation editability,
 * the transition table, the removal notice, Select all / Select none and
 * the count — and, last, the file verdicts checked against the sync's own
 * inventory and planner.
 */
import {
	DEFAULT_IGNORE_GLOBS,
	PROJECT_IGNORE_GLOB_LIMITS,
	planSnapshotFiles,
	resolveIgnoreGlobs,
} from "@repo/instructions";
import { describe, expect, it } from "vitest";
import {
	type ExclusionEdits,
	NO_EXCLUSION_EDITS,
	stagedProjectGlobs,
} from "../../../../lib/instructions-sync-exclusions";
import {
	applyInstructionsAction,
	type InstructionsAction,
	type InstructionsIgnoreFile,
	type InstructionsSelection,
	type InstructionsSelectionModel,
	instructionsSelectionModel,
	instructionsSettingsSummary,
	instructionsSummary,
	SELECT_ALL_INSTRUCTIONS,
	SELECT_NONE_INSTRUCTIONS,
} from "../instructions-selection";
import {
	indexRepositoryTree,
	type RepositoryTreeEntry,
	type RepositoryTreeIndex,
} from "../repository-tree";

type Setup = {
	entries: RepositoryTreeEntry[];
	root: string | null;
	saved?: readonly string[] | null;
	edits?: ExclusionEdits;
	ignoreFile?: InstructionsIgnoreFile;
	settingsFailed?: boolean;
	/** `undefined` saved list: the settings are still loading. */
	loading?: boolean;
};

function build(setup: Setup): {
	model: InstructionsSelectionModel;
	tree: RepositoryTreeIndex;
	selection: InstructionsSelection;
	saved: readonly string[] | null;
} {
	const tree = indexRepositoryTree(setup.entries);
	const selection = {
		root: setup.root,
		edits: setup.edits ?? NO_EXCLUSION_EDITS,
	};
	const saved = setup.saved ?? null;
	return {
		tree,
		selection,
		saved,
		model: instructionsSelectionModel({
			tree,
			selection,
			savedGlobs: setup.loading ? undefined : saved,
			settingsFailed: setup.settingsFailed ?? false,
			ignoreFile: setup.ignoreFile ?? { kind: "none" },
		}),
	};
}

function node(tree: RepositoryTreeIndex, path: string) {
	const found = tree.nodes.get(path);
	if (!found) {
		throw new Error(`no node ${path}`);
	}
	return found;
}

/** The row, and what its click does, for `path`. */
function rowOf(built: ReturnType<typeof build>, path: string) {
	const n = node(built.tree, path);
	return {
		...built.model.row(n),
		action: built.model.actionFor(n),
	};
}

/** The selection after clicking `path`, then the model rebuilt on it. */
function click(
	setup: Setup,
	path: string,
): { selection: InstructionsSelection; after: ReturnType<typeof build> } {
	const built = build(setup);
	const action = rowOf(built, path).action;
	if (!action) {
		throw new Error(`${path} cannot be clicked`);
	}
	const selection = applyInstructionsAction(built.selection, action);
	return {
		selection,
		after: build({
			...setup,
			root: selection.root,
			edits: selection.edits,
		}),
	};
}

const AGENTS: RepositoryTreeEntry[] = [
	{ path: "agents", type: "dir" },
	{ path: "agents/CLAUDE.md", type: "file" },
	{ path: "agents/skills", type: "dir" },
	{ path: "agents/skills/review.md", type: "file" },
	{ path: "agents/drafts", type: "dir" },
	{ path: "agents/drafts/idea.md", type: "file" },
	{ path: "agents/notes.jsonl", type: "file" },
	{ path: "tools", type: "dir" },
	{ path: "tools/claude", type: "dir" },
	{ path: "tools/claude/run.md", type: "file" },
	{ path: "README.md", type: "file" },
];

describe("membership: files by the sync's own matcher", () => {
	it("keeps a file no rule matches and leaves out one a rule does, naming the rule", () => {
		const built = build({ entries: AGENTS, root: "agents", saved: null });
		expect(rowOf(built, "agents/CLAUDE.md")).toMatchObject({
			membership: "in",
			disabledReason: null,
		});
		// `**/*.jsonl` is a default rule: out, and not the tree's to change.
		expect(rowOf(built, "agents/notes.jsonl")).toMatchObject({
			membership: "out",
			disabledReason: {
				key: "tree.selection.cause.default",
				values: { rule: "**/*.jsonl" },
			},
			action: null,
		});
	});

	it("judges each file on its own path, never by the six-probe folder heuristic", () => {
		// Every probe name a folder heuristic would try (`a`, `.b`, `c.md`)
		// is matched, yet `docs/real.md` is kept: the folder is only mixed.
		const entries: RepositoryTreeEntry[] = [
			{ path: "docs", type: "dir" },
			{ path: "docs/a.txt", type: "file" },
			{ path: "docs/.b", type: "file" },
			{ path: "docs/c.md", type: "file" },
			{ path: "docs/real.md", type: "file" },
		];
		const built = build({
			entries,
			root: "",
			saved: ["docs/a**", "docs/.**", "docs/c**"],
		});
		expect(rowOf(built, "docs/real.md").membership).toBe("in");
		expect(rowOf(built, "docs/a.txt").membership).toBe("out");
		expect(rowOf(built, "docs").membership).toBe("mixed");
		expect(built.model.includedFileCount).toBe(1);
	});

	it("leaves a symbolic link out before any rule, even while the rules are unknown", () => {
		const entries: RepositoryTreeEntry[] = [
			{ path: "linked.md", type: "file", regular: false },
			{ path: "real.md", type: "file" },
		];
		const built = build({ entries, root: "", loading: true });
		expect(rowOf(built, "linked.md")).toMatchObject({
			membership: "out",
			disabledReason: { key: "tree.selection.notRegular" },
			action: null,
		});
		expect(rowOf(built, "real.md")).toMatchObject({
			membership: "unknown",
			disabledReason: { key: "tree.selection.cantTellYet" },
		});
	});

	it("shows case-insensitive siblings truthfully: excluding Guide.md also leaves guide.md out, and either re-tick brings both back", () => {
		const entries: RepositoryTreeEntry[] = [
			{ path: "docs", type: "dir" },
			{ path: "docs/Guide.md", type: "file" },
			{ path: "docs/guide.md", type: "file" },
			{ path: "docs/other.md", type: "file" },
		];
		const setup: Setup = { entries, root: "", saved: ["docs/Guide.md"] };
		const built = build(setup);
		for (const path of ["docs/Guide.md", "docs/guide.md"]) {
			expect(rowOf(built, path)).toMatchObject({
				membership: "out",
				disabledReason: null,
				action: { type: "removeRules", rules: ["docs/Guide.md"] },
			});
		}
		const { after } = click(setup, "docs/guide.md");
		expect(rowOf(after, "docs/Guide.md").membership).toBe("in");
		expect(rowOf(after, "docs/guide.md").membership).toBe("in");
		expect(after.model.removedSavedRules).toEqual(["docs/Guide.md"]);
	});

	it("matches a saved rule by sameRule: another case and a leading ./ are still the row's own rule", () => {
		const entries: RepositoryTreeEntry[] = [
			{ path: "docs", type: "dir" },
			{ path: "docs/guide.md", type: "file" },
			{ path: "docs/keep.md", type: "file" },
		];
		const setup: Setup = {
			entries,
			root: "",
			saved: ["./Docs/Guide.MD"],
		};
		expect(rowOf(build(setup), "docs/guide.md")).toMatchObject({
			membership: "out",
			action: { type: "removeRules", rules: ["./Docs/Guide.MD"] },
		});
		const { after } = click(setup, "docs/guide.md");
		expect(rowOf(after, "docs/guide.md").membership).toBe("in");
		// The notice names the rule in its SAVED spelling.
		expect(after.model.removedSavedRules).toEqual(["./Docs/Guide.MD"]);
	});
});

describe("membership: folders, subtree against aggregate", () => {
	it("leaves a folder out as a whole by its own literal F/**, re-tickable, and disables what is inside it", () => {
		const built = build({
			entries: AGENTS,
			root: "agents",
			saved: ["drafts/**"],
		});
		expect(rowOf(built, "agents/drafts")).toMatchObject({
			membership: "out",
			disabledReason: null,
			action: { type: "removeRules", rules: ["drafts/**"] },
		});
		expect(rowOf(built, "agents/drafts/idea.md")).toMatchObject({
			membership: "out",
			disabledReason: {
				key: "tree.selection.leftOutBecause",
				values: { path: "agents/drafts" },
			},
			action: null,
		});
	});

	it("leaves a folder out as a whole by a default subtree rule, naming it, with everything inside disabled", () => {
		const entries: RepositoryTreeEntry[] = [
			{ path: "app", type: "dir" },
			{ path: "app/node_modules", type: "dir" },
			{ path: "app/node_modules/pkg", type: "dir" },
			{ path: "app/node_modules/pkg/index.md", type: "file" },
			{ path: "app/main.md", type: "file" },
		];
		const built = build({ entries, root: "", saved: null });
		const reason = {
			key: "tree.selection.cause.default",
			values: { rule: "**/node_modules/**" },
		};
		expect(rowOf(built, "app/node_modules")).toMatchObject({
			membership: "out",
			disabledReason: reason,
			action: null,
		});
		expect(rowOf(built, "app/node_modules/pkg/index.md")).toMatchObject({
			membership: "out",
			disabledReason: reason,
		});
		// A default skip never makes the folder above it mixed.
		expect(rowOf(built, "app").membership).toBe("in");
	});

	it("makes a folder mixed only for a member rule, and in when only defaults leave something out", () => {
		const built = build({
			entries: AGENTS,
			root: "agents",
			saved: ["skills/review.md", ...DEFAULT_IGNORE_GLOBS],
		});
		expect(rowOf(built, "agents/skills").membership).toBe("out");
		// `agents/notes.jsonl` is out by the default `**/*.jsonl`, which
		// a project that set its own list still keeps as a default.
		expect(rowOf(built, "agents/notes.jsonl").disabledReason).toEqual({
			key: "tree.selection.cause.project",
			values: { rule: "**/*.jsonl" },
		});
		expect(rowOf(built, "agents").membership).toBe("mixed");
	});

	it("keeps a one-file folder's file re-tickable when the file alone is left out (R1): aggregate out, never a subtree claim", () => {
		const entries: RepositoryTreeEntry[] = [
			{ path: "docs", type: "dir" },
			{ path: "docs/guide.md", type: "file" },
			{ path: "other.md", type: "file" },
		];
		const setup: Setup = { entries, root: "", saved: null };
		const { selection, after } = click(setup, "docs/guide.md");
		expect(selection.edits.add).toEqual(["docs/guide.md"]);
		expect(rowOf(after, "docs")).toMatchObject({
			membership: "out",
			disabledReason: null,
			note: {
				key: "tree.selection.everythingListedLeftOut",
				values: { path: "docs" },
			},
			action: { type: "removeRules", rules: ["docs/guide.md"] },
		});
		expect(rowOf(after, "docs/guide.md")).toMatchObject({
			membership: "out",
			disabledReason: null,
			action: { type: "removeRules", rules: ["docs/guide.md"] },
		});
		// Re-ticking the file cancels the staged rule.
		const back = applyInstructionsAction(
			selection,
			rowOf(after, "docs/guide.md").action as InstructionsAction,
		);
		expect(back.edits).toEqual(NO_EXCLUSION_EDITS);
	});

	it("does the same for its truncated-listing twin, where the folder may hold more than the listing shows", () => {
		const entries: RepositoryTreeEntry[] = [
			{ path: "docs", type: "dir" },
			{ path: "docs/guide.md", type: "file" },
		];
		const built = build({ entries, root: "", saved: ["docs/guide.md"] });
		expect(rowOf(built, "docs").membership).toBe("out");
		expect(rowOf(built, "docs").disabledReason).toBeNull();
		expect(rowOf(built, "docs/guide.md")).toMatchObject({
			membership: "out",
			disabledReason: null,
		});
		expect(
			instructionsSummary({
				model: built.model,
				listing: "ready",
				truncated: true,
			}).count,
		).toEqual({ key: "summary.matchTruncated", values: { count: 0 } });
	});

	it("disables an aggregate-out folder whose files are all left out by rules the tree cannot change", () => {
		const entries: RepositoryTreeEntry[] = [
			{ path: "logs", type: "dir" },
			{ path: "logs/run.jsonl", type: "file" },
			{ path: "keep.md", type: "file" },
		];
		const built = build({ entries, root: "", saved: null });
		expect(rowOf(built, "logs")).toMatchObject({
			membership: "out",
			disabledReason: {
				key: "tree.selection.everythingListedLeftOut",
				values: { path: "logs" },
			},
			action: null,
		});
	});
});

describe("the CI transition table", () => {
	it("folder outside the root, or any folder with no root: tick moves the root there and drops the staged edits", () => {
		const edits: ExclusionEdits = { add: ["skills/**"], remove: [] };
		const moved = click(
			{ entries: AGENTS, root: "agents", edits },
			"tools/claude",
		).selection;
		expect(moved).toEqual({
			root: "tools/claude",
			edits: NO_EXCLUSION_EDITS,
		});
		expect(
			click({ entries: AGENTS, root: null }, "tools").selection,
		).toEqual({ root: "tools", edits: NO_EXCLUSION_EDITS });
		// A file outside the root can never be ticked.
		expect(
			rowOf(build({ entries: AGENTS, root: null }), "README.md"),
		).toEqual({
			membership: "out",
			disabledReason: { key: "tree.selection.syncsAFolder" },
			action: null,
		});
		// Folders on the way to the root are outside it too.
		expect(
			rowOf(build({ entries: AGENTS, root: "tools/claude" }), "tools"),
		).toMatchObject({
			membership: "out",
			action: { type: "setRoot", root: "tools" },
		});
	});

	it("the root row, in: untick clears the root and the staged edits, as Select none does", () => {
		const built = build({ entries: AGENTS, root: "agents", saved: [] });
		expect(rowOf(built, "agents")).toMatchObject({
			membership: "in",
			disabledReason: null,
			action: SELECT_NONE_INSTRUCTIONS,
		});
		expect(
			applyInstructionsAction(
				{ root: "agents", edits: { add: ["x/**"], remove: [] } },
				SELECT_NONE_INSTRUCTIONS,
			),
		).toEqual({ root: null, edits: NO_EXCLUSION_EDITS });
	});

	it("the root row or a folder inside it, mixed: tick removes every rule, saved or staged, that is a listed row's own pattern at or under it", () => {
		const setup: Setup = {
			entries: AGENTS,
			root: "agents",
			saved: ["./Drafts/**", "dist/**"],
			edits: { add: ["skills/review.md"], remove: [] },
		};
		const built = build(setup);
		expect(rowOf(built, "agents")).toMatchObject({
			membership: "mixed",
			action: {
				type: "removeRules",
				rules: ["./Drafts/**", "skills/review.md"],
			},
		});
		const { selection, after } = click(setup, "agents");
		// The staged addition is cancelled; the saved rule's removal is
		// staged, in its own spelling; `dist/**` names no listed row.
		expect(selection.edits).toEqual({
			add: [],
			remove: ["./Drafts/**"],
		});
		expect(rowOf(after, "agents").membership).toBe("in");
		expect(after.model.removedSavedRules).toEqual(["./Drafts/**"]);
	});

	it("a mixed tick is allowed at the full 200-rule budget: removing never checks capacity", () => {
		const filler = Array.from(
			{ length: PROJECT_IGNORE_GLOB_LIMITS.maxGlobs - 1 },
			(_, i) => `filler-${i}/**`,
		);
		const setup: Setup = {
			entries: AGENTS,
			root: "agents",
			saved: [...filler, "drafts/**"],
		};
		const built = build(setup);
		expect(rowOf(built, "agents").action).toEqual({
			type: "removeRules",
			rules: ["drafts/**"],
		});
		// Adding one more is refused at the budget.
		expect(rowOf(built, "agents/skills")).toMatchObject({
			membership: "in",
			disabledReason: {
				key: "tree.selection.full",
				values: { max: PROJECT_IGNORE_GLOB_LIMITS.maxGlobs },
			},
			action: null,
		});
	});

	it("inside the root, in: untick adds its toggle pattern (F/** for a folder, the relative path for a file)", () => {
		const setup: Setup = { entries: AGENTS, root: "agents", saved: [] };
		expect(rowOf(build(setup), "agents/skills").action).toEqual({
			type: "addRule",
			pattern: "skills/**",
			coveredFolder: "skills",
		});
		expect(rowOf(build(setup), "agents/CLAUDE.md").action).toEqual({
			type: "addRule",
			pattern: "CLAUDE.md",
			coveredFolder: null,
		});
		const { selection, after } = click(setup, "agents/skills");
		expect(selection.edits).toEqual({ add: ["skills/**"], remove: [] });
		expect(rowOf(after, "agents/skills")).toMatchObject({
			membership: "out",
			action: { type: "removeRules", rules: ["skills/**"] },
		});
		expect(rowOf(after, "agents").membership).toBe("mixed");
	});

	it("unticking a folder drops the staged additions beneath it that its pattern covers, in any case", () => {
		expect(
			applyInstructionsAction(
				{
					root: "agents",
					edits: {
						add: ["skills/review.md", "Skills/deep/**", "tools/**"],
						remove: ["kept/**"],
					},
				},
				{
					type: "addRule",
					pattern: "skills/**",
					coveredFolder: "skills",
				},
			).edits,
		).toEqual({ add: ["tools/**", "skills/**"], remove: ["kept/**"] });
	});

	it("inside the root, out by its own toggle pattern: tick removes that rule", () => {
		const setup: Setup = {
			entries: AGENTS,
			root: "agents",
			saved: ["skills/**"],
		};
		const { selection, after } = click(setup, "agents/skills");
		expect(selection.edits).toEqual({ add: [], remove: ["skills/**"] });
		expect(rowOf(after, "agents/skills").membership).toBe("in");
		expect(stagedProjectGlobs(["skills/**"], selection.edits)).toEqual([]);
	});

	it("inside a subtree-out folder: disabled, 'Left out because F is unticked'", () => {
		const built = build({
			entries: AGENTS,
			root: "agents",
			saved: ["skills/**"],
		});
		expect(rowOf(built, "agents/skills/review.md")).toEqual({
			membership: "out",
			disabledReason: {
				key: "tree.selection.leftOutBecause",
				values: { path: "agents/skills" },
			},
			action: null,
		});
	});

	it("a partial row whose rules the tree cannot change offers no click: disabled, naming the rule (never unticked, never the root cleared)", () => {
		const built = build({
			entries: AGENTS,
			root: "agents",
			saved: ["**/idea.md"],
		});
		expect(rowOf(built, "agents/drafts")).toMatchObject({
			membership: "out",
			disabledReason: {
				key: "tree.selection.everythingListedLeftOut",
				values: { path: "agents/drafts" },
			},
			action: null,
		});
		expect(rowOf(built, "agents")).toMatchObject({
			membership: "mixed",
			disabledReason: {
				key: "tree.selection.partlyLeftOut.project",
				values: { rule: "**/idea.md" },
			},
			action: null,
		});
		const entries: RepositoryTreeEntry[] = [
			{ path: "docs", type: "dir" },
			{ path: "docs/a.md", type: "file" },
			{ path: "docs/b.txt", type: "file" },
		];
		const partial = build({ entries, root: "", saved: ["**/*.txt"] });
		expect(rowOf(partial, "docs")).toMatchObject({
			membership: "mixed",
			disabledReason: {
				key: "tree.selection.partlyLeftOut.project",
				values: { rule: "**/*.txt" },
			},
			action: null,
		});
		// The same folder as the root row: its click never clears the root.
		const asRoot = build({ entries, root: "docs", saved: ["**/*.txt"] });
		expect(rowOf(asRoot, "docs")).toMatchObject({
			membership: "mixed",
			disabledReason: {
				key: "tree.selection.partlyLeftOut.project",
				values: { rule: "**/*.txt" },
			},
			action: null,
		});
		// The file the rule leaves out still names it, and in-rows still untick.
		expect(rowOf(asRoot, "docs/b.txt")).toMatchObject({
			membership: "out",
			disabledReason: {
				key: "tree.selection.cause.project",
				values: { rule: "**/*.txt" },
			},
		});
		expect(rowOf(asRoot, "docs/a.md").action).toEqual({
			type: "addRule",
			pattern: "a.md",
			coveredFolder: null,
		});
	});

	it("a checked transition never removes content or adds a rule, in any row state", () => {
		const docs: RepositoryTreeEntry[] = [
			{ path: "docs", type: "dir" },
			{ path: "docs/a.md", type: "file" },
			{ path: "docs/b.txt", type: "file" },
			{ path: "docs/guides", type: "dir" },
			{ path: "docs/guides/Guide.md", type: "file" },
			{ path: "docs/guides/link.md", type: "file", regular: false },
			{ path: "docs/logs", type: "dir" },
			{ path: "docs/logs/run.jsonl", type: "file" },
			{ path: "notes", type: "dir" },
			{ path: "notes/n.md", type: "file" },
			{ path: "top.md", type: "file" },
		];
		const setups: Setup[] = [];
		for (const entries of [AGENTS, docs]) {
			for (const root of [null, "", "agents", "docs", "docs/guides"]) {
				for (const saved of [
					null,
					[],
					["**/*.txt"],
					["**/idea.md"],
					["./Drafts/**", "skills/review.md", "dist/**"],
					["guides/guide.md", "**/*.txt"],
					["docs/guides/**", "a.md"],
					["**/guides/**"],
					["skills/review.md", ...DEFAULT_IGNORE_GLOBS],
				]) {
					for (const edits of [
						NO_EXCLUSION_EDITS,
						{ add: ["drafts/**", "a.md"], remove: [] },
						{ add: [], remove: ["**/*.txt"] },
					]) {
						setups.push({ entries, root, saved, edits });
					}
				}
				setups.push(
					{
						entries,
						root,
						ignoreFile: {
							kind: "rules",
							rules: ["drafts/", "*.txt"],
						},
					},
					{ entries, root, loading: true },
					{ entries, root, settingsFailed: true },
					{ entries, root, ignoreFile: { kind: "failed" } },
				);
			}
		}
		let checkedClicks = 0;
		for (const setup of setups) {
			const built = build(setup);
			const staged = new Set(
				stagedProjectGlobs(built.saved, built.selection.edits) ?? [],
			);
			const inFiles = built.tree.files
				.filter((file) => built.model.row(file).membership === "in")
				.map((file) => file.path);
			for (const n of built.tree.nodes.values()) {
				const row = built.model.row(n);
				const action = built.model.actionFor(n);
				// Radix: a click on an empty or indeterminate box checks it.
				if (
					action === null ||
					(row.membership !== "out" && row.membership !== "mixed")
				) {
					continue;
				}
				checkedClicks++;
				const where = `${JSON.stringify(setup.saved)} root=${setup.root} ${n.path}`;
				expect(action.type, where).not.toBe("addRule");
				if (action.type === "setRoot") {
					// Ticking a folder outside the root moves the root there.
					expect(action.root, where).toBe(n.path);
					continue;
				}
				const next = applyInstructionsAction(built.selection, action);
				expect(next.root, where).toBe(built.selection.root);
				for (const rule of stagedProjectGlobs(
					built.saved,
					next.edits,
				) ?? []) {
					expect(staged.has(rule), `${where} adds ${rule}`).toBe(
						true,
					);
				}
				const after = build({ ...setup, edits: next.edits });
				for (const path of inFiles) {
					expect(
						after.model.row(node(after.tree, path)).membership,
						`${where} drops ${path}`,
					).toBe("in");
				}
			}
		}
		expect(checkedClicks).toBeGreaterThan(100);
	});
});

describe("per-operation editability", () => {
	it("refuses to add a rule for a name with * or ?, or a pattern too long to store", () => {
		const long = "x".repeat(PROJECT_IGNORE_GLOB_LIMITS.maxGlobLength);
		const entries: RepositoryTreeEntry[] = [
			{ path: "a*b.md", type: "file" },
			{ path: long, type: "dir" },
			{ path: `${long}/f.md`, type: "file" },
		];
		const built = build({ entries, root: "", saved: [] });
		expect(rowOf(built, "a*b.md")).toMatchObject({
			membership: "in",
			disabledReason: { key: "tree.selection.wildcard" },
		});
		expect(rowOf(built, long)).toMatchObject({
			membership: "in",
			disabledReason: { key: "tree.selection.tooLong" },
		});
	});

	it("counts the defaults a first custom rule copies in toward the budget", () => {
		const adds = (n: number) =>
			Array.from({ length: n }, (_, i) => `staged-${i}/**`);
		const room =
			PROJECT_IGNORE_GLOB_LIMITS.maxGlobs - DEFAULT_IGNORE_GLOBS.length;
		const full = build({
			entries: AGENTS,
			root: "agents",
			saved: null,
			edits: { add: adds(room), remove: [] },
		});
		expect(rowOf(full, "agents/CLAUDE.md").disabledReason).toEqual({
			key: "tree.selection.full",
			values: { max: PROJECT_IGNORE_GLOB_LIMITS.maxGlobs },
		});
		const oneLeft = build({
			entries: AGENTS,
			root: "agents",
			saved: null,
			edits: { add: adds(room - 1), remove: [] },
		});
		expect(rowOf(oneLeft, "agents/CLAUDE.md").disabledReason).toBeNull();
	});

	it("with a replacing .fabricignore, shows its verdicts and refuses every rule change, while the root can still move", () => {
		const built = build({
			entries: AGENTS,
			root: "agents",
			saved: ["skills/**"],
			ignoreFile: { kind: "rules", rules: ["drafts/"] },
		});
		expect(built.model.layer).toBe("fabricignore");
		expect(rowOf(built, "agents/drafts")).toMatchObject({
			membership: "out",
			disabledReason: {
				key: "tree.selection.cause.fabricignore",
				values: { rule: "drafts/" },
			},
		});
		// The project's rule does not apply; unticking is refused.
		expect(rowOf(built, "agents/skills")).toMatchObject({
			membership: "in",
			disabledReason: { key: "tree.selection.fabricignore" },
			action: null,
		});
		// Nothing the tree can remove: the partial root row names the rule.
		expect(rowOf(built, "agents")).toMatchObject({
			membership: "mixed",
			disabledReason: {
				key: "tree.selection.partlyLeftOut.fabricignore",
				values: { rule: "drafts/" },
			},
			action: null,
		});
		expect(rowOf(built, "tools").action).toEqual({
			type: "setRoot",
			root: "tools",
		});
		expect(built.model.leftOut).toEqual([]);
	});

	it("says it can't tell yet while the rules load or failed, keeps the root row in, and never counts", () => {
		for (const setup of [
			{ loading: true },
			{ settingsFailed: true },
			{ ignoreFile: { kind: "loading" } as const },
			{ ignoreFile: { kind: "failed" } as const },
		] satisfies Partial<Setup>[]) {
			const built = build({ entries: AGENTS, root: "agents", ...setup });
			expect(rowOf(built, "agents/skills")).toMatchObject({
				membership: "unknown",
				disabledReason: { key: "tree.selection.cantTellYet" },
				action: null,
			});
			expect(rowOf(built, "agents")).toMatchObject({
				membership: "in",
				action: { type: "setRoot", root: null },
			});
			expect(built.model.includedFileCount).toBeNull();
		}
		const loading = build({
			entries: AGENTS,
			root: "agents",
			loading: true,
		});
		expect(
			instructionsSummary({
				model: loading.model,
				listing: "ready",
				truncated: false,
			}).count,
		).toEqual({ key: "summary.counting" });
		const failed = build({
			entries: AGENTS,
			root: "agents",
			settingsFailed: true,
		});
		expect(
			instructionsSummary({
				model: failed.model,
				listing: "ready",
				truncated: false,
			}).count,
		).toEqual({ key: "summary.cantCount" });
	});
});

describe("Select all and Select none", () => {
	it("Select all ticks the repository root and drops the staged edits, leaving the saved rules alone", () => {
		const setup: Setup = {
			entries: AGENTS,
			root: "agents",
			saved: ["agents/drafts/**"],
			edits: { add: ["skills/**"], remove: [] },
		};
		const selection = applyInstructionsAction(
			build(setup).selection,
			SELECT_ALL_INSTRUCTIONS,
		);
		expect(selection).toEqual({ root: "", edits: NO_EXCLUSION_EDITS });
		// What the saved rules still leave out shows, re-tickable.
		const after = build({ ...setup, root: "", edits: selection.edits });
		expect(rowOf(after, "agents/drafts")).toMatchObject({
			membership: "out",
			action: { type: "removeRules", rules: ["agents/drafts/**"] },
		});
		expect(after.model.leftOut).toEqual([
			{
				path: "agents/drafts",
				type: "dir",
				rule: "agents/drafts/**",
				action: { type: "removeRules", rules: ["agents/drafts/**"] },
			},
		]);
		expect(after.model.removedSavedRules).toEqual([]);
	});

	it("Select none clears the root and the staged edits", () => {
		expect(
			applyInstructionsAction(
				{ root: "agents", edits: { add: ["a/**"], remove: ["b/**"] } },
				SELECT_NONE_INSTRUCTIONS,
			),
		).toEqual({ root: null, edits: NO_EXCLUSION_EDITS });
	});
});

describe("the summary and the count", () => {
	it("says nothing is selected while no root is ticked", () => {
		const built = build({ entries: AGENTS, root: null });
		expect(
			instructionsSummary({
				model: built.model,
				listing: "ready",
				truncated: false,
			}),
		).toEqual({
			nothingSelected: { key: "summary.nothingSelected" },
			lead: null,
			count: null,
			notes: [],
		});
	});

	it("names the folder, how many rows are left out, and the live count, without promising it", () => {
		const built = build({
			entries: AGENTS,
			root: "agents",
			saved: ["drafts/**", "CLAUDE.md"],
		});
		const summary = instructionsSummary({
			model: built.model,
			listing: "ready",
			truncated: false,
		});
		expect(summary.lead).toEqual({
			key: "summary.leadExcept",
			values: { folder: "agents", excluded: 2 },
		});
		// A project list replaces the defaults, so notes.jsonl is kept too.
		expect(summary.count).toEqual({
			key: "summary.matchNow",
			values: { count: 2 },
		});
		expect(summary.notes).toEqual([
			{ key: "summary.installedAs" },
			{ key: "summary.unreadable" },
		]);
	});

	it("words the repository root, a truncated listing, a listing in flight and no listing at all", () => {
		const root = build({ entries: AGENTS, root: "", saved: [] });
		expect(
			instructionsSummary({
				model: root.model,
				listing: "ready",
				truncated: true,
			}),
		).toMatchObject({
			lead: { key: "summary.leadRoot" },
			count: { key: "summary.matchTruncated", values: { count: 6 } },
		});
		expect(
			instructionsSummary({
				model: root.model,
				listing: "loading",
				truncated: false,
			}).count,
		).toEqual({ key: "summary.counting" });
		for (const listing of ["unsupported", "error"] as const) {
			expect(
				instructionsSummary({
					model: build({ entries: [], root: "agents" }).model,
					listing,
					truncated: false,
				}).count,
			).toBeNull();
		}
	});

	it("outside the dialog, names the folder and says the project's rules leave files out only when getSettings shows rules", () => {
		expect(
			instructionsSettingsSummary({
				rootPath: "agents",
				settings: { ignoreGlobs: ["dist/**"], defaultIgnoreGlobs: [] },
			}),
		).toEqual([
			{ key: "summary.lead", values: { folder: "agents" } },
			{ key: "summary.projectRulesLeaveOut" },
		]);
		// No setting: the defaults stand for it.
		expect(
			instructionsSettingsSummary({
				rootPath: "",
				settings: {
					ignoreGlobs: null,
					defaultIgnoreGlobs: [...DEFAULT_IGNORE_GLOBS],
				},
			}),
		).toEqual([
			{ key: "summary.leadRoot" },
			{ key: "summary.projectRulesLeaveOut" },
		]);
		// An empty list, or settings not loaded: no clause.
		expect(
			instructionsSettingsSummary({
				rootPath: "agents",
				settings: { ignoreGlobs: [], defaultIgnoreGlobs: [] },
			}),
		).toEqual([{ key: "summary.lead", values: { folder: "agents" } }]);
		expect(
			instructionsSettingsSummary({
				rootPath: "agents",
				settings: undefined,
			}),
		).toEqual([{ key: "summary.lead", values: { folder: "agents" } }]);
	});
});

/**
 * What the sync keeps, keyed by the path relative to the root. Its
 * inventory takes the root's REGULAR files only (a symbolic link is counted
 * as excluded and never planned) and its planner judges those.
 */
function syncedFiles(
	entries: RepositoryTreeEntry[],
	root: string,
	projectGlobs: readonly string[] | null,
): Set<string> {
	const files = entries
		.filter(
			(e) =>
				e.type === "file" &&
				e.regular !== false &&
				(root === "" || e.path.startsWith(`${root}/`)),
		)
		.map((e) => ({
			path: root === "" ? e.path : e.path.slice(root.length + 1),
		}));
	const result = planSnapshotFiles({
		files,
		ignore: resolveIgnoreGlobs({ projectGlobs }),
	});
	if (!result.ok) {
		if (result.refusal.code === "nothing_kept") {
			return new Set();
		}
		throw new Error(`fixture refused: ${result.refusal.code}`);
	}
	return new Set(result.kept.map((file) => file.path));
}

describe("the tree's file verdicts match what the sync keeps: its inventory, then its planner", () => {
	const FIXTURE: RepositoryTreeEntry[] = [
		{ path: "CLAUDE.md", type: "file" },
		{ path: "notes.txt", type: "file" },
		{ path: "a-b.txt", type: "file" },
		{ path: "fabric-plan.txt", type: "file" },
		{ path: "docs", type: "dir" },
		{ path: "docs/README.md", type: "file" },
		{ path: "docs/notes.txt", type: "file" },
		{ path: "docs/fabric-plan.txt", type: "file" },
		{ path: "docs/guide", type: "dir" },
		{ path: "docs/guide/intro.md", type: "file" },
		{ path: "docs/guide/setup.txt", type: "file" },
		{ path: "tools", type: "dir" },
		{ path: "tools/run.sh", type: "file" },
		{ path: "tools/fabric-cli", type: "dir" },
		{ path: "tools/fabric-cli/main.ts", type: "file" },
		{ path: "tools/fabric-cli/.env.example", type: "file" },
		{ path: "nested", type: "dir" },
		{ path: "nested/deep", type: "dir" },
		{ path: "nested/deep/keep.txt", type: "file" },
		{ path: "nested/deep/skip", type: "dir" },
		{ path: "nested/deep/skip/file.txt", type: "file" },
		{ path: "nested/deep/skip/inner", type: "dir" },
		{ path: "nested/deep/skip/inner/more.ts", type: "file" },
		{ path: "node_modules", type: "dir" },
		{ path: "node_modules/pkg", type: "dir" },
		{ path: "node_modules/pkg/index.js", type: "file" },
		// Symbolic links: no rule matches the first two, and the sync still
		// never reads them.
		{ path: "linked.md", type: "file", regular: false },
		{ path: "docs/linked-notes.txt", type: "file", regular: false },
		{ path: "nested/deep/skip/linked.ts", type: "file", regular: false },
	];

	it.each([
		[
			"the review's mixed rules",
			["**/fabric-*", "docs/*", "**/*.md", "nested/deep/skip/**"],
		],
		["**/*-*", ["**/*-*"]],
		["**/f*", ["**/f*"]],
		["**/*e", ["**/*e"]],
		["**/*obe", ["**/*obe"]],
		["the six probes", ["docs/a**", "docs/.**", "docs/c**"]],
		[
			"a folder rule and a nested one",
			["docs/**", "nested/deep/skip/inner/**"],
		],
		["the defaults (no project setting)", null],
		["an empty project list", []],
	] as const)("for %s", (_label, projectGlobs) => {
		for (const root of ["", "docs", "nested"]) {
			const built = build({
				entries: FIXTURE,
				root,
				saved: projectGlobs,
			});
			const synced = syncedFiles(FIXTURE, root, projectGlobs);
			const inRoot = built.tree.files.filter(
				(file) => root === "" || file.path.startsWith(`${root}/`),
			);
			for (const file of inRoot) {
				const relative =
					root === "" ? file.path : file.path.slice(root.length + 1);
				expect(
					built.model.row(file).membership,
					`${root}: ${relative}`,
				).toBe(synced.has(relative) ? "in" : "out");
			}
			expect(built.model.includedFileCount, `root ${root}`).toBe(
				synced.size,
			);
		}
	});
});
