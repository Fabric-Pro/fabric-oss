/**
 * `fabric context push` planning (Fizzy #2618): which files in a folder
 * leave the machine, which are skipped and why, and what the lock says.
 *
 * The plan is the whole of the command's judgement about the local tree, so
 * every branch is pinned here against real files in a temp directory. The
 * refusals matter more than usual: this command reads a folder and SENDS it,
 * so a symlink that were followed, or a coding-instruction file that were not
 * excluded, would be an upload of something nobody chose to share.
 */
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyContextBytes,
	hashContextContent,
	MAX_CONTEXT_FILE_BYTES,
} from "../src/lib/context-sync/classify.js";
import {
	type ContextLock,
	readContextLock,
	writeContextLock,
} from "../src/lib/context-sync/lock.js";
import { computeContextPlan } from "../src/lib/context-sync/plan.js";
import { normalizeContextSourcePath } from "../src/lib/context-sync/source-path.js";

function sha256(text: string | Uint8Array): string {
	return createHash("sha256").update(text).digest("hex");
}

async function makeFolder(
	files: Record<string, string | Uint8Array> = {},
): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "fabric-context-plan-"));
	for (const [relative, contents] of Object.entries(files)) {
		const target = path.join(dir, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, contents);
	}
	return realpath(dir);
}

function lockOf(
	files: Record<string, string>,
	projectId = "project-1",
): ContextLock {
	return {
		version: 1,
		projectId,
		pushedAt: "2026-09-20T10:00:00.000Z",
		files: Object.fromEntries(
			Object.entries(files).map(([p, contents]) => [
				p,
				{ sha256: sha256(contents), contextId: `ctx-${p}` },
			]),
		),
	};
}

function pushed(plan: Awaited<ReturnType<typeof computeContextPlan>>) {
	return plan.push.map((entry) => entry.sourcePath);
}

