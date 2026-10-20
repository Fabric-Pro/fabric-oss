import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { excludeLocalFiles } from "../src/lib/instructions/git-exclude.js";
import {
	type ProjectRule,
	RULES_MAX_BYTES,
	RULES_MAX_FILES,
} from "../src/lib/plugin/rules.js";
import {
	rulesFolderFor,
	rulesSyncLines,
	syncProjectRules,
} from "../src/lib/plugin/rules-sync.js";

const PROJECT = "cmexampleproject0123456789";
const FOLDER = rulesFolderFor(PROJECT);
const encode = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const rule = (name: string, text: string): ProjectRule => ({
	path: name,
	source: `rules/${name}`,
	bytes: encode(text),
});
const linkType = process.platform === "win32" ? "junction" : "dir";

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(path.join(tmpdir(), "fabric-rules-")));
	root = path.join(base, "project");
	outside = path.join(base, "outside");
	await mkdir(root, { recursive: true });
	await mkdir(outside, { recursive: true });
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

const sync = (
	rules: ProjectRule[],
	extra: Partial<Parameters<typeof syncProjectRules>[0]> = {},
) => syncProjectRules({ root, projectId: PROJECT, rules, ...extra });
const read = (relative: string) =>
	readFile(path.join(root, FOLDER, relative), "utf8");
const marker = async () =>
	JSON.parse(await read(".fabric-managed.json")) as {
		version: number;
		files: Record<string, string>;
	};

describe("rulesFolderFor", () => {
	it("is .claude/rules/fabric-<id>, named like the plugin", () => {
		expect(FOLDER).toBe(".claude/rules/fabric-23456789");
	});
});

describe("writing the rules", () => {
	it("writes each rule's bytes exactly, frontmatter and line endings included, and records their hashes", async () => {
		const text = "---\r\npaths:\r\n  - src/**\r\n---\r\nBody\r\n";

		const result = await sync([
			rule("api.md", text),
			rule("team/naming.md", "naming"),
		]);

		expect(result.written).toEqual(["api.md", "team/naming.md"]);
		expect(await read("api.md")).toBe(text);
		expect(await read("team/naming.md")).toBe("naming");
		expect(await marker()).toEqual({
			version: 1,
			files: { "api.md": sha(text), "team/naming.md": sha("naming") },
		});
	});

	it("does nothing, and creates nothing, when there are no rules and never were", async () => {
		const result = await sync([]);

		expect(result).toMatchObject({
			written: [],
			removed: [],
			refused: null,
		});
		expect(await readdir(root)).toEqual([]);
	});

	it("leaves an unchanged rule alone on the next run", async () => {
		await sync([rule("a.md", "one")]);

		const again = await sync([rule("a.md", "one")]);

		expect(again).toMatchObject({ written: [], unchanged: 1, kept: [] });
	});

	it("rewrites a rule that changed in Fabric", async () => {
		await sync([rule("a.md", "one")]);

		const again = await sync([rule("a.md", "two")]);

		expect(again.written).toEqual(["a.md"]);
		expect(await read("a.md")).toBe("two");
		expect((await marker()).files["a.md"]).toBe(sha("two"));
	});
});

describe("removing what Fabric no longer has", () => {
	it("deletes a stale file that is still as Fabric wrote it, and the folders it leaves empty", async () => {
		await sync([rule("a.md", "one"), rule("sub/b.md", "two")]);

		const again = await sync([rule("a.md", "one")]);

		expect(again.removed).toEqual(["sub/b.md"]);
		await expect(read("sub/b.md")).rejects.toThrow();
		await expect(readdir(path.join(root, FOLDER, "sub"))).rejects.toThrow();
		expect(Object.keys((await marker()).files)).toEqual(["a.md"]);
	});

	it("removes the folder and the marker when the last rule goes", async () => {
		await sync([rule("a.md", "one")]);

		await sync([]);

		await expect(readdir(path.join(root, FOLDER))).rejects.toThrow();
	});

	it("keeps a stale file the person edited, says so once, and stops managing it", async () => {
		await sync([rule("a.md", "one"), rule("b.md", "two")]);
		await writeFile(path.join(root, FOLDER, "b.md"), "my own words");

		const again = await sync([rule("a.md", "one")]);
		const third = await sync([rule("a.md", "one")]);

		expect(again.removed).toEqual([]);
		expect(again.kept).toEqual([{ path: "b.md", reason: "edited" }]);
		expect(await read("b.md")).toBe("my own words");
		expect(Object.keys((await marker()).files)).toEqual(["a.md"]);
		expect(third.kept).toEqual([]);
	});

	it("keeps a file the person edited when its rule changed in Fabric", async () => {
		await sync([rule("a.md", "one")]);
		await writeFile(path.join(root, FOLDER, "a.md"), "edited");

		const again = await sync([rule("a.md", "two")]);

		expect(again.kept).toEqual([{ path: "a.md", reason: "edited" }]);
		expect(await read("a.md")).toBe("edited");
	});
});

