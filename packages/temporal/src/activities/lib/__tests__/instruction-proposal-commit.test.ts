import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readTreeEntries } from "../instruction-branch-git";
import {
	type BranchWritePlanEntry,
	buildBranchCommit,
	computeEffectiveDelta,
	type EffectiveDelta,
	type FileRow,
	findTreeConflicts,
} from "../instruction-proposal-commit";
import {
	buildGitEnv,
	cloneTreeless,
	type DiffTreeEntry,
	fetchPinnedCommit,
	type RawTreeEntry,
} from "../instruction-sync-git";

// The verifier (`buildBranchCommit`'s diff from the parent) is stubbed per
// test through this switch; every other call reaches real git.
const diffOverride = vi.hoisted(() => ({
	fn: null as
		| null
		| ((
				real: DiffTreeEntry[],
		  ) => DiffTreeEntry[] | Promise<DiffTreeEntry[]>),
}));
vi.mock("../instruction-sync-git", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../instruction-sync-git")>();
	return {
		...actual,
		diffTreeEntries: async (
			input: Parameters<typeof actual.diffTreeEntries>[0],
		) => {
			const real = await actual.diffTreeEntries(input);
			return diffOverride.fn ? diffOverride.fn(real) : real;
		},
	};
});

const sha = (bytes: string | Buffer): string =>
	createHash("sha256").update(bytes).digest("hex");

function row(
	p: string,
	content: string,
	mode: number | null = null,
): FileRow & { content: string } {
	return {
		path: p,
		sha256: sha(content),
		mode,
		storageKey: `k/${content}`,
		content,
	};
}

const NFD = "café.md";
const NFC = "café.md";

function raw(p: string, mode: RawTreeEntry["mode"] = "100644"): RawTreeEntry {
	return {
		mode,
		type: mode === "160000" ? "commit" : "blob",
		oid: "0".repeat(40),
		rawPath: Buffer.from(p, "utf8"),
		path: p,
	};
}

describe("computeEffectiveDelta (spec §7 step 3)", () => {
	it("finds added, modified and deleted rows on path and sha256, ignoring unchanged rows and mode-only changes", () => {
		const delta = computeEffectiveDelta(
			[
				row("a.md", "one"),
				row("b.md", "two"),
				row("c.md", "three", 0o644),
			],
			[
				row("a.md", "one"),
				row("b.md", "TWO"),
				row("c.md", "three", 0o755),
				row("d.md", "four"),
			],
		);
		expect(delta.added.map((r) => r.path)).toEqual(["d.md"]);
		expect(delta.modified.map((r) => r.path)).toEqual(["b.md"]);
		expect(delta.modified[0]?.sha256).toBe(sha("TWO"));
		expect(delta.deleted).toEqual([]);
		const removed = computeEffectiveDelta([row("a.md", "one")], []);
		expect(removed.deleted.map((r) => r.path)).toEqual(["a.md"]);
	});

	it("keys rows by their NFC form, so an NFD base row and its NFC proposal row are one modification", () => {
		const delta = computeEffectiveDelta(
			[row(NFD, "old")],
			[row(NFC, "new")],
		);
		expect(delta.added).toEqual([]);
		expect(delta.deleted).toEqual([]);
		expect(delta.modified.map((r) => r.path)).toEqual([NFC]);
	});
});

describe("findTreeConflicts (spec §7 steps 2 and 4)", () => {
	const base: RawTreeEntry[] = [
		raw("agents/a.md"),
		raw("agents/run.sh", "100755"),
		raw("agents/link.md", "120000"),
		raw("agents/sub", "160000"),
		raw("agents/ignored.md"),
		raw("agents/docs/x.md"),
		raw("agents/README.md"),
		raw("agents/file"),
	];
	const delta = (d: Partial<EffectiveDelta>): EffectiveDelta => ({
		added: [],
		modified: [],
		deleted: [],
		...d,
	});

	it("accepts modifying and deleting regular blobs and adding a fresh path", () => {
		expect(
			findTreeConflicts(
				base,
				delta({
					modified: [row("a.md", "x")],
					deleted: [row("run.sh", "y")],
					added: [row("new/fresh.md", "z")],
				}),
				"agents",
			),
		).toBe(false);
	});

	it.each([
		["modifying a symlink", { modified: [row("link.md", "x")] }],
		["modifying a gitlink", { modified: [row("sub", "x")] }],
		["deleting a symlink", { deleted: [row("link.md", "x")] }],
		[
			"modifying a path with no raw entry",
			{ modified: [row("gone.md", "x")] },
		],
		[
			"adding a path equal to an entry",
			{ added: [row("ignored.md", "x")] },
		],
		[
			"adding a path under an entry",
			{ added: [row("file/inner.md", "x")] },
		],
		[
			"adding a path under a gitlink",
			{ added: [row("sub/inner.md", "x")] },
		],
		["adding a path containing an entry", { added: [row("docs", "x")] }],
		[
			"adding a path sharing a collisionKey",
			{ added: [row("readme.md", "x")] },
		],
		[
			"adding a path whose directory case-collides with an entry",
			{ added: [row("FILE/inner.md", "x")] },
		],
	])("reports %s as a conflict", (_label, d) => {
		expect(findTreeConflicts(base, delta(d), "agents")).toBe(true);
	});

	it("reports two raw entries on one normalised key as a conflict", () => {
		expect(
			findTreeConflicts(
				[raw(`agents/${NFD}`), raw(`agents/${NFC}`)],
				delta({ added: [row("other.md", "x")] }),
				"agents",
			),
		).toBe(true);
	});

	it("does not count an entry the delta deletes against an addition", () => {
		expect(
			findTreeConflicts(
				base,
				delta({
					deleted: [row("README.md", "r")],
					added: [row("readme.md", "x")],
				}),
				"agents",
			),
		).toBe(false);
	});

	it("maps entries at the repository root when rootPath is empty", () => {
		expect(
			findTreeConflicts(
				[raw("a.md"), raw("link.md", "120000")],
				delta({ modified: [row("a.md", "x")] }),
				"",
			),
		).toBe(false);
		expect(
			findTreeConflicts(
				[raw("a.md"), raw("link.md", "120000")],
				delta({ modified: [row("link.md", "x")] }),
				"",
			),
		).toBe(true);
	});
});