// ---------------------------------------------------------------------------
// The walk and the ignore rules
// ---------------------------------------------------------------------------
describe("walk + ignore rules", () => {
	it("always leaves out tool and coding-instruction paths, at any depth", async () => {
		const root = await makeFolder({
			"keep.md": "# Keep\n",
			"docs/keep.md": "# Keep too\n",
			".git/HEAD.txt": "ref\n",
			".fabric/notes.md": "# Not mine\n",
			".claude/memory.md": "# No\n",
			".cursor/rules.md": "# No\n",
			".codex/notes.md": "# No\n",
			"node_modules/pkg/README.md": "# No\n",
			"CLAUDE.md": "# No\n",
			"AGENTS.md": "# No\n",
			"GEMINI.md": "# No\n",
			"docs/CLAUDE.md": "# No\n",
			"skills/review/SKILL.md": "# No\n",
			"docs/agents/writer.md": "# No\n",
			"deep/down/hooks/run.md": "# No\n",
			"rules/style.md": "# No\n",
			"docs/scripts/build.md": "# No\n",
			".contextignore": "# a comment\n",
		});

		const plan = await computeContextPlan({ root, lock: null });

		expect(pushed(plan)).toEqual(["docs/keep.md", "keep.md"]);
		// Ignored is not skipped: nothing about them is reported.
		expect(plan.skipped).toEqual([]);
	});

	it("applies .contextignore with gitignore semantics", async () => {
		const root = await makeFolder({
			".contextignore": "drafts/\n*.txt\n!keep.txt\n/top-only.md\n",
			"a.md": "# A\n",
			"drafts/wip.md": "# WIP\n",
			"notes.txt": "no\n",
			"keep.txt": "yes\n",
			"top-only.md": "# no\n",
			"sub/top-only.md": "# yes\n",
		});

		const plan = await computeContextPlan({ root, lock: null });

		expect(pushed(plan)).toEqual(["a.md", "keep.txt", "sub/top-only.md"]);
	});

	it("applies repeatable --exclude patterns", async () => {
		const root = await makeFolder({
			"a.md": "# A\n",
			"private/b.md": "# B\n",
			"c.json": "{}\n",
		});

		const plan = await computeContextPlan({
			root,
			lock: null,
			excludes: ["private/", "*.json"],
		});

		expect(pushed(plan)).toEqual(["a.md"]);
	});

	it("does not let a user pattern re-include a default exclusion", async () => {
		const root = await makeFolder({
			".contextignore": "!CLAUDE.md\n!skills/\n",
			"CLAUDE.md": "# No\n",
			"skills/x.md": "# No\n",
			"a.md": "# A\n",
		});

		const plan = await computeContextPlan({
			root,
			lock: null,
			excludes: ["!AGENTS.md"],
		});

		expect(pushed(plan)).toEqual(["a.md"]);
	});

	it("skips and reports a symlinked file and a symlinked directory without following either", async () => {
		const outside = await makeFolder({ "secret.md": "# Secret\n" });
		const root = await makeFolder({ "a.md": "# A\n" });
		await symlink(
			path.join(outside, "secret.md"),
			path.join(root, "link.md"),
		);
		await symlink(outside, path.join(root, "linked-dir"));

		const plan = await computeContextPlan({ root, lock: null });

		expect(pushed(plan)).toEqual(["a.md"]);
		expect(plan.skipped).toEqual([
			{ path: "link.md", reason: "symlink" },
			{ path: "linked-dir", reason: "symlink" },
		]);
		// Nothing in the plan was hashed from the linked file.
		expect(
			plan.push.some((entry) => entry.sha256 === sha256("# Secret\n")),
		).toBe(false);
	});

	it("does not report a symlink the ignore rules already leave out", async () => {
		const root = await makeFolder({ "a.md": "# A\n" });
		await mkdir(path.join(root, "node_modules", ".bin"), {
			recursive: true,
		});
		await symlink(
			path.join(root, "a.md"),
			path.join(root, "node_modules", ".bin", "tool"),
		);

		const plan = await computeContextPlan({ root, lock: null });

		expect(plan.skipped).toEqual([]);
	});

	it("treats a symlink named like an ignored directory as ignored, not as a skipped link", async () => {
		const shared = await makeFolder({ "pkg/README.md": "# No\n" });
		const root = await makeFolder({ "a.md": "# A\n" });
		// A workspace package's `node_modules` is routinely a link.
		await symlink(shared, path.join(root, "node_modules"));

		const plan = await computeContextPlan({ root, lock: null });

		expect(pushed(plan)).toEqual(["a.md"]);
		expect(plan.skipped).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
describe("classification", () => {
	it("skips every file type outside the text allow-list", async () => {
		const root = await makeFolder({
			"a.md": "# A\n",
			"b.markdown": "# B\n",
			"c.txt": "c\n",
			"d.json": "{}\n",
			"e.yaml": "e: 1\n",
			"f.yml": "f: 1\n",
			"UPPER.MD": "# upper\n",
			"image.png": "png",
			"code.ts": "export {}\n",
			README: "no extension\n",
		});

		const plan = await computeContextPlan({ root, lock: null });

		expect(pushed(plan)).toEqual([
			"UPPER.MD",
			"a.md",
			"b.markdown",
			"c.txt",
			"d.json",
			"e.yaml",
			"f.yml",
		]);
		expect(plan.skipped).toEqual([
			{ path: "README", reason: "unsupported-type" },
			{ path: "code.ts", reason: "unsupported-type" },
			{ path: "image.png", reason: "unsupported-type" },
		]);
	});

	it("skips invalid UTF-8 and NUL as binary, empty and whitespace-only as empty, and oversize as too-large", async () => {
		const root = await makeFolder({
			"bad-utf8.md": new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]),
			"nul.txt": "text\u0000more\n",
			"empty.md": "",
			"blank.md": " \n\t\n",
			"big.md": "x".repeat(MAX_CONTEXT_FILE_BYTES + 1),
			"exactly-max.md": "y".repeat(MAX_CONTEXT_FILE_BYTES),
		});

		const plan = await computeContextPlan({ root, lock: null });

		expect(pushed(plan)).toEqual(["exactly-max.md"]);
		expect(plan.skipped).toEqual([
			{ path: "bad-utf8.md", reason: "binary" },
			{ path: "big.md", reason: "too-large" },
			{ path: "blank.md", reason: "empty" },
			{ path: "empty.md", reason: "empty" },
			{ path: "nul.txt", reason: "binary" },
		]);
	});

	it("skips a path the server would refuse, with the server's reason word", async () => {
		// Over 512 characters as a PATH; each segment stays under the 255-byte
		// file-name limit every filesystem here enforces.
		const longName = `${"d".repeat(200)}/${"e".repeat(200)}/${"f".repeat(110)}.md`;
		const root = await makeFolder({
			"ok.md": "# ok\n",
			"bidi‮name.md": "# hidden\n",
			[longName]: "# long\n",
		});

		const plan = await computeContextPlan({ root, lock: null });

		expect(pushed(plan)).toEqual(["ok.md"]);
		expect(plan.skipped).toEqual(
			expect.arrayContaining([
				{
					path: "bidi‮name.md",
					reason: "invalid-path",
					detail: "control-character",
				},
				{ path: longName, reason: "invalid-path", detail: "too-long" },
			]),
		);
	});

	it("hashes the UTF-8 bytes exactly as the server does, a byte-order mark included", () => {
		const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x0a]);
		const verdict = classifyContextBytes(withBom);

		expect(verdict.ok).toBe(true);
		if (!verdict.ok) {
			return;
		}
		// The BOM is content, not stripped: the hash the server computes over
		// the string sent must equal the hash of the bytes on disk, or the
		// lock and the server would disagree about an untouched file.
		expect(verdict.content.charCodeAt(0)).toBe(0xfeff);
		expect(hashContextContent(verdict.content)).toBe(sha256(withBom));
		expect(
			createHash("sha256").update(verdict.content, "utf8").digest("hex"),
		).toBe(sha256(withBom));
	});
});

