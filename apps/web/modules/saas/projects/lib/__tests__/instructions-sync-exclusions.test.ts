/**
 * The Coding Instructions repository sync's exclusion machinery (Fizzy
 * #2726, #2750 §4): staged edits against the saved project list, and the
 * sync's own resolver and matcher. The selection tree's rows built on it are
 * tested in `components/repository-sync/lib/__tests__/instructions-selection.test.ts`.
 */
import { DEFAULT_IGNORE_GLOBS } from "@repo/instructions";
import { describe, expect, it } from "vitest";
import {
	folderExclusionPattern,
	NO_EXCLUSION_EDITS,
	projectGlobsChanged,
	sameRule,
	savedRulesRemovedBy,
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

	it("treats a rule as the same rule in any case, and with or without a leading ./", () => {
		expect(sameRule("./docs/guide.md", "docs/Guide.md")).toBe(true);
		expect(sameRule("Docs/**", "docs/**")).toBe(true);
		expect(sameRule("docs/**", "docs/")).toBe(false);
		expect(sameRule("docs/a.md", "docs/b.md")).toBe(false);
	});

	it("names the saved rules the staged edits remove, in their saved spelling", () => {
		const edits = toggleExclusion(
			toggleExclusion(NO_EXCLUSION_EDITS, "docs/guide.md", false),
			"new/**",
			true,
		);
		expect(
			savedRulesRemovedBy(["./Docs/Guide.md", "dist/**"], edits),
		).toEqual(["./Docs/Guide.md"]);
		// Nothing saved, nothing removed; a staged addition is no removal.
		expect(savedRulesRemovedBy(null, edits)).toEqual([]);
		expect(
			savedRulesRemovedBy(
				["dist/**"],
				toggleExclusion(NO_EXCLUSION_EDITS, "new/**", true),
			),
		).toEqual([]);
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
