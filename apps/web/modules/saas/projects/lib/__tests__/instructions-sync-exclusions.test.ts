/**
 * Folder exclusions in the Coding Instructions repository-sync configure
 * dialog (Fizzy #2726): staged edits against the saved project list, and
 * each browser row judged by the sync's own resolver and matcher.
 */
import {
	DEFAULT_IGNORE_GLOBS,
	planSnapshotFiles,
	resolveIgnoreGlobs,
} from "@repo/instructions";
import { describe, expect, it } from "vitest";
import {
	buildRepositoryTree,
	type RepositoryTreeEntry,
	type RepositoryTreeNode,
} from "../context-repository-sync-tree";
import {
	describeExclusionRow,
	type ExcludedAncestor,
	excludedAncestorForChildren,
	folderExclusionPattern,
	NO_EXCLUSION_EDITS,
	projectGlobsChanged,
	projectIgnoreListFull,
	stagedProjectGlobs,
	syncExclusionMatcher,
	toggleExclusion,
} from "../instructions-sync-exclusions";

describe("staged exclusion edits", () => {
	it("writes F/** for a folder relative to the synced folder", () => {
		expect(folderExclusionPattern("skills")).toBe("skills/**");
		expect(folderExclusionPattern("a/b")).toBe("a/b/**");
	});

	it("leaves the saved list exactly as it is while nothing is staged, a missing setting included", () => {
		expect(stagedProjectGlobs(null, NO_EXCLUSION_EDITS)).toBeNull();
		expect(stagedProjectGlobs([], NO_EXCLUSION_EDITS)).toEqual([]);
		expect(stagedProjectGlobs(["x/**"], NO_EXCLUSION_EDITS)).toEqual([
			"x/**",
		]);
	});

	it("seeds a project with no setting from the defaults, so its first exclusion drops none of them", () => {
		const edits = toggleExclusion(NO_EXCLUSION_EDITS, "skills/**", true);
		expect(stagedProjectGlobs(null, edits)).toEqual([
			...DEFAULT_IGNORE_GLOBS,
			"skills/**",
		]);
	});

	it("appends to a project's own list, an empty one included, without the defaults", () => {
		const edits = toggleExclusion(NO_EXCLUSION_EDITS, "skills/**", true);
		expect(stagedProjectGlobs([], edits)).toEqual(["skills/**"]);
		expect(stagedProjectGlobs(["dist/**"], edits)).toEqual([
			"dist/**",
			"skills/**",
		]);
	});

	it("removes exactly the folder's own rule, in any case the matcher would read as the same rule", () => {
		const edits = toggleExclusion(NO_EXCLUSION_EDITS, "skills/**", false);
		expect(
			stagedProjectGlobs(["Skills/**", "skills/*.md", "dist/**"], edits),
		).toEqual(["skills/*.md", "dist/**"]);
	});

	it("cancels a staged exclusion when it is turned back, leaving a project with no setting at none", () => {
		const on = toggleExclusion(NO_EXCLUSION_EDITS, "skills/**", true);
		const off = toggleExclusion(on, "skills/**", false);
		expect(off).toEqual({ add: [], remove: [] });
		expect(stagedProjectGlobs(null, off)).toBeNull();
	});

	it("cancels a staged removal when the folder is excluded again", () => {
		const off = toggleExclusion(NO_EXCLUSION_EDITS, "skills/**", false);
		const on = toggleExclusion(off, "SKILLS/**", true);
		expect(on).toEqual({ add: [], remove: [] });
		expect(stagedProjectGlobs(["skills/**"], on)).toEqual(["skills/**"]);
	});

	it("tells a real change from none", () => {
		expect(projectGlobsChanged(null, null)).toBe(false);
		expect(projectGlobsChanged(null, [])).toBe(true);
		expect(projectGlobsChanged([], null)).toBe(true);
		expect(projectGlobsChanged(["a/**"], ["a/**"])).toBe(false);
		expect(projectGlobsChanged(["a/**"], ["a/**", "b/**"])).toBe(true);
		expect(projectGlobsChanged(["a/**", "b/**"], ["b/**", "a/**"])).toBe(
			true,
		);
	});

	it("counts the defaults a project with no setting would start from toward the 200-rule limit", () => {
		expect(projectIgnoreListFull(null)).toBe(false);
		expect(
			projectIgnoreListFull(
				Array.from({ length: 199 }, (_, i) => `r${i}`),
			),
		).toBe(false);
		expect(
			projectIgnoreListFull(
				Array.from({ length: 200 }, (_, i) => `r${i}`),
			),
		).toBe(true);
	});
});

