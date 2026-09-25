import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PullRequestContext } from "@repo/instructions";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	buildProposalCommit,
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
	listTreeRaw,
	pushCreateOnly,
	type RawTreeEntry,
} from "../instruction-sync-git";

// The verifier (spec §7 step 8) is stubbed per test through this switch; every
// other call reaches real git.
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
let work: string;
let source: string;
let base: string;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: work,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
		encoding: "utf8",
	}).trim();
}

function lsTree(dir: string, rev: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const record of execFileSync("git", ["ls-tree", "-r", "-z", rev], {
		cwd: dir,
		env: { PATH: process.env.PATH, HOME: work },
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

const BASE_ROWS = [
	row("a.md", "one\n"),
	row("run.sh", "#!/bin/sh\n", 0o755),
	row(NFC, "nfd\n"),
];

function context(): PullRequestContext {
	return {
		v: 1,
		integrationId: "int_1",
		syncId: "sync_1",
		syncGeneration: 1,
		provider: "GITHUB",
		targetRef: "main",
		rootPath: "agents",
		baseCommitSha: base,
		repository: {
			provider: "GITHUB",
			owner: "example-org",
			repo: "example-repo",
		},
		branch: "fabric/instructions/c00000000000000000000000",
		author: { name: "Example Person", email: MAIL },
		committer: {
			name: "Fabric",
			email: ["noreply", "example.com"].join("@"),
		},
		title: "Update coding instructions (1 file)",
		body: "",
		message: "Update coding instructions (1 file)\n",
		committedAt: "2026-09-24T00:00:00Z",
	};
}

async function build(
	name: string,
	proposal: Array<FileRow & { content: string }>,
	bytesFor: (r: FileRow & { content: string }) => Buffer = (r) =>
		Buffer.from(r.content),
) {
	const run = path.join(work, name);
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
		url: `file://${source}`,
		ref: "main",
		dir,
		env,
	});
	await fetchPinnedCommit({ dir, sha: base, env });
	const listed = await listTreeRaw({
		dir,
		sha: base,
		rootPath: "agents",
		maxEntries: 1000,
		env,
	});
	if (!listed.ok) {
		throw new Error("listing failed");
	}
	const byKey = new Map(proposal.map((r) => [r.storageKey, r]));
	const reads: string[] = [];
	const result = await buildProposalCommit({
		dir,
		env,
		signal: new AbortController().signal,
		context: context(),
		delta: computeEffectiveDelta(BASE_ROWS, proposal),
		entries: listed.entries,
		readBytes: async (key) => {
			reads.push(key);
			const r = byKey.get(key);
			if (!r) {
				throw new Error("no such object");
			}
			return bytesFor(r);
		},
	});
	return { dir, env, result, reads };
}

describe.skipIf(!hasGit)(
	"buildProposalCommit against real git (spec §7)",
	() => {
		beforeAll(async () => {
			work = await mkdtemp(path.join(tmpdir(), "proposal-commit-"));
			source = path.join(work, "source");
			await mkdir(path.join(source, "agents", "docs"), {
				recursive: true,
			});
			await writeFile(path.join(source, "agents/a.md"), "one\n");
			await writeFile(path.join(source, "agents/run.sh"), "#!/bin/sh\n");
			await chmod(path.join(source, "agents/run.sh"), 0o755);
			await writeFile(path.join(source, "agents", NFD), "nfd\n");
			await symlink("a.md", path.join(source, "agents/link.md"));
			await writeFile(
				path.join(source, "agents/ignored.md"),
				"ignored\n",
			);
			await writeFile(
				path.join(source, "agents/docs/x.md"),
				"excluded\n",
			);
			await writeFile(path.join(source, "other.md"), "outside\n");
			git(source, ["init", "-q", "-b", "main"]);
			git(source, ["config", "uploadpack.allowFilter", "true"]);
			git(source, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
			git(source, ["add", "-A"]);
			git(source, [
				"-c",
				"user.name=Example",
				"-c",
				`user.email=${MAIL}`,
				"commit",
				"-qm",
				"base",
			]);
			base = git(source, ["rev-parse", "HEAD"]);
		});

		afterAll(async () => {
			await rm(work, { recursive: true, force: true });
			diffOverride.fn = null;
		});

		it("builds exactly the delta, with base modes for existing paths and 0755 only when recorded, and keeps excluded entries", async () => {
			const { dir, result, reads } = await build("delta", [
				row("a.md", "one changed\n"),
				row("run.sh", "#!/bin/sh\necho changed\n"),
				row(NFC, "nfd\n"),
				row("new.md", "new\n"),
				row("tool.sh", "#!/bin/sh\necho tool\n", 0o755),
				row("plain.sh", "#!/bin/sh\necho plain\n", 0o644),
			]);
			expect(result.ok).toBe(true);
			if (!result.ok) {
				return;
			}
			expect(reads.sort()).toEqual(
				[
					"k/one changed\n",
					"k/#!/bin/sh\necho changed\n",
					"k/new\n",
					"k/#!/bin/sh\necho tool\n",
					"k/#!/bin/sh\necho plain\n",
				].sort(),
			);
			const before = lsTree(dir, base);
			const after = lsTree(dir, result.sha);
			expect(after.get("agents/run.sh")).toMatch(/^100755 blob /);
			expect(after.get("agents/tool.sh")).toMatch(/^100755 blob /);
			expect(after.get("agents/plain.sh")).toMatch(/^100644 blob /);
			expect(after.get("agents/new.md")).toMatch(/^100644 blob /);
			expect(after.get("agents/a.md")).not.toBe(
				before.get("agents/a.md"),
			);
			for (const kept of [
				"agents/link.md",
				"agents/ignored.md",
				"agents/docs/x.md",
				`agents/${NFD}`,
				"other.md",
			]) {
				expect(after.get(kept)).toBe(before.get(kept));
			}
			expect(git(dir, ["rev-parse", `${result.sha}^`])).toBe(base);
		});

		it("maps an NFD repository path to its NFC proposal row", async () => {
			const { dir, result } = await build("nfd", [
				...BASE_ROWS.filter((r) => r.path !== NFC),
				row(NFC, "nfd changed\n"),
			]);
			expect(result.ok).toBe(true);
			if (!result.ok) {
				return;
			}
			const after = lsTree(dir, result.sha);
			expect(after.has(`agents/${NFC}`)).toBe(false);
			expect(after.get(`agents/${NFD}`)).not.toBe(
				lsTree(dir, base).get(`agents/${NFD}`),
			);
			expect(
				git(dir, ["cat-file", "blob", `${result.sha}:agents/${NFD}`]),
			).toBe("nfd changed");
			expect(after.size).toBe(lsTree(dir, base).size);
		});

		it("deletes a base row's file and produces the identical SHA on a second build", async () => {
			const proposal = BASE_ROWS.filter((r) => r.path !== "a.md");
			const one = await build("repro-1", proposal);
			const two = await build("repro-2", proposal);
			expect(one.result).toEqual(two.result);
			expect(
				one.result.ok &&
					lsTree(one.dir, one.result.sha).has("agents/a.md"),
			).toBe(false);
		});

		it("refuses a proposal that collides with an unmanaged entry", async () => {
			const { result } = await build("conflict", [
				...BASE_ROWS,
				row("ignored.md", "x\n"),
			]);
			expect(result).toEqual({ ok: false, code: "TREE_CONFLICT" });
		});

		it("reports a storage re-hash mismatch as STORAGE_FAILED", async () => {
			const { result } = await build(
				"storage",
				[...BASE_ROWS, row("new.md", "new\n")],
				() => Buffer.from("not what the row recorded"),
			);
			expect(result).toEqual({ ok: false, code: "STORAGE_FAILED" });
		});

		it("reports a storage read failure as STORAGE_FAILED", async () => {
			const { result } = await build(
				"storage-read",
				[...BASE_ROWS, row("new.md", "new\n")],
				() => {
					throw new Error("storage unavailable");
				},
			);
			expect(result).toEqual({ ok: false, code: "STORAGE_FAILED" });
		});

		// Spec §13 content: the builder writes objects and never a ref, and the
		// one ref a proposal ever writes is its own branch under
		// refs/heads/fabric/instructions/.
		it("writes only refs under fabric/instructions/", async () => {
			const refs = (dir: string) =>
				git(dir, ["for-each-ref", "--format=%(refname)"])
					.split("\n")
					.filter((r) => r !== "")
					.sort();
			const before = refs(source);
			const { dir, env, result } = await build("refs", [
				row("a.md", "one changed\n"),
				row("run.sh", "#!/bin/sh\n"),
				row(NFC, "nfd\n"),
			]);
			if (!result.ok) {
				throw new Error("build failed");
			}
			expect(git(dir, ["for-each-ref", "--points-at", result.sha])).toBe(
				"",
			);
			const { branch } = context();
			expect(
				await pushCreateOnly({
					dir,
					sha: result.sha,
					branch,
					env,
					signal: new AbortController().signal,
				}),
			).toEqual({ kind: "created" });
			const added = refs(source).filter((r) => !before.includes(r));
			expect(added).toEqual([`refs/heads/${branch}`]);
			for (const ref of added) {
				expect(ref.startsWith("refs/heads/fabric/instructions/")).toBe(
					true,
				);
			}
			expect(git(source, ["rev-parse", `refs/heads/${branch}`])).toBe(
				result.sha,
			);
		});

		it("reports a verifier mismatch as GIT_FAILED", async () => {
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
				const { result } = await build("verifier", [
					...BASE_ROWS,
					row("new.md", "new\n"),
				]);
				expect(result).toEqual({ ok: false, code: "GIT_FAILED" });
			} finally {
				diffOverride.fn = null;
			}
		});

		it("reports a verifier that lost a change as GIT_FAILED", async () => {
			diffOverride.fn = (real) => real.slice(1);
			try {
				const { result } = await build("verifier-lost", [
					...BASE_ROWS,
					row("new.md", "new\n"),
				]);
				expect(result).toEqual({ ok: false, code: "GIT_FAILED" });
			} finally {
				diffOverride.fn = null;
			}
		});
	},
);
