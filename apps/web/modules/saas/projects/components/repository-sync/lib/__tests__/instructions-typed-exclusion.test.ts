/**
 * Coding Instructions' typed "leave out" input, for where the tree cannot
 * reach every path: when it takes a path, the same edit unticking the row
 * stages, the refusals a tick would meet, and what the member left out
 * listed afterwards (`leftOut`), with or without a listing.
 */
import {
	DEFAULT_IGNORE_GLOBS,
	PROJECT_IGNORE_GLOB_LIMITS,
} from "@repo/instructions";
import { describe, expect, it } from "vitest";
import {
	type ExclusionEdits,
	NO_EXCLUSION_EDITS,
} from "../../../../lib/instructions-sync-exclusions";
import {
	applyInstructionsAction,
	type InstructionsIgnoreFile,
	instructionsSelectionModel,
} from "../instructions-selection";
import {
	instructionsTypedExclusion,
	instructionsTypedExclusionBlock,
} from "../instructions-typed-exclusion";
import {
	indexRepositoryTree,
	type RepositoryTreeEntry,
} from "../repository-tree";

type Setup = {
	root: string | null;
	saved?: readonly string[] | null;
	edits?: ExclusionEdits;
	ignoreFile?: InstructionsIgnoreFile;
	settingsFailed?: boolean;
	/** The settings are still loading. */
	loading?: boolean;
	/** The listing, or none (`undefined`). */
	entries?: RepositoryTreeEntry[];
};

function modelOf(setup: Setup) {
	return instructionsSelectionModel({
		tree: setup.entries ? indexRepositoryTree(setup.entries) : null,
		selection: {
			root: setup.root,
			edits: setup.edits ?? NO_EXCLUSION_EDITS,
		},
		savedGlobs: setup.loading ? undefined : (setup.saved ?? null),
		settingsFailed: setup.settingsFailed ?? false,
		ignoreFile: setup.ignoreFile ?? { kind: "none" },
	});
}

function typed(raw: string, setup: Setup) {
	return instructionsTypedExclusion({
		raw,
		model: modelOf(setup),
		savedGlobs: setup.saved ?? null,
	});
}

const AGENTS: Setup = { root: "agents" };

describe("when the typed input takes a path", () => {
	it("asks for the synced folder first", () => {
		expect(
			instructionsTypedExclusionBlock(modelOf({ root: null })),
		).toEqual({ key: "configureDialog.typedExclusion.noFolder" });
	});

	it("waits for the rules, and refuses while they are unknown", () => {
		expect(
			instructionsTypedExclusionBlock(
				modelOf({ ...AGENTS, loading: true }),
			),
		).toEqual({ key: "tree.selection.cantTellYet" });
		expect(
			instructionsTypedExclusionBlock(
				modelOf({ ...AGENTS, ignoreFile: { kind: "loading" } }),
			),
		).toEqual({ key: "tree.selection.cantTellYet" });
		for (const setup of [
			{ ...AGENTS, settingsFailed: true },
			{ ...AGENTS, ignoreFile: { kind: "failed" } as const },
		]) {
			expect(instructionsTypedExclusionBlock(modelOf(setup))).toEqual({
				key: "configureDialog.typedExclusion.rulesUnknown",
			});
		}
	});

	it("takes nothing while the folder's .fabricignore replaces the project's rules", () => {
		const setup: Setup = {
			...AGENTS,
			ignoreFile: { kind: "rules", rules: ["drafts/"] },
		};
		expect(instructionsTypedExclusionBlock(modelOf(setup))).toEqual({
			key: "configureDialog.typedExclusion.fabricignore",
		});
		expect(typed("agents/notes.md", setup)).toEqual({
			ok: false,
			message: { key: "configureDialog.typedExclusion.fabricignore" },
		});
	});

	it("takes paths under the project's rules or the defaults", () => {
		expect(instructionsTypedExclusionBlock(modelOf(AGENTS))).toBeNull();
		expect(
			instructionsTypedExclusionBlock(
				modelOf({ ...AGENTS, saved: ["dist/**"] }),
			),
		).toBeNull();
	});
});

describe("the edit a typed path stages", () => {
	it("leaves out a file by its path inside the synced folder", () => {
		expect(typed("agents/notes.md", AGENTS)).toEqual({
			ok: true,
			action: {
				type: "addRule",
				pattern: "notes.md",
				coveredFolder: null,
			},
		});
	});

	it("leaves out a folder, typed with a trailing slash, as a whole", () => {
		expect(typed("agents/drafts/", AGENTS)).toEqual({
			ok: true,
			action: {
				type: "addRule",
				pattern: "drafts/**",
				coveredFolder: "drafts",
			},
		});
	});

	it("takes the path as it is from the repository root when the whole repository syncs", () => {
		expect(typed("docs/guide.md", { root: "" })).toEqual({
			ok: true,
			action: {
				type: "addRule",
				pattern: "docs/guide.md",
				coveredFolder: null,
			},
		});
	});

	it("canonicalizes the spelling before it writes the rule", () => {
		expect(typed("  ./agents//notes.md ", AGENTS)).toEqual({
			ok: true,
			action: {
				type: "addRule",
				pattern: "notes.md",
				coveredFolder: null,
			},
		});
	});
});

