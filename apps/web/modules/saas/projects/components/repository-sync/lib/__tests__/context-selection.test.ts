/**
 * Living Memory's adapter for the shared selection tree and its one reducer
 * (Fizzy #2750 §5.7, §6, §9): every row of the transition table, the caps
 * checked after absorption, the rules judged as the run judges them (a file
 * inside a ticked folder relative to it, a directly ticked file by its
 * basename), Select all / Select none, and the summary with its count.
 */
import { describe, expect, it } from "vitest";
import { CONTEXT_SYNC_MAX_PATHS } from "../../../../lib/context-repository-sync";
import {
	applyContextAction,
	CONTEXT_SYNC_MAX_EXCLUDED_PATHS,
	type ContextAction,
	type ContextRepositoryTreeEntry,
	type ContextSelection,
	contextSelectionModel,
	contextSummary,
	contextSummaryLead,
	EMPTY_CONTEXT_SELECTION,
} from "../context-selection";
import {
	indexRepositoryTree,
	type RepositoryTreeIndex,
} from "../repository-tree";

const ENTRIES: ContextRepositoryTreeEntry[] = [
	{ path: "docs", type: "dir" },
	{ path: "docs/guide.md", type: "file" },
	{ path: "docs/logo.png", type: "file" },
	{ path: "docs/old", type: "dir" },
	{ path: "docs/old/notes.md", type: "file" },
	{ path: "docs/old/deeper", type: "dir" },
	{ path: "docs/old/deeper/a.md", type: "file" },
	{ path: "docs/skills", type: "dir" },
	{ path: "docs/skills/x.md", type: "file" },
	{
		path: "docs/.contextignore",
		type: "file",
		excludeRefusal: "EXCLUDED_PATH_POLICY_FILE",
		selectRefusal: "EXCLUDED_PATH",
	},
	{ path: "docs/linked.md", type: "file", regular: false },
	{ path: "docs/AGENTS.md", type: "file", selectRefusal: "EXCLUDED_PATH" },
	{ path: "skills", type: "dir" },
	{ path: "skills/x.md", type: "file" },
	{
		path: ".fabric",
		type: "dir",
		selectRefusal: "EXCLUDED_PATH",
		excludeRefusal: "EXCLUDED_PATH",
	},
	{
		path: ".fabric/instructions.lock",
		type: "file",
		selectRefusal: "EXCLUDED_PATH",
		excludeRefusal: "EXCLUDED_PATH",
	},
	{ path: "README.md", type: "file" },
];

function build(
	selection: ContextSelection,
	entries: ContextRepositoryTreeEntry[] = ENTRIES,
) {
	const tree = indexRepositoryTree(entries);
	return { tree, model: contextSelectionModel({ tree, selection }) };
}

function rowOf(built: ReturnType<typeof build>, path: string) {
	const node = built.tree.nodes.get(path);
	if (!node) {
		throw new Error(`no node ${path}`);
	}
	return { ...built.model.row(node), action: built.model.actionFor(node) };
}

function apply(selection: ContextSelection, action: ContextAction) {
	const result = applyContextAction(selection, action);
	if (!result.ok) {
		throw new Error(`refused: ${result.code}`);
	}
	return result.selection;
}

/** The selection after clicking `path` in the tree. */
function click(selection: ContextSelection, path: string) {
	const action = rowOf(build(selection), path).action;
	if (!action) {
		throw new Error(`${path} cannot be clicked`);
	}
	return apply(selection, action);
}