describe("syncExclusionMatcher", () => {
	it("lets a .fabricignore with rules replace the project's list, as the sync does", () => {
		const matcher = syncExclusionMatcher({
			fabricIgnoreRules: ["drafts/"],
			projectGlobs: ["skills/**"],
		});
		expect(matcher.layer).toBe("fabricignore");
		expect(matcher.match("drafts/a.md")).toEqual({
			rule: "drafts/",
			layer: "fabricignore",
		});
		expect(matcher.match("skills/a.md")).toBeNull();
		// The built-in rules stay first whatever the layer.
		expect(matcher.match(".git/config")?.layer).toBe("always");
	});

	it("applies the project's list, an empty one included, when there is no file", () => {
		expect(
			syncExclusionMatcher({ fabricIgnoreRules: null, projectGlobs: [] })
				.layer,
		).toBe("project");
		expect(
			syncExclusionMatcher({
				fabricIgnoreRules: null,
				projectGlobs: null,
			}).layer,
		).toBe("default");
	});
});

describe("describeExclusionRow", () => {
	function row(
		path: string,
		options: {
			type?: "file" | "dir";
			regular?: false;
			root?: string;
			projectGlobs?: readonly string[] | null;
			fabricIgnoreRules?: readonly string[] | null;
			excludedAncestor?: ExcludedAncestor | null;
			unknown?: boolean;
		} = {},
	) {
		const projectGlobs =
			options.projectGlobs === undefined ? null : options.projectGlobs;
		return describeExclusionRow({
			path,
			type: options.type ?? "dir",
			regular: options.regular,
			root: options.root ?? "",
			excludedAncestor: options.excludedAncestor ?? null,
			matcher: options.unknown
				? null
				: syncExclusionMatcher({
						fabricIgnoreRules: options.fabricIgnoreRules ?? null,
						projectGlobs,
					}),
			projectGlobs,
		});
	}

	it("shows nothing for the synced folder itself or anything outside it", () => {
		expect(row("agents", { root: "agents" })).toEqual({ kind: "outside" });
		expect(row("tools/claude", { root: "agents" })).toEqual({
			kind: "outside",
		});
		expect(row("agentsX/a", { root: "agents" })).toEqual({
			kind: "outside",
		});
	});

	it("offers a folder under the synced folder an Exclude toggle writing its path relative to that folder", () => {
		expect(row("agents/skills", { root: "agents" })).toEqual({
			kind: "included",
			toggle: { pattern: "skills/**", checked: false, block: null },
		});
	});

	it("lets the folder's own project rule be turned off", () => {
		expect(
			row("agents/skills", {
				root: "agents",
				projectGlobs: ["dist/**", "Skills/**"],
			}),
		).toEqual({
			kind: "excluded",
			cause: { via: "rule", rule: "Skills/**", layer: "project" },
			toggle: { pattern: "skills/**", checked: true, block: null },
		});
	});

	it.each([
		[
			"a default rule",
			"agents/node_modules",
			null,
			{ rule: "**/node_modules/**", layer: "default" },
		],
		[
			"a built-in rule",
			"agents/.git",
			[],
			{ rule: "**/.git/**", layer: "always" },
		],
		[
			"another project rule",
			"agents/skills",
			["skills/"],
			{ rule: "skills/", layer: "project" },
		],
		[
			"a seeded default, now a project rule",
			"agents/tasks",
			[...DEFAULT_IGNORE_GLOBS],
			{ rule: "**/tasks/**", layer: "project" },
		],
	])(
		"shows a folder skipped by %s as excluded, naming the rule, with its toggle disabled",
		(_label, path, projectGlobs, cause) => {
			expect(row(path, { root: "agents", projectGlobs })).toEqual({
				kind: "excluded",
				cause: { via: "rule", ...cause },
				toggle: {
					pattern: path.replace("agents/", "").concat("/**"),
					checked: true,
					block: "excluded",
				},
			});
		},
	);

	it("shows a folder inside a skipped one as excluded by that ancestor when the same rule skips it, its toggle disabled", () => {
		expect(
			row("agents/skills/deep", {
				root: "agents",
				projectGlobs: ["skills/**", "skills/deep/**"],
				excludedAncestor: { path: "agents/skills", rule: "skills/**" },
			}),
		).toEqual({
			kind: "excluded",
			cause: { via: "ancestor", ancestor: "agents/skills" },
			toggle: {
				pattern: "skills/deep/**",
				checked: true,
				block: "excluded",
			},
		});
	});

	it("names a row's own rule, not the folder above, when a different rule skips it", () => {
		expect(
			row("agents/skills/deep", {
				root: "agents",
				projectGlobs: ["skills/deep/**", "skills/**"],
				excludedAncestor: { path: "agents/skills", rule: "skills/**" },
			}),
		).toEqual({
			kind: "excluded",
			cause: { via: "rule", rule: "skills/deep/**", layer: "project" },
			// Locked inside the skipped folder, own rule or not.
			toggle: {
				pattern: "skills/deep/**",
				checked: true,
				block: "excluded",
			},
		});
	});

	it("never marks a row skipped just because a folder above it is: each is judged on its own path", () => {
		const ancestor = { path: "docs", rule: "docs/**" };
		// A file the rules do not match is kept, whatever the folder above.
		expect(
			row("docs/README.md", {
				type: "file",
				projectGlobs: ["**/f*"],
				excludedAncestor: ancestor,
			}),
		).toEqual({ kind: "included", toggle: null });
		expect(
			row("docs/sub", {
				projectGlobs: ["**/f*"],
				excludedAncestor: ancestor,
			}).kind,
		).toBe("included");
	});

	it("passes down the nearest folder a rule of its own skips", () => {
		const parent = { path: "agents", rule: "agents/**" };
		expect(
			excludedAncestorForChildren(
				{ kind: "included", toggle: null },
				"agents/x",
				null,
			),
		).toBeNull();
		expect(
			excludedAncestorForChildren(
				{
					kind: "excluded",
					cause: { via: "rule", rule: "x/**", layer: "project" },
					toggle: null,
				},
				"agents/x",
				null,
			),
		).toEqual({ path: "agents/x", rule: "x/**" });
		expect(
			excludedAncestorForChildren(
				{
					kind: "excluded",
					cause: { via: "ancestor", ancestor: "agents" },
					toggle: null,
				},
				"agents/x",
				parent,
			),
		).toBe(parent);
	});

	it.each([
		"**/*-*",
		"**/f*",
		"**/*e",
		"**/*obe",
		"**/fabric-*",
		"**/*.md",
		"**/.*",
		"**/?",
	])(
		"does not read a folder as skipped for %s, a rule about some files only",
		(rule) => {
			expect(row("docs", { projectGlobs: [rule] }).kind).toBe("included");
			expect(row("fabric-docs", { projectGlobs: [rule] }).kind).toBe(
				"included",
			);
		},
	);

	it.each(["docs/**", "docs/", "**/docs/**", "docs/**/*"])(
		"reads a folder as skipped for %s, a rule about the whole folder",
		(rule) => {
			expect(row("docs", { projectGlobs: [rule] }).kind).toBe("excluded");
		},
	);

	it("does not read a folder as skipped when only its own files are (docs/*), or only its subfolders' (docs/*/**)", () => {
		expect(row("docs", { projectGlobs: ["docs/*"] }).kind).toBe("included");
		expect(row("docs", { projectGlobs: ["docs/*/**"] }).kind).toBe(
			"included",
		);
		expect(
			row("docs/a.md", { type: "file", projectGlobs: ["docs/*"] }),
		).toEqual({
			kind: "excluded",
			cause: { via: "rule", rule: "docs/*", layer: "project" },
			toggle: null,
		});
	});

	it("shows a file the matcher matches as excluded, with no toggle", () => {
		expect(
			row("agents/notes.jsonl", { type: "file", root: "agents" }),
		).toEqual({
			kind: "excluded",
			cause: { via: "rule", rule: "**/*.jsonl", layer: "default" },
			toggle: null,
		});
		expect(
			row("agents/CLAUDE.md", { type: "file", root: "agents" }),
		).toEqual({ kind: "included", toggle: null });
	});

	it("matches relative to the synced folder: a root-anchored rule names the folder's own top level", () => {
		// `retro.md` is anchored to the synced folder, not the repository.
		expect(
			row("agents/retro.md", { type: "file", root: "agents" }).kind,
		).toBe("excluded");
		expect(row("agents/retro.md", { type: "file" }).kind).toBe("included");
	});

	it.each([
		["a * in its name", "agents/wild*card", "wildcard"],
		["a ? in an ancestor's name", "agents/wh?/inner", "wildcard"],
		[
			"a pattern over 256 characters",
			`agents/${"a".repeat(254)}`,
			"tooLong",
		],
	])("disables the toggle of a folder with %s", (_label, path, block) => {
		const result = row(path, { root: "agents" });
		expect(result.kind).toBe("included");
		expect(result.kind !== "outside" && result.toggle?.block).toBe(block);
	});

	it("allows a pattern of exactly 256 characters", () => {
		const result = row(`agents/${"a".repeat(253)}`, { root: "agents" });
		expect(result.kind !== "outside" && result.toggle?.block).toBeNull();
	});

	it("disables every new exclusion once the project's list is full", () => {
		const full = Array.from({ length: 200 }, (_, i) => `r${i}/**`);
		const result = row("agents/skills", {
			root: "agents",
			projectGlobs: full,
		});
		expect(result.kind !== "outside" && result.toggle?.block).toBe("full");
	});

	it("disables every toggle while a .fabricignore with rules replaces the project's list, and shows its exclusions", () => {
		const options = {
			root: "agents",
			projectGlobs: ["skills/**"],
			fabricIgnoreRules: ["drafts/"],
		};
		expect(row("agents/skills", options)).toEqual({
			kind: "included",
			toggle: {
				pattern: "skills/**",
				checked: false,
				block: "fabricignore",
			},
		});
		expect(row("agents/drafts", options)).toEqual({
			kind: "excluded",
			cause: { via: "rule", rule: "drafts/", layer: "fabricignore" },
			toggle: {
				pattern: "drafts/**",
				checked: true,
				block: "fabricignore",
			},
		});
	});

	it("shows only the folder's own rule, disabled, while what is skipped is unknown", () => {
		expect(
			row("agents/skills", {
				root: "agents",
				projectGlobs: ["skills/**"],
				unknown: true,
			}),
		).toEqual({
			kind: "unknown",
			toggle: { pattern: "skills/**", checked: true, block: "unknown" },
		});
		expect(
			row("agents/a.md", { type: "file", root: "agents", unknown: true }),
		).toEqual({ kind: "unknown", toggle: null });
	});

	describe("a file that is not a regular file (a symbolic link) — Fizzy #2726", () => {
		const skipped = {
			kind: "excluded",
			cause: { via: "notRegular" },
			toggle: null,
		};

		it("is skipped, with its own reason and no toggle, although no rule matches it", () => {
			expect(
				row("agents/linked.md", {
					type: "file",
					regular: false,
					root: "agents",
					projectGlobs: [],
				}),
			).toEqual(skipped);
			// The same path as a regular file is synced.
			expect(
				row("agents/linked.md", {
					type: "file",
					root: "agents",
					projectGlobs: [],
				}).kind,
			).toBe("included");
		});

		it("is skipped for its own reason even where a rule, or a folder above, also skips it", () => {
			expect(
				row("linked.md", {
					type: "file",
					regular: false,
					projectGlobs: ["**/*.md"],
				}),
			).toEqual(skipped);
			expect(
				row("docs/linked.md", {
					type: "file",
					regular: false,
					projectGlobs: ["docs/**"],
					excludedAncestor: { path: "docs", rule: "docs/**" },
				}),
			).toEqual(skipped);
		});

		it("is known to be skipped before the rules are", () => {
			expect(
				row("linked.md", {
					type: "file",
					regular: false,
					unknown: true,
				}),
			).toEqual(skipped);
		});

		it("shows nothing outside the synced folder", () => {
			expect(
				row("tools/linked.md", {
					type: "file",
					regular: false,
					root: "agents",
				}),
			).toEqual({ kind: "outside" });
		});

		it("is never passed down as a skipped folder", () => {
			const parent = { path: "agents", rule: "agents/**" };
			expect(
				excludedAncestorForChildren(
					{
						kind: "excluded",
						cause: { via: "notRegular" },
						toggle: null,
					},
					"agents/linked",
					parent,
				),
			).toBe(parent);
		});
	});
});