describe("files that are not Fabric's", () => {
	it("never overwrites the person's own file at a rule's path", async () => {
		await mkdir(path.join(root, FOLDER), { recursive: true });
		await writeFile(path.join(root, FOLDER, "a.md"), "mine");

		const result = await sync([rule("a.md", "theirs")]);

		expect(result.kept).toEqual([{ path: "a.md", reason: "not-managed" }]);
		expect(await read("a.md")).toBe("mine");
		expect(rulesSyncLines(result).join("\n")).toContain("your own file");
	});

	it("adopts a file that already holds exactly the wanted bytes", async () => {
		await mkdir(path.join(root, FOLDER), { recursive: true });
		await writeFile(path.join(root, FOLDER, "a.md"), "same");

		const result = await sync([rule("a.md", "same")]);

		expect(result).toMatchObject({ unchanged: 1, kept: [] });
		expect((await marker()).files["a.md"]).toBe(sha("same"));
	});

	it("touches nothing outside its own folder, however many runs and removals", async () => {
		const mine = path.join(root, ".claude", "rules", "mine.md");
		const other = path.join(root, ".claude", "rules", "fabric-other");
		await mkdir(other, { recursive: true });
		await writeFile(mine, "mine");
		await writeFile(path.join(other, "x.md"), "other project");
		await writeFile(
			path.join(root, ".claude", "settings.local.json"),
			"{}",
		);

		await sync([rule("a.md", "one")]);
		await sync([rule("a.md", "two")]);
		await sync([]);

		expect(await readFile(mine, "utf8")).toBe("mine");
		expect(await readFile(path.join(other, "x.md"), "utf8")).toBe(
			"other project",
		);
		expect(
			await readFile(
				path.join(root, ".claude", "settings.local.json"),
				"utf8",
			),
		).toBe("{}");
		expect(
			(await readdir(path.join(root, ".claude", "rules"))).sort(),
		).toEqual(["fabric-other", "mine.md"]);
	});

	it("skips a rule the project's own git tracks at that destination", async () => {
		const result = await sync(
			[rule("a.md", "from fabric"), rule("b.md", "new")],
			{ tracked: new Set(["a.md"]) },
		);

		expect(result.skipped).toEqual([{ path: "a.md", reason: "tracked" }]);
		expect(result.written).toEqual(["b.md"]);
		await expect(read("a.md")).rejects.toThrow();
		expect(rulesSyncLines(result).join("\n")).toContain(
			"a.md, which this project's own git tracks",
		);
	});
});