describe("normalizeContextSourcePath (the server's rules, mirrored)", () => {
	it.each([
		["docs/a.md", "docs/a.md"],
		["./docs//a.md", "docs/a.md"],
		["docs\\a.md", "docs/a.md"],
		["café.md", "café.md"],
	])("normalises %j to %j", (input, expected) => {
		expect(normalizeContextSourcePath(input)).toEqual({
			ok: true,
			sourcePath: expected,
		});
	});

	it.each([
		["", "empty"],
		["./", "empty"],
		["/abs.md", "absolute"],
		["C:a.md", "absolute"],
		["\\\\server\\share.md", "absolute"],
		["docs/../a.md", "dot-segment"],
		["docs/./a.md", "dot-segment"],
		["docs/", "trailing-slash"],
		["a\u0007.md", "control-character"],
		["a​.md", "control-character"],
		[`${"a".repeat(513)}`, "too-long"],
	])("refuses %j as %s", (input, reason) => {
		expect(normalizeContextSourcePath(input)).toEqual({
			ok: false,
			reason,
		});
	});
});

// ---------------------------------------------------------------------------
// The plan against the lock
// ---------------------------------------------------------------------------
describe("plan against the lock", () => {
	it("omits expectedContentHash for every file on a first run", async () => {
		const root = await makeFolder({ "a.md": "# A\n", "b/c.md": "# C\n" });

		const plan = await computeContextPlan({ root, lock: null });

		expect(plan.push.map((entry) => entry.expectedContentHash)).toEqual([
			undefined,
			undefined,
		]);
		expect(plan.push[0]).toEqual({
			sourcePath: "a.md",
			diskPath: "a.md",
			sha256: sha256("# A\n"),
			bytes: 4,
		});
	});

	it("keeps no file's content in the plan: the push reads each file again when it sends it", async () => {
		const root = await makeFolder({ "a.md": "# A\n", "b.md": "# B\n" });

		const plan = await computeContextPlan({ root, lock: null });

		for (const entry of plan.push) {
			expect(entry).not.toHaveProperty("content");
		}
	});

	it("marks a duplicate whose hash the lock holds as unchanged-local, and sends a changed one with no expected hash", async () => {
		const root = await makeFolder({
			"same.md": "# Same\n",
			"moved-on.md": "# Different now\n",
		});
		const lock: ContextLock = {
			...lockOf({}),
			files: {
				"same.md": { sha256: sha256("# Same\n"), state: "duplicate" },
				"moved-on.md": {
					sha256: sha256("# Same\n"),
					state: "duplicate",
				},
			},
		};

		const plan = await computeContextPlan({ root, lock });

		expect(plan.unchangedLocal).toEqual(["same.md"]);
		expect(plan.push.map((entry) => entry.sourcePath)).toEqual([
			"moved-on.md",
		]);
		expect(plan.push[0]).not.toHaveProperty("expectedContentHash");
	});

	it("forgets a duplicate that is gone from disk instead of reporting a server entry that never existed", async () => {
		const root = await makeFolder({ "a.md": "# A\n" });
		const lock: ContextLock = {
			...lockOf({ "a.md": "# A\n", "gone.md": "# Gone\n" }),
		};
		lock.files["copy.md"] = { sha256: sha256("# A\n"), state: "duplicate" };

		const plan = await computeContextPlan({ root, lock });

		expect(plan.removed).toEqual(["gone.md"]);
		expect(plan.forgotten).toEqual(["copy.md"]);
	});

	it("marks a file whose hash the lock already holds as unchanged-local", async () => {
		const root = await makeFolder({ "a.md": "# A\n", "b.md": "# B v2\n" });

		const plan = await computeContextPlan({
			root,
			lock: lockOf({ "a.md": "# A\n", "b.md": "# B v1\n" }),
		});

		expect(plan.unchangedLocal).toEqual(["a.md"]);
		expect(plan.push).toHaveLength(1);
		expect(plan.push[0]?.sourcePath).toBe("b.md");
		expect(plan.push[0]?.expectedContentHash).toBe(sha256("# B v1\n"));
	});

	it("sends a new file with no expected hash even when other files are locked", async () => {
		const root = await makeFolder({ "a.md": "# A\n", "new.md": "# New\n" });

		const plan = await computeContextPlan({
			root,
			lock: lockOf({ "a.md": "# A\n" }),
		});

		expect(plan.push.map((entry) => entry.sourcePath)).toEqual(["new.md"]);
		expect(plan.push[0]).not.toHaveProperty("expectedContentHash");
	});

	it("reports a locked path that is gone from disk as removed", async () => {
		const root = await makeFolder({ "a.md": "# A\n" });

		const plan = await computeContextPlan({
			root,
			lock: lockOf({
				"a.md": "# A\n",
				"gone.md": "# Gone\n",
				"x/y.md": "y",
			}),
		});

		expect(plan.removed).toEqual(["gone.md", "x/y.md"]);
		expect(plan.push).toEqual([]);
	});

	it("reports a locked path that is still there but now excluded as ignored, not removed", async () => {
		const root = await makeFolder({
			".contextignore": "private/\n",
			"private/p.md": "# P\n",
		});

		const plan = await computeContextPlan({
			root,
			lock: lockOf({ "private/p.md": "# P\n" }),
		});

		expect(plan.removed).toEqual([]);
		expect(plan.skipped).toEqual([
			{ path: "private/p.md", reason: "ignored" },
		]);
	});

	it("reports a locked path inside a now-excluded directory as ignored", async () => {
		const root = await makeFolder({
			".contextignore": "private/\n",
			"private/deep/p.md": "# P\n",
		});

		const plan = await computeContextPlan({
			root,
			lock: lockOf({ "private/deep/p.md": "# P\n" }),
		});

		expect(plan.removed).toEqual([]);
		expect(plan.skipped).toEqual([
			{ path: "private/deep/p.md", reason: "ignored" },
		]);
	});
});

