import { describe, expect, it } from "vitest";
import {
	ALWAYS_IGNORE_GLOBS,
	buildIgnoreMatcher,
	compileIgnore,
	DEFAULT_IGNORE_GLOBS,
	parseFabricIgnore,
	resolveIgnoreGlobs,
} from "../src/ignore";

describe("compileIgnore", () => {
	const isIgnored = compileIgnore([
		...ALWAYS_IGNORE_GLOBS,
		...DEFAULT_IGNORE_GLOBS,
	]);

	it.each([
		[".git/HEAD", "always"],
		["node_modules/x/index.js", "default"],
		["tasks/88335/notes.md", "default"],
		["metrics/phase-gate-log.jsonl", "default"],
		["retro.md", "default"],
		["deep/nested/file.jsonl", "default"],
		[".claude/settings.local.json", "always"],
		[".codex/hooks.json", "always"],
		["areas/.DS_Store", "default"],
	] as const)("%s is ignored by the %s layer", (path, layer) => {
		const m = isIgnored(path);
		expect(m?.layer).toBe(layer);
	});

	it.each([
		".claude/skills/x/SKILL.md",
		"CLAUDE.md",
		"scripts/run-node.sh",
		"retro-notes/index.md",
		"my-tasks.md",
	])("%s is kept", (path) => {
		expect(isIgnored(path)).toBeNull();
	});

	// M2: the built-in rules name a KIND of directory, so they must match
	// wherever that directory appears. Root-anchoring them (correct for a
	// user-authored .fabricignore line) silently reduced them to the top
	// level, and a vendored `.git/config` can hold a credentialed remote URL.
	it.each([
		["apps/web/node_modules/pkg/index.js", "default"],
		["vendor/submodule/.git/config", "always"],
		["apps/api/tasks/2026/notes.md", "default"],
		["services/worker/metrics/run.json", "default"],
		["tools/.playwright-mcp/trace.zip", "default"],
	] as const)("%s is ignored at depth by the %s layer", (path, layer) => {
		expect(isIgnored(path)?.layer).toBe(layer);
	});

	// The counterpart: a rule naming one specific file at the top of a
	// repository stays root-anchored, so ordinary content is not swept up.
	it.each([
		"docs/retro.md",
		"packages/x/.claude/settings.local.json",
		"packages/x/.codex/hooks.json",
	])(
		"%s is kept, because a root-anchored built-in stays root-anchored",
		(path) => {
			expect(isIgnored(path)).toBeNull();
		},
	);

	it("matches a bare name at the root only when the glob has no slash and no **", () => {
		const m = compileIgnore(["retro.md"]);
		expect(m("retro.md")).not.toBeNull();
		expect(m("docs/retro.md")).toBeNull();
	});

	it("supports a trailing / directory form", () => {
		const m = compileIgnore(["tasks/"]);
		expect(m("tasks/a/b.md")).not.toBeNull();
		expect(m("tasks")).toBeNull();
	});
});

describe("parseFabricIgnore", () => {
	it("ignores blank lines and comments and trims", () => {
		expect(
			parseFabricIgnore("# history\n\n tasks/ \nmetrics/**\n"),
		).toEqual(["tasks/", "metrics/**"]);
	});
	it("drops negation lines (unsupported in v1)", () => {
		expect(parseFabricIgnore("tasks/\n!tasks/keep.md")).toEqual(["tasks/"]);
	});
});

describe("resolveIgnoreGlobs", () => {
	it("prefers .fabricignore, then project globs, then defaults", () => {
		expect(
			resolveIgnoreGlobs({
				fabricIgnoreText: "tasks/",
				projectGlobs: ["x/**"],
			}),
		).toEqual({ globs: ["tasks/"], layer: "fabricignore" });
		expect(
			resolveIgnoreGlobs({
				fabricIgnoreText: null,
				projectGlobs: ["x/**"],
			}),
		).toEqual({ globs: ["x/**"], layer: "project" });
		expect(resolveIgnoreGlobs({})).toEqual({
			globs: [...DEFAULT_IGNORE_GLOBS],
			layer: "default",
		});
	});
	// Minor 1 (round 4). `updateSettings` accepts `ignoreGlobs: []` and the
	// settings dialog documents it as a project list that excludes nothing, but
	// the resolver selected the project layer only when the array was NON-EMPTY
	// — so an API client that had explicitly asked for no exclusions got the
	// full default set, and the snapshot froze `layer: "default"`, which the tab
	// then quoted back as the reason files had been dropped.
	it("distinguishes an absent project list from an explicitly empty one", () => {
		expect(
			resolveIgnoreGlobs({ fabricIgnoreText: null, projectGlobs: [] }),
		).toEqual({ globs: [], layer: "project" });
		expect(
			resolveIgnoreGlobs({ fabricIgnoreText: null, projectGlobs: null }),
		).toEqual({ globs: [...DEFAULT_IGNORE_GLOBS], layer: "default" });
		expect(
			resolveIgnoreGlobs({
				fabricIgnoreText: null,
				projectGlobs: undefined,
			}),
		).toEqual({ globs: [...DEFAULT_IGNORE_GLOBS], layer: "default" });
	});

	// The always-rules are not configurable, so "excludes nothing" still means
	// `.git/` and friends stay out: an empty project list drops the DEFAULT
	// exclusions only.
	it("keeps the always-rules under an explicitly empty project list", () => {
		const m = buildIgnoreMatcher(
			resolveIgnoreGlobs({ fabricIgnoreText: null, projectGlobs: [] }),
		);
		expect(m(".git/config")).toEqual({
			rule: "**/.git/**",
			layer: "always",
		});
		// `node_modules/**` is a DEFAULT rule, and defaults are exactly what an
		// empty project list turns off.
		expect(m("node_modules/pkg/index.js")).toBeNull();
	});

	it.each([
		{ fabricIgnoreText: null, projectGlobs: [] as string[] },
		{ fabricIgnoreText: "docs/\n", projectGlobs: ["dist/**"] },
	])(
		"keeps init-owned hook files excluded for %# despite configurable exclusions",
		(input) => {
			const m = buildIgnoreMatcher(resolveIgnoreGlobs(input));
			for (const hookPath of [
				".claude/settings.local.json",
				".codex/hooks.json",
			]) {
				expect(m(hookPath)).toEqual({
					rule: hookPath,
					layer: "always",
				});
			}
			expect(m("packages/x/.claude/settings.local.json")).toBeNull();
			expect(m("packages/x/.codex/hooks.json")).toBeNull();
		},
	);

	it("treats an empty .fabricignore as absent", () => {
		expect(
			resolveIgnoreGlobs({ fabricIgnoreText: "# nothing\n" }).layer,
		).toBe("default");
	});
	it("buildIgnoreMatcher puts the always-rules first and tags the resolved layer", () => {
		const m = buildIgnoreMatcher(
			resolveIgnoreGlobs({ fabricIgnoreText: "docs/\n" }),
		);
		expect(m(".git/config")).toEqual({
			rule: "**/.git/**",
			layer: "always",
		});
		expect(m("docs/a.md")).toEqual({
			rule: "docs/",
			layer: "fabricignore",
		});
		expect(m("tasks/a.md")).toBeNull();
	});
});