describe("paths and links it refuses", () => {
	it.each([
		"../evil.md",
		"a/../../evil.md",
		"/etc/evil.md",
		"a\\..\\evil.md",
		"C:/evil.md",
		"",
	])("will not write a rule named %j", async (name) => {
		const result = await sync([rule(name, "x")]);

		expect(result.written).toEqual([]);
		expect(result.skipped).toEqual([{ path: name, reason: "unsafe-path" }]);
		expect(await readdir(outside)).toEqual([]);
		expect(await readdir(root)).toEqual([]);
	});

	it("refuses a rules folder that is a link to somewhere else", async () => {
		await mkdir(path.join(root, ".claude", "rules"), { recursive: true });
		await symlink(outside, path.join(root, FOLDER), linkType);

		const result = await sync([rule("a.md", "x")]);

		expect(result.refused).not.toBeNull();
		expect(result.written).toEqual([]);
		expect(await readdir(outside)).toEqual([]);
	});

	it("refuses a .claude folder that is a link", async () => {
		await symlink(outside, path.join(root, ".claude"), linkType);

		const result = await sync([rule("a.md", "x")]);

		expect(result.refused).not.toBeNull();
		expect(await readdir(outside)).toEqual([]);
	});

	it("will not write through a subfolder that is a link", async () => {
		await mkdir(path.join(root, FOLDER), { recursive: true });
		await symlink(outside, path.join(root, FOLDER, "sub"), linkType);

		const result = await sync([rule("sub/a.md", "x"), rule("ok.md", "y")]);

		expect(result.kept).toEqual([{ path: "sub/a.md", reason: "unsafe" }]);
		expect(result.written).toEqual(["ok.md"]);
		expect(await readdir(outside)).toEqual([]);
	});

	it("will not delete through a link planted over a managed file's folder", async () => {
		await sync([rule("sub/a.md", "x")]);
		await writeFile(path.join(outside, "a.md"), "x");
		await rm(path.join(root, FOLDER, "sub"), { recursive: true });
		await symlink(outside, path.join(root, FOLDER, "sub"), linkType);

		const result = await sync([]);

		expect(result.removed).toEqual([]);
		expect(await readFile(path.join(outside, "a.md"), "utf8")).toBe("x");
	});
});

describe("the caps and the deadline", () => {
	it("delivers at most 64 files and says how many were left", async () => {
		const many = Array.from({ length: RULES_MAX_FILES + 6 }, (_, i) =>
			rule(`r${String(i).padStart(3, "0")}.md`, "x"),
		);

		const result = await sync(many);

		expect(result.written).toHaveLength(RULES_MAX_FILES);
		expect(result.omitted).toBe(6);
		expect(rulesSyncLines(result).join("\n")).toContain(
			"6 more rule files were not delivered",
		);
	});

	it("delivers at most 256 KiB", async () => {
		const big = "x".repeat(RULES_MAX_BYTES / 2 - 10);

		const result = await sync([
			rule("a.md", big),
			rule("b.md", big),
			rule("c.md", big),
		]);

		expect(result.written).toEqual(["a.md", "b.md"]);
		expect(result.omitted).toBe(1);
	});

	it("stops at the deadline and keeps what it knew of the rest", async () => {
		await sync([rule("a.md", "one")]);

		const result = await sync(
			[rule("a.md", "changed"), rule("b.md", "x")],
			{ deadline: Date.now() - 1 },
		);

		expect(result.timedOut).toBe(true);
		expect(result.written).toEqual([]);
		expect(await read("a.md")).toBe("one");
		expect((await marker()).files).toEqual({ "a.md": sha("one") });
	});
});

describe("keeping the folder out of commits", () => {
	const exclude = () =>
		excludeLocalFiles({
			toplevel: root,
			directory: root,
			files: [FOLDER],
			deadline: Date.now() + 10_000,
		});
	const status = () =>
		execFileSync("git", ["status", "--porcelain", "-uall"], {
			cwd: root,
			encoding: "utf8",
		});

	it("a directory entry in info/exclude ignores the folder and everything in it", async () => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		await sync([rule("team/a.md", "x")]);

		expect((await exclude()).kind).toBe("added");

		expect(status()).toBe("");
		const ignored = execFileSync(
			"git",
			[
				"check-ignore",
				`${FOLDER}/team/a.md`,
				`${FOLDER}/.fabric-managed.json`,
			],
			{ cwd: root, encoding: "utf8" },
		)
			.trim()
			.split("\n");
		expect(ignored).toHaveLength(2);
		expect(await exclude()).toEqual({ kind: "unchanged" });
	});

	it("does not ignore the project's own rules next to it", async () => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		await mkdir(path.join(root, ".claude", "rules"), { recursive: true });
		await writeFile(path.join(root, ".claude", "rules", "mine.md"), "mine");
		await exclude();

		expect(status()).toContain(".claude/rules/mine.md");
	});
});