const many = (prefix: string, n: number) =>
	Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("the transition table (§5.7)", () => {
	it("out, outside every selection: tick selects it, absorbing selected and left-out paths beneath it", () => {
		expect(rowOf(build(EMPTY_CONTEXT_SELECTION), "docs")).toMatchObject({
			membership: "out",
			disabledReason: null,
			action: { type: "include", path: "docs" },
		});
		expect(click(EMPTY_CONTEXT_SELECTION, "docs")).toEqual({
			paths: ["docs"],
			excludedPaths: [],
		});
		// Absorbing: what was selected or left out beneath goes.
		expect(
			apply(
				{
					paths: ["docs/old", "docs/guide.md", "skills"],
					excludedPaths: ["docs/old/deeper"],
				},
				{ type: "include", path: "docs" },
			),
		).toEqual({ paths: ["docs", "skills"], excludedPaths: [] });
	});

	it("checks the 50-path cap only after absorbing", () => {
		const full: ContextSelection = {
			paths: many("docs/p", CONTEXT_SYNC_MAX_PATHS),
			excludedPaths: [],
		};
		expect(
			applyContextAction(full, { type: "include", path: "docs" }),
		).toEqual({
			ok: true,
			selection: { paths: ["docs"], excludedPaths: [] },
		});
		expect(
			applyContextAction(full, { type: "include", path: "skills" }),
		).toEqual({
			ok: false,
			code: "TOO_MANY_PATHS",
		});
		const built = build(full);
		expect(rowOf(built, "skills")).toMatchObject({
			membership: "out",
			disabledReason: {
				key: "tree.selection.tooManyPaths",
				values: { max: CONTEXT_SYNC_MAX_PATHS },
			},
			action: null,
		});
		// A partial folder that absorbs what it holds stays clickable.
		expect(rowOf(built, "docs")).toMatchObject({
			membership: "mixed",
			action: { type: "include", path: "docs" },
		});
	});

	it("mixed (selected paths inside it): tick selects it, the same way", () => {
		const selection: ContextSelection = {
			paths: ["docs/guide.md"],
			excludedPaths: [],
		};
		expect(rowOf(build(selection), "docs")).toMatchObject({
			membership: "mixed",
			action: { type: "include", path: "docs" },
		});
		expect(click(selection, "docs")).toEqual({
			paths: ["docs"],
			excludedPaths: [],
		});
	});

	it("in, itself selected: untick drops it and what is left out inside it", () => {
		const selection: ContextSelection = {
			paths: ["docs/old", "skills"],
			excludedPaths: [],
		};
		expect(rowOf(build(selection), "skills")).toMatchObject({
			membership: "in",
			action: { type: "unselect", path: "skills" },
		});
		expect(
			apply(
				{ paths: ["docs", "skills"], excludedPaths: ["docs/old"] },
				{ type: "unselect", path: "docs" },
			),
		).toEqual({ paths: ["skills"], excludedPaths: [] });
	});

	it("in, inside a selected folder: untick leaves it out, absorbing left-out paths beneath it", () => {
		const selection: ContextSelection = {
			paths: ["docs"],
			excludedPaths: [],
		};
		expect(rowOf(build(selection), "docs/old")).toMatchObject({
			membership: "in",
			action: { type: "exclude", path: "docs/old" },
		});
		expect(click(selection, "docs/old")).toEqual({
			paths: ["docs"],
			excludedPaths: ["docs/old"],
		});
		expect(
			apply(
				{
					paths: ["docs"],
					excludedPaths: ["docs/old/deeper", "docs/guide.md"],
				},
				{ type: "exclude", path: "docs/old" },
			),
		).toEqual({
			paths: ["docs"],
			excludedPaths: ["docs/guide.md", "docs/old"],
		});
	});

	it("checks the 200 left-out cap only after absorbing", () => {
		const full: ContextSelection = {
			paths: [""],
			excludedPaths: many("docs/old/f", CONTEXT_SYNC_MAX_EXCLUDED_PATHS),
		};
		expect(
			applyContextAction(full, { type: "exclude", path: "docs/old" }),
		).toEqual({
			ok: true,
			selection: { paths: [""], excludedPaths: ["docs/old"] },
		});
		expect(
			applyContextAction(full, { type: "exclude", path: "README.md" }),
		).toEqual({ ok: false, code: "TOO_MANY_EXCLUDED_PATHS" });
		expect(rowOf(build(full), "README.md")).toMatchObject({
			membership: "in",
			disabledReason: {
				key: "tree.selection.tooManyExcluded",
				values: { max: CONTEXT_SYNC_MAX_EXCLUDED_PATHS },
			},
			action: null,
		});
	});

	it("mixed (left-out paths beneath a selected or ticked folder): tick clears them", () => {
		const selection: ContextSelection = {
			paths: ["docs"],
			excludedPaths: ["docs/old/deeper"],
		};
		for (const path of ["docs", "docs/old"]) {
			expect(rowOf(build(selection), path)).toMatchObject({
				membership: "mixed",
				action: { type: "clearExclusionsBelow", path },
			});
		}
		expect(click(selection, "docs/old")).toEqual({
			paths: ["docs"],
			excludedPaths: [],
		});
	});

	it("out, itself left out: tick includes it again, never capped", () => {
		const selection: ContextSelection = {
			paths: [""],
			excludedPaths: [
				"docs/old",
				...many("x/f", CONTEXT_SYNC_MAX_EXCLUDED_PATHS - 1),
			],
		};
		expect(rowOf(build(selection), "docs/old")).toMatchObject({
			membership: "out",
			disabledReason: null,
			action: { type: "reinclude", path: "docs/old" },
		});
		expect(click(selection, "docs/old").excludedPaths).not.toContain(
			"docs/old",
		);
	});

	it("mixed, then clicked again once in: the second click unticks as an in row does", () => {
		let selection: ContextSelection = {
			paths: ["docs"],
			excludedPaths: ["docs/old"],
		};
		expect(rowOf(build(selection), "docs").membership).toBe("mixed");
		selection = click(selection, "docs");
		expect(rowOf(build(selection), "docs").membership).toBe("in");
		selection = click(selection, "docs");
		expect(selection).toEqual(EMPTY_CONTEXT_SELECTION);
	});

	it("inside a left-out folder: disabled, 'Left out because F is unticked'", () => {
		const selection: ContextSelection = {
			paths: ["docs"],
			excludedPaths: ["docs/old"],
		};
		for (const path of ["docs/old/notes.md", "docs/old/deeper"]) {
			expect(rowOf(build(selection), path)).toEqual({
				membership: "out",
				disabledReason: {
					key: "tree.selection.leftOutBecause",
					values: { path: "docs/old" },
				},
				action: null,
			});
		}
	});

	it("Select all selects the whole repository and clears what was left out; Select none clears both", () => {
		const selection: ContextSelection = {
			paths: ["docs"],
			excludedPaths: ["docs/old"],
		};
		expect(apply(selection, { type: "selectAll" })).toEqual({
			paths: [""],
			excludedPaths: [],
		});
		expect(apply(selection, { type: "selectNone" })).toEqual(
			EMPTY_CONTEXT_SELECTION,
		);
	});
});

