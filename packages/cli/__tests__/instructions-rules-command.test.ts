/**
 * `fabric instructions rules`: from the published instructions to
 * `.claude/rules/fabric-<id>/` in a real git work tree, with the exclude entry
 * and the collision rule exercised through git itself.
 */
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitBlobOid } from "../src/lib/git-blob.js";

const state = vi.hoisted(() => ({
	cache: "",
	files: [] as Array<{ path: string; text: string }>,
}));

vi.mock("../src/commands/instructions/render.js", () => ({
	connectForProject: () => {
		const encode = (text: string) => new TextEncoder().encode(text);
		return {
			origin: "https://example.com",
			cacheDirectory: state.cache,
			client: {
				instructions: {
					getPublished: async () => ({
						published: true,
						sourceOfTruth: "REPOSITORY",
						direct: {
							availability: "READY",
							readState: "DIRECT",
							generation: 1,
							currentCommitSha: "a".repeat(40),
						},
					}),
					listRepositoryFiles: async () => ({
						generation: 1,
						commitSha: "a".repeat(40),
						incomplete: false,
						refusal: null,
						files: state.files.map((file) => ({
							path: file.path,
							kind: "OTHER",
							blobId: gitBlobOid(encode(file.text)),
							size: encode(file.text).length,
						})),
					}),
					readRepositoryFiles: async (
						_project: string,
						input: { paths: string[] },
					) => ({
						generation: 1,
						commitSha: "a".repeat(40),
						nextIndex: null,
						files: input.paths.map((filePath) => {
							const text =
								state.files.find(
									(file) => file.path === filePath,
								)?.text ?? "";
							return {
								path: filePath,
								read: {
									state: "found",
									text,
									size: encode(text).length,
								},
							};
						}),
					}),
				},
			},
		};
	},
}));

import { syncRulesForProject } from "../src/commands/instructions/rules.js";
import { rulesFolderFor } from "../src/lib/plugin/rules-sync.js";

const PROJECT = "cmexampleproject0123456789";
const FOLDER = rulesFolderFor(PROJECT);

let base: string;
let root: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" });

beforeEach(async () => {
	base = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-rules-cmd-")),
	);
	root = path.join(base, "project");
	await mkdir(root, { recursive: true });
	state.cache = path.join(base, "cache");
	state.files = [
		{ path: "CLAUDE.md", text: "# memory\n" },
		{
			path: "rules/style.md",
			text: "---\npaths:\n  - src/**\n---\nTabs.\n",
		},
		{ path: ".claude/rules/team/naming.md", text: "Names." },
	];
	git("init", "-q");
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

const run = () => syncRulesForProject({ project: PROJECT, root });

describe("syncRulesForProject", () => {
	it("writes the rules byte for byte below the project's rules folder, and keeps them out of git", async () => {
		const result = await run();

		expect(result.written).toEqual(["style.md", "team/naming.md"]);
		expect(
			await readFile(path.join(root, FOLDER, "style.md"), "utf8"),
		).toBe("---\npaths:\n  - src/**\n---\nTabs.\n");
		expect(git("status", "--porcelain", "-uall")).toBe("");
		expect(git("check-ignore", `${FOLDER}/style.md`).trim()).toBe(
			`${FOLDER}/style.md`,
		);
	});

	it("follows the instructions: a changed rule is rewritten, a removed one deleted", async () => {
		await run();
		state.files = [
			{ path: "rules/style.md", text: "Spaces." },
			{ path: "CLAUDE.md", text: "# memory\n" },
		];

		const result = await run();

		expect(result).toMatchObject({
			written: ["style.md"],
			removed: ["team/naming.md"],
		});
		expect(
			await readFile(path.join(root, FOLDER, "style.md"), "utf8"),
		).toBe("Spaces.");
	});

	it("skips a rule at a destination the project's own git tracks, and leaves that file as it is", async () => {
		await mkdir(path.join(root, FOLDER), { recursive: true });
		await writeFile(
			path.join(root, FOLDER, "style.md"),
			"the project's own",
		);
		git("add", "-f", FOLDER);

		const result = await run();

		expect(result.skipped).toEqual([
			{ path: "style.md", reason: "tracked" },
		]);
		expect(result.written).toEqual(["team/naming.md"]);
		expect(
			await readFile(path.join(root, FOLDER, "style.md"), "utf8"),
		).toBe("the project's own");
	});

	it("works in a folder that is not a git work tree, writing no exclude", async () => {
		await rm(path.join(root, ".git"), { recursive: true, force: true });

		const result = await run();

		expect(result.written).toHaveLength(2);
	});

	it("writes nothing and no exclude for a project without rules", async () => {
		state.files = [{ path: "CLAUDE.md", text: "# memory\n" }];

		const result = await run();

		expect(result).toMatchObject({
			written: [],
			removed: [],
			refused: null,
		});
		expect(
			await readFile(
				path.join(root, ".git", "info", "exclude"),
				"utf8",
			).catch(() => ""),
		).not.toContain("fabric-");
	});
});