let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}

const MAIL = ["dev", "example.com"].join("@");
/** A commit's tree, path to "mode type oid", read with `ls-tree -r`. */
function lsTree(dir: string, rev: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const record of execFileSync("git", ["ls-tree", "-r", "-z", rev], {
		cwd: dir,
		env: {
			PATH: process.env.PATH,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	})
		.toString("utf8")
		.split("\0")) {
		if (record !== "") {
			const tab = record.indexOf("\t");
			out.set(record.slice(tab + 1), record.slice(0, tab));
		}
	}
	return out;
}

describe.skipIf(!hasGit)(
	"buildBranchCommit against real git (member proposal branch spec §6.4 steps 6-7, §6.8 step 3)",
	() => {
		let branchWork: string;
		let branchSource: string;
		let branchBase: string;

		function branchGit(cwd: string, args: string[]): string {
			return execFileSync("git", args, {
				cwd,
				env: {
					PATH: process.env.PATH,
					HOME: branchWork,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
				},
				encoding: "utf8",
			}).trim();
		}

		async function branchWorkspace(name: string): Promise<{
			dir: string;
			env: NodeJS.ProcessEnv;
		}> {
			const run = path.join(branchWork, name);
			await mkdir(run);
			const dir = path.join(run, "repo");
			const env = {
				...buildGitEnv({ home: run }),
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "protocol.file.allow",
				GIT_CONFIG_VALUE_0: "always",
			};
			await cloneTreeless({
				cwd: run,
				url: `file://${branchSource}`,
				ref: "main",
				dir,
				env,
			});
			await fetchPinnedCommit({ dir, sha: branchBase, env });
			return { dir, env };
		}

		/** A new blob's tree entry, hashed straight into the workspace's object store. */
		function newBlobEntry(
			dir: string,
			content: string,
			mode: "100644" | "100755" = "100644",
		): { type: "blob"; mode: string; oid: string } {
			const oid = execFileSync(
				"git",
				["-C", dir, "hash-object", "-w", "--no-filters", "--stdin"],
				{ input: content, encoding: "utf8" },
			).trim();
			return { type: "blob", mode, oid };
		}

		beforeAll(async () => {
			branchWork = await mkdtemp(path.join(tmpdir(), "branch-commit-"));
			branchSource = path.join(branchWork, "source");
			await mkdir(path.join(branchSource, "agents"), {
				recursive: true,
			});
			await writeFile(path.join(branchSource, "agents/a.md"), "one\n");
			await writeFile(
				path.join(branchSource, "agents/keep.md"),
				"keep\n",
			);
			branchGit(branchSource, ["init", "-q", "-b", "main"]);
			branchGit(branchSource, [
				"config",
				"uploadpack.allowFilter",
				"true",
			]);
			branchGit(branchSource, [
				"config",
				"uploadpack.allowAnySHA1InWant",
				"true",
			]);
			branchGit(branchSource, ["add", "-A"]);
			branchGit(branchSource, [
				"-c",
				"user.name=Example",
				"-c",
				`user.email=${MAIL}`,
				"commit",
				"-qm",
				"base",
			]);
			branchBase = branchGit(branchSource, ["rev-parse", "HEAD"]);
		});

		afterAll(async () => {
			await rm(branchWork, { recursive: true, force: true });
		});

		it("writes a new blob and modifies an existing one, exactly the plan, leaving other paths untouched", async () => {
			const { dir, env } = await branchWorkspace("add-modify");
			const plan: BranchWritePlanEntry[] = [
				{
					rawPath: "agents/a.md",
					after: newBlobEntry(dir, "one changed\n"),
				},
				{
					rawPath: "agents/new.md",
					after: newBlobEntry(dir, "new\n", "100755"),
				},
			];
			const result = await buildBranchCommit({
				dir,
				env,
				signal: new AbortController().signal,
				parent: branchBase,
				plan,
				author: { name: "Example Person", email: MAIL },
				committer: { name: "Fabric", email: MAIL },
				message: "append\n",
				date: "2026-09-26T00:00:00Z",
			});
			expect(result.ok).toBe(true);
			if (!result.ok) {
				return;
			}
			const before = lsTree(dir, branchBase);
			const after = lsTree(dir, result.sha);
			expect(after.get("agents/a.md")).not.toBe(
				before.get("agents/a.md"),
			);
			expect(after.get("agents/new.md")).toMatch(/^100755 blob /);
			expect(after.get("agents/keep.md")).toBe(
				before.get("agents/keep.md"),
			);
		});

		it("deletes a path", async () => {
			const { dir, env } = await branchWorkspace("delete");
			const result = await buildBranchCommit({
				dir,
				env,
				signal: new AbortController().signal,
				parent: branchBase,
				plan: [{ rawPath: "agents/a.md", after: null }],
				author: { name: "Example Person", email: MAIL },
				committer: { name: "Fabric", email: MAIL },
				message: "withdraw\n",
				date: "2026-09-26T00:00:00Z",
			});
			expect(result.ok).toBe(true);
			if (!result.ok) {
				return;
			}
			const after = lsTree(dir, result.sha);
			expect(after.has("agents/a.md")).toBe(false);
			expect(after.has("agents/keep.md")).toBe(true);
		});

		it("restores an existing tree entry read from history, without hashing new bytes", async () => {
			const { dir, env } = await branchWorkspace("restore");
			// The first commit deletes agents/a.md; the entry to restore comes
			// from `readTreeEntries` against the base commit, never a fresh hash.
			const deleted = await buildBranchCommit({
				dir,
				env,
				signal: new AbortController().signal,
				parent: branchBase,
				plan: [{ rawPath: "agents/a.md", after: null }],
				author: { name: "Example Person", email: MAIL },
				committer: { name: "Fabric", email: MAIL },
				message: "withdraw\n",
				date: "2026-09-26T00:00:00Z",
			});
			expect(deleted.ok).toBe(true);
			if (!deleted.ok) {
				return;
			}
			const original = await readTreeEntries({
				dir,
				sha: branchBase,
				rawPaths: ["agents/a.md"],
				env,
			});
			const restored = await buildBranchCommit({
				dir,
				env,
				signal: new AbortController().signal,
				parent: deleted.sha,
				plan: [
					{
						rawPath: "agents/a.md",
						after: original.get("agents/a.md") ?? null,
					},
				],
				author: { name: "Example Person", email: MAIL },
				committer: { name: "Fabric", email: MAIL },
				message: "Withdraw: restore\n",
				date: "2026-09-26T00:00:00Z",
			});
			expect(restored.ok).toBe(true);
			if (!restored.ok) {
				return;
			}
			const before = lsTree(dir, branchBase);
			const after = lsTree(dir, restored.sha);
			expect(after.get("agents/a.md")).toBe(before.get("agents/a.md"));
		});

		it("reports GIT_FAILED when the plan names one path twice", async () => {
			const { dir, env } = await branchWorkspace("duplicate");
			const result = await buildBranchCommit({
				dir,
				env,
				signal: new AbortController().signal,
				parent: branchBase,
				plan: [
					{
						rawPath: "agents/a.md",
						after: newBlobEntry(dir, "first\n"),
					},
					{
						rawPath: "agents/a.md",
						after: newBlobEntry(dir, "second\n"),
					},
				],
				author: { name: "Example Person", email: MAIL },
				committer: { name: "Fabric", email: MAIL },
				message: "append\n",
				date: "2026-09-26T00:00:00Z",
			});
			expect(result).toEqual({ ok: false, code: "GIT_FAILED" });
		});

		/** One modification on the base commit, verified through `diffOverride`. */
		async function verified(name: string) {
			const { dir, env } = await branchWorkspace(name);
			return buildBranchCommit({
				dir,
				env,
				signal: new AbortController().signal,
				parent: branchBase,
				plan: [
					{
						rawPath: "agents/a.md",
						after: newBlobEntry(dir, "one changed\n"),
					},
				],
				author: { name: "Example Person", email: MAIL },
				committer: { name: "Fabric", email: MAIL },
				message: "append\n",
				date: "2026-09-26T00:00:00Z",
			});
		}

		it("reports a verifier that finds a change the plan does not name as GIT_FAILED", async () => {
			diffOverride.fn = (real) => [
				...real,
				{
					status: "A",
					path: "agents/unexpected.md",
					oldMode: "000000",
					newMode: "100644",
					newOid: "0".repeat(40),
				},
			];
			try {
				expect(await verified("verifier-extra")).toEqual({
					ok: false,
					code: "GIT_FAILED",
				});
			} finally {
				diffOverride.fn = null;
			}
		});

		it("reports a verifier that lost a change as GIT_FAILED", async () => {
			diffOverride.fn = (real) => real.slice(1);
			try {
				expect(await verified("verifier-lost")).toEqual({
					ok: false,
					code: "GIT_FAILED",
				});
			} finally {
				diffOverride.fn = null;
			}
		});
	},
);