describe("rows the run would never sync", () => {
	it("judges a file inside a ticked folder relative to that folder, and the same file ticked directly by its basename", () => {
		const whole = build({ paths: [""], excludedPaths: [] });
		// `skills/` is a default folder rule: relative to the ticked root.
		expect(rowOf(whole, "skills/x.md")).toMatchObject({
			membership: "out",
			disabledReason: {
				key: "tree.selection.defaultRule",
				values: { rule: "skills/" },
			},
			action: null,
		});
		expect(rowOf(whole, "skills")).toMatchObject({
			membership: "out",
			disabledReason: {
				key: "tree.selection.defaultRule",
				values: { rule: "skills/" },
			},
		});
		// Relative to a ticked `docs`, `docs/skills` is `skills/` too.
		expect(
			rowOf(
				build({ paths: ["docs"], excludedPaths: [] }),
				"docs/skills/x.md",
			).membership,
		).toBe("out");
		// Outside every selection, a file is judged by its basename only.
		const none = build(EMPTY_CONTEXT_SELECTION);
		expect(rowOf(none, "skills/x.md")).toMatchObject({
			membership: "out",
			disabledReason: null,
			action: { type: "include", path: "skills/x.md" },
		});
		const direct = build({ paths: ["skills/x.md"], excludedPaths: [] });
		expect(rowOf(direct, "skills/x.md")).toMatchObject({
			membership: "in",
			disabledReason: null,
			action: { type: "unselect", path: "skills/x.md" },
		});
		expect(direct.model.includedFileCount).toBe(1);
	});

	it("leaves out files that are not text, symbolic links, a folder's policy file and a .fabric path, each saying why", () => {
		const built = build({ paths: ["docs"], excludedPaths: [] });
		expect(rowOf(built, "docs/logo.png").disabledReason).toEqual({
			key: "tree.selection.nonText",
		});
		expect(rowOf(built, "docs/linked.md").disabledReason).toEqual({
			key: "tree.selection.symlink",
		});
		expect(rowOf(built, "docs/.contextignore").disabledReason).toEqual({
			key: "tree.selection.policyFile",
		});
		expect(
			rowOf(
				build({ paths: [""], excludedPaths: [] }),
				".fabric/instructions.lock",
			).disabledReason,
		).toEqual({
			key: "tree.selection.fabric",
		});
		for (const path of [
			"docs/logo.png",
			"docs/linked.md",
			"docs/.contextignore",
		]) {
			expect(rowOf(built, path).membership, path).toBe("out");
			expect(rowOf(built, path).action, path).toBeNull();
		}
	});

	for (const [what, path, reason] of [
		["a non-text file", "docs/logo.png", "tree.selection.nonText"],
		["a symbolic link", "docs/linked.md", "tree.selection.symlink"],
		[
			"a default-refused basename",
			"docs/AGENTS.md",
			"tree.selection.codingInstructionsFile",
		],
	] as const) {
		it(`shows ${what}, selected directly, as out, saying why, with no tree action`, () => {
			const built = build({ paths: [path], excludedPaths: [] });
			expect(rowOf(built, path)).toMatchObject({
				membership: "out",
				disabledReason: { key: reason },
				action: null,
			});
			expect(built.model.includedFileCount).toBe(0);
		});
	}

	it("refuses to tick what configure would refuse, with configure's own verdict", () => {
		const none = build(EMPTY_CONTEXT_SELECTION);
		expect(rowOf(none, "docs/AGENTS.md").disabledReason).toEqual({
			key: "tree.selection.codingInstructionsFile",
		});
		expect(rowOf(none, ".fabric").disabledReason).toEqual({
			key: "tree.selection.fabric",
		});
		expect(rowOf(none, "docs/.contextignore").disabledReason).toEqual({
			key: "tree.selection.policyFile",
		});
		expect(rowOf(none, "docs/logo.png").disabledReason).toEqual({
			key: "tree.selection.nonText",
		});
		expect(rowOf(none, "docs/linked.md").disabledReason).toEqual({
			key: "tree.selection.symlink",
		});
	});

	it("refuses to leave out what configure would refuse to leave out", () => {
		const entries: ContextRepositoryTreeEntry[] = [
			{ path: "docs", type: "dir" },
			{
				path: "docs/weird.md",
				type: "file",
				excludeRefusal: "INVALID_PATH",
			},
		];
		expect(
			rowOf(
				build({ paths: ["docs"], excludedPaths: [] }, entries),
				"docs/weird.md",
			),
		).toMatchObject({
			membership: "in",
			disabledReason: { key: "tree.selection.invalidPath" },
			action: null,
		});
	});

	it("applies the per-path rules itself to a folder the provider only implied", () => {
		const entries: ContextRepositoryTreeEntry[] = [
			{
				path: "tools/.fabric/state.json",
				type: "file",
				selectRefusal: "EXCLUDED_PATH",
				excludeRefusal: "EXCLUDED_PATH",
			},
			{ path: "tools/readme.md", type: "file" },
		];
		const built = build(EMPTY_CONTEXT_SELECTION, entries);
		expect(rowOf(built, "tools/.fabric").disabledReason).toEqual({
			key: "tree.selection.fabric",
		});
		expect(rowOf(built, "tools").disabledReason).toBeNull();
	});

	it("applies configure's spelling rules to a folder the provider only implied: a decomposed (NFD) one can be neither ticked nor left out", () => {
		const decomposed = "café";
		const entries: ContextRepositoryTreeEntry[] = [
			{
				path: `${decomposed}/a.md`,
				type: "file",
				selectRefusal: "INVALID_PATH",
				excludeRefusal: "INVALID_PATH",
			},
			{
				path: `docs/${decomposed}/b.md`,
				type: "file",
				selectRefusal: "INVALID_PATH",
				excludeRefusal: "INVALID_PATH",
			},
			{ path: "docs/c.md", type: "file" },
		];
		const none = build(EMPTY_CONTEXT_SELECTION, entries);
		expect(rowOf(none, decomposed)).toMatchObject({
			membership: "out",
			disabledReason: { key: "tree.selection.invalidPath" },
			action: null,
		});
		const docs = build({ paths: ["docs"], excludedPaths: [] }, entries);
		expect(rowOf(docs, `docs/${decomposed}`)).toMatchObject({
			membership: "in",
			disabledReason: { key: "tree.selection.invalidPath" },
			action: null,
		});
	});
});