describe("case-only collisions", () => {
	it("sends neither of two files whose paths differ only in case, and says why", async (context) => {
		const root = await makeFolder({ "Guide.md": "# One\n" });
		await writeFile(path.join(root, "guide.md"), "# Two\n");
		const names = await readdir(root);
		if (!(names.includes("Guide.md") && names.includes("guide.md"))) {
			// A case-insensitive filesystem cannot hold both; nothing to test.
			context.skip();
		}

		const plan = await computeContextPlan({ root, lock: null });

		expect(plan.push).toEqual([]);
		expect(plan.skipped).toEqual([
			{
				path: "Guide.md",
				reason: "invalid-path",
				detail: "case-only collision with guide.md",
			},
			{
				path: "guide.md",
				reason: "invalid-path",
				detail: "case-only collision with Guide.md",
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// The lock file
// ---------------------------------------------------------------------------
describe("context lock", () => {
	it("round-trips through the guarded writer at .fabric/context.lock", async () => {
		const root = await makeFolder();
		const lock = lockOf({ "a.md": "# A\n" });

		await writeContextLock(root, lock);

		expect(await readContextLock(root)).toEqual(lock);
		const raw = await readFile(
			path.join(root, ".fabric", "context.lock"),
			"utf8",
		);
		expect(raw.endsWith("\n")).toBe(true);
	});

	it("round-trips a duplicate entry, which has no contextId", async () => {
		const root = await makeFolder();
		const lock: ContextLock = {
			...lockOf({ "a.md": "# A\n" }),
		};
		lock.files["copy.md"] = { sha256: sha256("# A\n"), state: "duplicate" };

		await writeContextLock(root, lock);

		expect(await readContextLock(root)).toEqual(lock);
	});

	it("reads a missing lock as a first run", async () => {
		expect(await readContextLock(await makeFolder())).toBeNull();
	});

	it.each([
		["not JSON", "{ nope", /not valid JSON/],
		[
			"another version",
			JSON.stringify({ ...lockOf({}), version: 2 }),
			/version/,
		],
		[
			"a bad hash",
			JSON.stringify({
				...lockOf({}),
				files: { "a.md": { sha256: "zz", contextId: "c" } },
			}),
			/sha256/,
		],
		[
			"an unknown state",
			JSON.stringify({
				...lockOf({}),
				files: { "a.md": { sha256: "a".repeat(64), state: "gone" } },
			}),
			/state/,
		],
		[
			"a duplicate that names a contextId",
			JSON.stringify({
				...lockOf({}),
				files: {
					"a.md": {
						sha256: "a".repeat(64),
						state: "duplicate",
						contextId: "c",
					},
				},
			}),
			/duplicate/,
		],
		[
			"a missing contextId",
			JSON.stringify({
				...lockOf({}),
				files: { "a.md": { sha256: "a".repeat(64) } },
			}),
			/contextId/,
		],
		[
			"a path the server would never store",
			JSON.stringify({
				...lockOf({}),
				files: {
					"../escape.md": { sha256: "a".repeat(64), contextId: "c" },
				},
			}),
			/escape\.md/,
		],
	])("refuses a lock with %s", async (_label, raw, message) => {
		const root = await makeFolder({
			".fabric/context.lock": raw as string,
		});

		await expect(readContextLock(root)).rejects.toThrow(message as RegExp);
	});

	it("refuses to write the lock through a symlinked .fabric", async () => {
		const outside = await makeFolder();
		const root = await makeFolder();
		await symlink(outside, path.join(root, ".fabric"));

		await expect(
			writeContextLock(root, lockOf({ "a.md": "# A\n" })),
		).rejects.toThrow(/symlink/i);
	});
});