/**
 * The preview's verdict for every FILE of a listing, walked as the browser
 * renders it (each row passing `excludedAncestorForChildren` down), keyed by
 * the path relative to the synced folder.
 */
function previewFileVerdicts(
	entries: RepositoryTreeEntry[],
	root: string,
	projectGlobs: readonly string[] | null,
): Map<string, boolean> {
	const matcher = syncExclusionMatcher({
		fabricIgnoreRules: null,
		projectGlobs,
	});
	const verdicts = new Map<string, boolean>();
	const walk = (
		nodes: RepositoryTreeNode[],
		ancestor: ExcludedAncestor | null,
	) => {
		for (const node of nodes) {
			const result = describeExclusionRow({
				path: node.path,
				type: node.type,
				regular: node.regular,
				root,
				excludedAncestor: ancestor,
				matcher,
				projectGlobs,
			});
			if (node.type === "file" && result.kind !== "outside") {
				const relative =
					root === "" ? node.path : node.path.slice(root.length + 1);
				verdicts.set(relative, result.kind === "excluded");
			}
			walk(
				node.children,
				excludedAncestorForChildren(result, node.path, ancestor),
			);
		}
	};
	walk(buildRepositoryTree(entries), null);
	return verdicts;
}

/**
 * What the sync keeps, keyed the same way. Its inventory takes the synced
 * folder's REGULAR files only (`instruction-sync-tree.ts`: modes 100644 and
 * 100755) — a symbolic link is counted as excluded and never planned — and
 * its planner judges those.
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

describe("the preview's file verdicts match what the sync keeps: its inventory, then its planner", () => {
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
		// Symbolic links (GitHub mode 120000, Azure DevOps `isSymLink`): no
		// rule matches the first two, and the sync still never reads them.
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
		[
			"a folder rule and a nested one",
			["docs/**", "nested/deep/skip/inner/**"],
		],
		["the defaults (no project setting)", null],
		["an empty project list", []],
	] as const)("for %s", (_label, projectGlobs) => {
		for (const root of ["", "docs", "nested"]) {
			const verdicts = previewFileVerdicts(FIXTURE, root, projectGlobs);
			const synced = syncedFiles(FIXTURE, root, projectGlobs);
			const inRoot = FIXTURE.filter(
				(e) =>
					e.type === "file" &&
					(root === "" || e.path.startsWith(`${root}/`)),
			).length;
			expect(verdicts.size, `root ${root}`).toBe(inRoot);
			for (const [path, previewExcluded] of verdicts) {
				expect(previewExcluded, `${root}: ${path}`).toBe(
					!synced.has(path),
				);
			}
		}
	});
});