describe("the count and the summary", () => {
	it("counts the listed files that would sync, over the whole listing", () => {
		// docs/guide.md, docs/old/notes.md, docs/old/deeper/a.md; not the
		// png, the link, the policy file, AGENTS.md or skills/x.md.
		expect(
			build({ paths: ["docs"], excludedPaths: [] }).model
				.includedFileCount,
		).toBe(3);
		expect(
			build({ paths: ["docs"], excludedPaths: ["docs/old"] }).model
				.includedFileCount,
		).toBe(1);
		expect(build(EMPTY_CONTEXT_SELECTION).model.includedFileCount).toBe(0);
		expect(
			contextSelectionModel({
				tree: null,
				selection: { paths: ["docs"], excludedPaths: [] },
			}).includedFileCount,
		).toBeNull();
	});

	function summaryOf(
		selection: ContextSelection,
		listing:
			| "idle"
			| "loading"
			| "error"
			| "unsupported"
			| "ready" = "ready",
		truncated = false,
		entries: ContextRepositoryTreeEntry[] = ENTRIES,
	) {
		const tree: RepositoryTreeIndex | null =
			listing === "ready" ? indexRepositoryTree(entries) : null;
		return contextSummary({
			model: contextSelectionModel({ tree, selection }),
			tree,
			listing,
			truncated,
		});
	}

	it("says nothing is selected while nothing is", () => {
		expect(summaryOf(EMPTY_CONTEXT_SELECTION).nothingSelected).toEqual({
			key: "summary.nothingSelected",
		});
	});

	it("names folders and files only when the listing names every selected path's type", () => {
		const selection: ContextSelection = {
			paths: ["docs/old", "README.md", "skills"],
			excludedPaths: ["docs/old/deeper"],
		};
		expect(summaryOf(selection).lead).toEqual({
			key: "summary.leadExcept",
			values: { excluded: 1 },
			fragments: {
				what: {
					key: "summary.what.foldersAndFiles",
					values: { folders: 2, files: 1 },
				},
			},
		});
		// A path the listing does not show: "selected paths".
		expect(
			summaryOf({ paths: ["docs", "unlisted"], excludedPaths: [] }).lead,
		).toEqual({
			key: "summary.lead",
			fragments: {
				what: { key: "summary.what.paths", values: { count: 2 } },
			},
		});
		// No listing at all (the status card): "selected paths" too.
		expect(
			contextSummaryLead(
				{ paths: ["docs"], excludedPaths: ["docs/old"] },
				null,
			),
		).toEqual({
			key: "summary.leadExcept",
			values: { excluded: 1 },
			fragments: {
				what: { key: "summary.what.paths", values: { count: 1 } },
			},
		});
		expect(
			contextSummaryLead({ paths: [""], excludedPaths: [] }, null),
		).toEqual({
			key: "summary.lead",
			fragments: { what: { key: "summary.what.wholeRepository" } },
		});
	});

	it("gives the live count, the truncated wording, and 'Counting…' while the listing loads", () => {
		const selection: ContextSelection = {
			paths: ["docs"],
			excludedPaths: [],
		};
		expect(summaryOf(selection).count).toEqual({
			key: "summary.matchNow",
			values: { count: 3 },
		});
		expect(summaryOf(selection, "ready", true).count).toEqual({
			key: "summary.matchTruncated",
			values: { count: 3 },
		});
		expect(summaryOf(selection, "loading").count).toEqual({
			key: "summary.counting",
		});
		expect(summaryOf(selection, "unsupported").count).toBeNull();
	});

	it("warns that a ticked folder's .contextignore may leave out more when its listing shows one, or the listing is truncated or unavailable", () => {
		const policy = { key: "summary.policyCaveat" };
		// `docs/.contextignore` is listed.
		expect(
			summaryOf({ paths: ["docs"], excludedPaths: [] }).notes,
		).toContainEqual(policy);
		// `skills` has none, and the listing is complete.
		expect(
			summaryOf({ paths: ["skills"], excludedPaths: [] }).notes,
		).not.toContainEqual(policy);
		expect(
			summaryOf({ paths: ["skills"], excludedPaths: [] }, "ready", true)
				.notes,
		).toContainEqual(policy);
		expect(
			summaryOf({ paths: ["skills"], excludedPaths: [] }, "unsupported")
				.notes,
		).toContainEqual(policy);
		// Only files ticked: no folder policy is read, and nothing is live.
		const filesOnly = summaryOf({
			paths: ["README.md"],
			excludedPaths: [],
		});
		expect(filesOnly.notes).toEqual([{ key: "summary.unreadable" }]);
		expect(summaryOf({ paths: ["docs"], excludedPaths: [] }).notes).toEqual(
			[{ key: "summary.later" }, { key: "summary.unreadable" }, policy],
		);
	});
});
