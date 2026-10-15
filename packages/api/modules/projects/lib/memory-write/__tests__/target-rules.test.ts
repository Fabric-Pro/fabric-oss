/**
 * Where a Living Memory write folder may be (ADR-022): one case per refusal
 * code, and the folders that are accepted, including the whole-repository
 * selection. The sync's own rules are the real ones: spelling, whole-segment
 * containment, the left-out paths and the default exclusions matched relative
 * to the selected path. Reserved folders (the repository root, and anything
 * with a dot-prefixed segment) are refused whatever the sync selects.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => ({
	...(await import(
		"@repo/database/prisma/queries/projects/context-source-path"
	)),
	...(await import(
		"@repo/database/prisma/queries/projects/context-repository-sync-selection"
	)),
}));

import {
	checkWriteTargetFolder,
	MAX_CONTEXT_WRITE_TARGETS,
	validateWriteTargetFolder,
} from "../target-rules";

const selection = {
	paths: ["docs", "notes/team"],
	excludedPaths: ["docs/drafts"],
};
const wholeRepository = { paths: [""], excludedPaths: [] };

function check(
	folder: string,
	overrides: {
		selection?: typeof selection;
		instructionRoots?: string[];
		siblingFolders?: string[];
	} = {},
) {
	return validateWriteTargetFolder({
		folder,
		selection: overrides.selection ?? selection,
		instructionRoots: overrides.instructionRoots ?? [],
		siblingFolders: overrides.siblingFolders ?? [],
	});
}

describe("write folders that are accepted", () => {
	it.each([
		["a folder inside a selected folder", "docs/memory", selection],
		["a selected folder itself", "docs", selection],
		[
			"a folder inside the second selected folder",
			"notes/team/out",
			selection,
		],
		["a folder inside the whole repository", "memory", wholeRepository],
		[
			"a nested folder inside the whole repository",
			"docs/ai",
			wholeRepository,
		],
		[
			"a folder with a dot inside a segment name, not at its start",
			"docs/v1.2/notes.d",
			wholeRepository,
		],
		[
			"a folder whose name only starts like a left-out one",
			"docs/drafts-2",
			selection,
		],
	])("accepts %s", (_name, folder, sel) => {
		expect(check(folder, { selection: sel })).toBeNull();
	});

	it("does not judge a selected folder by the defaults that apply inside it", () => {
		const selectedSkills = { paths: ["skills"], excludedPaths: [] };

		expect(check("skills", { selection: selectedSkills })).toBeNull();
		expect(check("skills/team", { selection: selectedSkills })).toBeNull();
	});

	it("accepts a folder next to, not inside, another target", () => {
		expect(check("docs/ab", { siblingFolders: ["docs/a"] })).toBeNull();
	});

	it("accepts a folder next to an instructions root that merely shares a prefix", () => {
		expect(
			check("docs/memory", { instructionRoots: ["docs/mem"] }),
		).toBeNull();
	});
});

describe("INVALID_PATH", () => {
	it.each([
		["a trailing slash", "docs/"],
		["a leading space", " docs"],
		["a backslash", "docs\\memory"],
		["a parent segment", "docs/../secrets"],
		["a leading ./", "./docs"],
		["an absolute path", "/docs"],
		["an empty segment", "docs//memory"],
	])("refuses %s", (_name, folder) => {
		expect(check(folder)).toMatchObject({
			code: "INVALID_PATH",
			path: folder,
		});
	});

	it("refuses a path over the length bound", () => {
		const folder = `docs/${"x".repeat(1100)}`;

		expect(check(folder)).toMatchObject({ code: "INVALID_PATH" });
	});
});

describe("TARGET_RESERVED", () => {
	it.each([
		["the repository root, under a whole-repository sync", ""],
		["a CI folder", ".github"],
		["a CI folder deeper down", ".github/workflows"],
		["another CI folder", ".gitlab"],
		["an Azure DevOps folder", ".azuredevops"],
		["a CircleCI folder", ".circleci"],
		["a dev-container folder", ".devcontainer"],
		["an editor folder", ".vscode"],
		["a git-hooks folder", ".husky"],
		["a hidden folder inside a normal one", "docs/.private/x"],
		["a hidden folder at the end", "docs/ai/.hidden"],
		["the CLI's own state folder", ".fabric"],
		["the CLI's own state folder in any case", "docs/.FABRIC/state"],
		["a tool-state folder", "docs/.claude"],
	])("refuses %s", (_name, folder) => {
		expect(check(folder, { selection: wholeRepository })).toMatchObject({
			code: "TARGET_RESERVED",
			path: folder,
		});
	});

	it("refuses the repository root whatever the sync selects", () => {
		expect(check("")).toMatchObject({ code: "TARGET_RESERVED", path: "" });
		expect(check("", { selection: wholeRepository })).toMatchObject({
			code: "TARGET_RESERVED",
			path: "",
		});
	});

	it("says why, naming the segment that is hidden", () => {
		const problem = check("docs/.private/x", {
			selection: wholeRepository,
		});

		expect(problem?.message).toContain('".private"');
		expect(problem?.message).toMatch(/CI and tool configuration/);
	});

	it("is a stale target's reason at admission too", () => {
		expect(
			checkWriteTargetFolder({
				folder: ".github",
				selection: wholeRepository,
				instructionRoots: [],
			}),
		).toMatchObject({ code: "TARGET_RESERVED" });
		expect(
			checkWriteTargetFolder({
				folder: "",
				selection: wholeRepository,
				instructionRoots: [],
			}),
		).toMatchObject({ code: "TARGET_RESERVED" });
	});

	it("still accepts a normal folder under a whole-repository sync", () => {
		expect(check("docs/ai", { selection: wholeRepository })).toBeNull();
	});
});

describe("TARGET_OUTSIDE_SELECTION", () => {
	it.each([
		["a folder no selected path contains", "other"],
		[
			"a folder that only shares a prefix with a selected path",
			"docs-archive",
		],
		["the parent of a selected folder", "notes"],
	])("refuses %s", (_name, folder) => {
		expect(check(folder)).toMatchObject({
			code: "TARGET_OUTSIDE_SELECTION",
			path: folder,
		});
	});
});

describe("TARGET_EXCLUDED", () => {
	it.each([
		["a left-out folder", "docs/drafts"],
		["a folder inside a left-out folder", "docs/drafts/old"],
		["a folder the defaults leave out (skills)", "docs/skills"],
		["a folder the defaults leave out (agents)", "notes/team/agents"],
		["a folder inside one the defaults leave out", "docs/hooks/x"],
	])("refuses %s", (_name, folder) => {
		expect(check(folder)).toMatchObject({
			code: "TARGET_EXCLUDED",
			path: folder,
		});
	});

	it("refuses a folder the defaults leave out under the whole repository", () => {
		expect(
			check("node_modules/pkg", { selection: wholeRepository }),
		).toMatchObject({
			code: "TARGET_EXCLUDED",
		});
		expect(check("scripts", { selection: wholeRepository })).toMatchObject({
			code: "TARGET_EXCLUDED",
		});
	});
});

describe("TARGET_OVERLAPS_INSTRUCTIONS", () => {
	it.each([
		["inside the instructions root", "docs/coding/x", ["docs/coding"]],
		["the instructions root itself", "docs/coding", ["docs/coding"]],
		["above the instructions root", "docs", ["docs/coding"]],
	])("refuses a folder %s", (_name, folder, instructionRoots) => {
		expect(check(folder, { instructionRoots })).toMatchObject({
			code: "TARGET_OVERLAPS_INSTRUCTIONS",
			path: folder,
			withPath: instructionRoots[0],
		});
	});

	it("refuses every folder when the instructions are read from the repository root", () => {
		expect(check("docs/memory", { instructionRoots: [""] })).toMatchObject({
			code: "TARGET_OVERLAPS_INSTRUCTIONS",
			withPath: "",
		});
		expect(
			check("docs", {
				selection: wholeRepository,
				instructionRoots: ["docs/x"],
			}),
		).toMatchObject({
			code: "TARGET_OVERLAPS_INSTRUCTIONS",
			withPath: "docs/x",
		});
	});

	it("is checked by the stale check too", () => {
		expect(
			checkWriteTargetFolder({
				folder: "docs/coding/x",
				selection,
				instructionRoots: ["docs/coding"],
			}),
		).toMatchObject({ code: "TARGET_OVERLAPS_INSTRUCTIONS" });
	});
});

describe("TARGET_OVERLAP", () => {
	it.each([
		["the same folder", "docs/a", "docs/a"],
		["a folder inside another target", "docs/a/b", "docs/a"],
		["a folder that contains another target", "docs", "docs/a"],
	])("refuses %s", (_name, folder, sibling) => {
		expect(check(folder, { siblingFolders: [sibling] })).toMatchObject({
			code: "TARGET_OVERLAP",
			path: folder,
			withPath: sibling,
		});
	});

	it("is not part of the stale check: other targets cannot change under admission", () => {
		expect(
			checkWriteTargetFolder({
				folder: "docs/a",
				selection,
				instructionRoots: [],
			}),
		).toBeNull();
	});
});

describe("TOO_MANY_TARGETS", () => {
	const others = (count: number) =>
		Array.from({ length: count }, (_, i) => `docs/t${i}`);

	it("refuses an eleventh folder", () => {
		expect(
			check("docs/new", {
				siblingFolders: others(MAX_CONTEXT_WRITE_TARGETS),
			}),
		).toMatchObject({ code: "TOO_MANY_TARGETS", path: "docs/new" });
	});

	it("accepts the tenth", () => {
		expect(
			check("docs/new", {
				siblingFolders: others(MAX_CONTEXT_WRITE_TARGETS - 1),
			}),
		).toBeNull();
	});
});

describe("the order of refusals", () => {
	it("names the spelling before the selection", () => {
		expect(check("other/")).toMatchObject({ code: "INVALID_PATH" });
	});

	it("names a reserved folder before the selection, the instructions and the other targets", () => {
		expect(check(".github")).toMatchObject({ code: "TARGET_RESERVED" });
		expect(check("")).toMatchObject({ code: "TARGET_RESERVED" });
		expect(
			check("docs/.hidden", {
				instructionRoots: ["docs"],
				siblingFolders: ["docs/.hidden"],
			}),
		).toMatchObject({ code: "TARGET_RESERVED" });
		expect(check("docs/.hidden/")).toMatchObject({ code: "INVALID_PATH" });
	});

	it("names the selection before the exclusion and the exclusion before the overlaps", () => {
		expect(check("other/skills")).toMatchObject({
			code: "TARGET_OUTSIDE_SELECTION",
		});
		expect(
			check("docs/skills", {
				instructionRoots: ["docs"],
				siblingFolders: ["docs"],
			}),
		).toMatchObject({ code: "TARGET_EXCLUDED" });
		expect(
			check("docs/a", {
				instructionRoots: ["docs"],
				siblingFolders: ["docs/a"],
			}),
		).toMatchObject({ code: "TARGET_OVERLAPS_INSTRUCTIONS" });
	});
});