describe("what a typed path is refused for", () => {
	it("asks for a path when nothing is typed", () => {
		expect(typed("   ", AGENTS)).toEqual({
			ok: false,
			message: { key: "configureDialog.typedExclusion.empty" },
		});
	});

	it("refuses a name with * or ?, which would be read as a pattern", () => {
		for (const raw of ["agents/dr*fts", "agents/note?.md"]) {
			expect(typed(raw, AGENTS), raw).toEqual({
				ok: false,
				message: { key: "tree.selection.wildcard" },
			});
		}
	});

	it("refuses a path that is not a repository path", () => {
		for (const raw of ["/agents/notes.md", "agents/../notes.md", "C:/x"]) {
			expect(typed(raw, AGENTS), raw).toEqual({
				ok: false,
				message: {
					key: "configureDialog.typedExclusion.invalid",
					values: { path: raw },
				},
			});
		}
	});

	it("refuses a path outside the synced folder, and the folder itself", () => {
		for (const raw of ["tools/run.md", "agents", "agentsx/notes.md"]) {
			const result = typed(raw, AGENTS);
			expect(result, raw).toMatchObject({
				ok: false,
				message: { key: "configureDialog.typedExclusion.outside" },
			});
		}
		expect(typed("tools/run.md", AGENTS)).toEqual({
			ok: false,
			message: {
				key: "configureDialog.typedExclusion.outside",
				values: { path: "tools/run.md", folder: "agents" },
			},
		});
	});

	it("refuses a rule longer than the project's rules can store", () => {
		const name = "x".repeat(PROJECT_IGNORE_GLOB_LIMITS.maxGlobLength + 1);
		expect(typed(`agents/${name}`, AGENTS)).toEqual({
			ok: false,
			message: { key: "tree.selection.tooLong" },
		});
	});

	it("refuses a rule already saved or staged, in any spelling the matcher reads as the same", () => {
		expect(
			typed("agents/Notes.md", { ...AGENTS, saved: ["./notes.md"] }),
		).toEqual({
			ok: false,
			message: {
				key: "configureDialog.typedExclusion.duplicate",
				values: { path: "agents/Notes.md" },
			},
		});
		expect(
			typed("agents/drafts/", {
				...AGENTS,
				edits: { add: ["drafts/**"], remove: [] },
			}),
		).toMatchObject({
			ok: false,
			message: { key: "configureDialog.typedExclusion.duplicate" },
		});
	});

	it("refuses a rule past the full list, counting the defaults a first rule copies in", () => {
		const full = Array.from(
			{ length: PROJECT_IGNORE_GLOB_LIMITS.maxGlobs },
			(_, i) => `filler-${i}/**`,
		);
		const refused = {
			ok: false,
			message: {
				key: "tree.selection.full",
				values: { max: PROJECT_IGNORE_GLOB_LIMITS.maxGlobs },
			},
		};
		expect(typed("agents/notes.md", { ...AGENTS, saved: full })).toEqual(
			refused,
		);
		// No setting yet: the first rule copies the defaults in with it.
		const room =
			PROJECT_IGNORE_GLOB_LIMITS.maxGlobs - DEFAULT_IGNORE_GLOBS.length;
		const staged = Array.from({ length: room }, (_, i) => `staged-${i}.md`);
		expect(
			typed("agents/notes.md", {
				...AGENTS,
				edits: { add: staged, remove: [] },
			}),
		).toEqual(refused);
	});
});

describe("what the member left out", () => {
	it("lists the rules this dialog staged when there is no listing, defaults aside", () => {
		const result = typed("agents/drafts/", AGENTS);
		if (!result.ok) {
			throw new Error("refused");
		}
		const selection = applyInstructionsAction(
			{ root: "agents", edits: NO_EXCLUSION_EDITS },
			result.action,
		);
		expect(modelOf({ ...AGENTS, edits: selection.edits }).leftOut).toEqual([
			{
				path: "agents/drafts",
				type: "dir",
				rule: "drafts/**",
				action: { type: "removeRules", rules: ["drafts/**"] },
			},
		]);
		const withDefault = modelOf({
			...AGENTS,
			edits: {
				add: [DEFAULT_IGNORE_GLOBS[0] ?? "", "notes.md"],
				remove: [],
			},
		});
		expect(withDefault.leftOut).toEqual([
			{
				path: "agents/notes.md",
				type: "file",
				rule: "notes.md",
				action: { type: "removeRules", rules: ["notes.md"] },
			},
		]);
	});

	it("lists nothing staged while a .fabricignore replaces the project's rules", () => {
		expect(
			modelOf({
				...AGENTS,
				edits: { add: ["notes.md"], remove: [] },
				ignoreFile: { kind: "rules", rules: ["drafts/"] },
			}).leftOut,
		).toEqual([]);
	});

	it("marks the rows the member's own rule leaves out, and no other", () => {
		const entries: RepositoryTreeEntry[] = [
			{ path: "agents", type: "dir" },
			{ path: "agents/guide.md", type: "file" },
			{ path: "agents/drafts", type: "dir" },
			{ path: "agents/drafts/idea.md", type: "file" },
			{ path: "agents/notes", type: "dir" },
			{ path: "agents/notes/today.md", type: "file" },
			{ path: "agents/notes/later.md", type: "file" },
		];
		const tree = indexRepositoryTree(entries);
		const model = modelOf({
			...AGENTS,
			entries,
			saved: ["drafts/**", "notes/today.md"],
		});
		const row = (path: string) => {
			const node = tree.nodes.get(path);
			if (!node) {
				throw new Error(`no node ${path}`);
			}
			return model.row(node);
		};
		expect(row("agents/drafts")).toMatchObject({
			membership: "out",
			leftOut: true,
		});
		expect(row("agents/notes/today.md")).toMatchObject({
			membership: "out",
			leftOut: true,
		});
		// Inside a left-out folder: out because of it, not on its own.
		expect(row("agents/drafts/idea.md").leftOut).toBeUndefined();
		expect(row("agents/guide.md").leftOut).toBeUndefined();
		expect(row("agents/notes").leftOut).toBeUndefined();
	});
});
