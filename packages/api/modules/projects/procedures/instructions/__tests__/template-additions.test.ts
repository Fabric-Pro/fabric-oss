/**
 * `planTemplateAdditions` — which files of the organization template a
 * project receives, and why each other one is left out.
 *
 * `@repo/instructions` is NOT mocked: the real path validation, secret-name
 * matcher, ignore matcher, portable-name rules and tree guard run, so the
 * skip reasons under test are the ones the procedure actually produces.
 */
import { SNAPSHOT_LIMITS } from "@repo/instructions";
import { describe, expect, it } from "vitest";
import { planTemplateAdditions } from "../change-set";

const PROJECT = "proj_target";

type IgnoreRules = Parameters<typeof planTemplateAdditions>[0]["ignore"];

const DEFAULT_RULES: IgnoreRules = { globs: ["**/tasks/**"], layer: "default" };

function file(path: string, size = 10) {
	return {
		path,
		size,
		sha256: "a".repeat(64),
		storageKey: `projects/proj_template/instructions/snapshots/snap_t/${path}`,
	};
}

function plan(
	files: ReturnType<typeof file>[],
	existingPaths: string[] = [],
	ignore: IgnoreRules = DEFAULT_RULES,
) {
	return planTemplateAdditions({
		projectId: PROJECT,
		files,
		existingPaths,
		ignore,
	});
}

describe("planTemplateAdditions", () => {
	it("adds the files the project does not have, with server-generated staging keys", () => {
		const result = plan([
			file("AGENTS.md"),
			file(".claude/skills/review/SKILL.md"),
		]);

		expect(result.skipped).toEqual([]);
		expect(result.additions.map((a) => a.change)).toEqual([
			expect.objectContaining({
				op: "put",
				path: "AGENTS.md",
				size: 10,
				sha256: "a".repeat(64),
				storageKey: `projects/${PROJECT}/instructions/staging/pending/0`,
			}),
			expect.objectContaining({
				op: "put",
				path: ".claude/skills/review/SKILL.md",
				storageKey: `projects/${PROJECT}/instructions/staging/pending/1`,
			}),
		]);
		// The source row travels with its change, so the copy knows which
		// template object to read for each staged row.
		expect(result.additions[1]?.source.storageKey).toBe(
			"projects/proj_template/instructions/snapshots/snap_t/.claude/skills/review/SKILL.md",
		);
	});

	it("lets the project's own file win, under any spelling a filesystem treats as the same", () => {
		const result = plan(
			[file("CLAUDE.md"), file("claude.md"), file("README.md")],
			["CLAUDE.md"],
		);

		expect(result.additions.map((a) => a.change.path)).toEqual([
			"README.md",
		]);
		expect(result.skipped).toEqual([
			{ path: "CLAUDE.md", reason: "exists" },
			{ path: "claude.md", reason: "exists" },
		]);
	});

	it("skips a name that is a file on one side and a folder on the other", () => {
		const result = plan(
			[file("docs"), file("notes/a.md")],
			["docs/guide.md", "notes"],
		);

		expect(result.additions).toEqual([]);
		expect(result.skipped).toEqual([
			{ path: "docs", reason: "tree_conflict" },
			{ path: "notes/a.md", reason: "tree_conflict" },
		]);
	});

	it("tolerates a colliding pair the project already holds instead of refusing", () => {
		const result = plan([file("AGENTS.md")], ["Docs.md", "docs.md"]);

		expect(result.additions.map((a) => a.change.path)).toEqual([
			"AGENTS.md",
		]);
	});

	it("never copies the template's root .fabricignore", () => {
		const result = plan([file(".fabricignore"), file("AGENTS.md")]);

		expect(result.additions.map((a) => a.change.path)).toEqual([
			"AGENTS.md",
		]);
		expect(result.skipped).toEqual([
			{ path: ".fabricignore", reason: "ignore_file" },
		]);
	});

	it("skips what the project's rules exclude, naming the rule", () => {
		const result = plan([file("tasks/1/notes.md"), file(".git/HEAD")]);

		expect(result.additions).toEqual([]);
		expect(result.skipped).toEqual([
			{
				path: "tasks/1/notes.md",
				reason: "excluded",
				rule: "**/tasks/**",
			},
			{ path: ".git/HEAD", reason: "excluded", rule: "**/.git/**" },
		]);
	});

	it("judges exclusion by the rules it is given, not the template's", () => {
		const result = plan([file("tasks/1/notes.md")], [], {
			globs: [],
			layer: "project",
		});

		expect(result.additions.map((a) => a.change.path)).toEqual([
			"tasks/1/notes.md",
		]);
	});

	it("skips credential-shaped names, unportable names, oversize files and invalid paths", () => {
		const result = plan([
			file(".env"),
			file("docs/CON.md"),
			file("big.md", SNAPSHOT_LIMITS.maxFileBytes + 1),
			file("../escape.md"),
		]);

		expect(result.additions).toEqual([]);
		expect(result.skipped).toEqual([
			{ path: ".env", reason: "secret_name" },
			{ path: "docs/CON.md", reason: "non_portable" },
			{ path: "big.md", reason: "too_large" },
			{ path: "../escape.md", reason: "invalid_path" },
		]);
	});

	it("does not let a skipped file reserve its name for the tree check", () => {
		const result = plan([file("docs/CON.md"), file("docs")]);

		// `docs/CON.md` is skipped before the tree guard, so `docs` as a file
		// does not collide with a folder that was never added.
		expect(result.additions.map((a) => a.change.path)).toEqual(["docs"]);
	});
});
