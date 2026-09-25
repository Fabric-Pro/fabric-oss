import { execFileSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCredentialFailure } from "../instruction-proposal-credential";
import {
	assertOperationBranch,
	buildGitEnv,
	cloneTreeless,
	commitTree,
	deleteBranch,
	diffTreeEntries,
	fetchPinnedCommit,
	GitCommandError,
	listTreeRaw,
	lsRemoteRef,
	pushCreateOnly,
	type RawTreeEntry,
	readBaseTree,
	runBoundedProcess,
	type TreeDeltaEntry,
	writeProposalTree,
} from "../instruction-sync-git";

// Real git over file:// (spec §7 table, §14 "Real git 2.39"), in the pattern of
// instruction-sync-real-git.test.ts. Skipped cleanly where git is absent; the
// feasibility script (scripts/check-instruction-proposal-git.sh) runs the same
// plumbing against the worker image's git.
let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}

// Assembled at runtime: no address or token literal in the tree.
const MAIL = ["dev", "example.com"].join("@");
const TOKEN = `gh${"p_"}${"A".repeat(36)}`;
const PERSON = { name: "Example Person", email: MAIL };
const FABRIC = { name: "Fabric", email: ["noreply", "example.com"].join("@") };
const DATE = "2026-09-24T00:00:00Z";
const NON_UTF8 = Buffer.concat([
	Buffer.from("agents/bad"),
	Buffer.from([0xff]),
	Buffer.from(".md"),
]);

/** A branch the guard accepts: cuid2-shaped, 24 lowercase characters after the prefix. */
function branch(tag: string): string {
	return `fabric/instructions/c${tag.padEnd(23, "0")}`;
}

let work: string;
let source: string;
let base: string;
let tip: string;

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

function gitBytes(cwd: string, args: string[]): Buffer {
	return execFileSync("git", args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: work,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	});
}

function commitAll(message: string): string {
	git(source, [
		"-c",
		"user.name=Example",
		"-c",
		`user.email=${MAIL}`,
		"commit",
		"-q",
		"-m",
		message,
	]);
	return git(source, ["rev-parse", "HEAD"]);
}

/** The production env (optionally with a credential), plus the file protocol for this test only. */
function proposalEnv(
	home: string,
	extra: NodeJS.ProcessEnv = {},
	credential?: string,
): NodeJS.ProcessEnv {
	return {
		...buildGitEnv({
			home,
			...(credential === undefined
				? {}
				: {
						username: "x-access-token",
						credential,
						host: "example.com",
					}),
		}),
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "protocol.file.allow",
		GIT_CONFIG_VALUE_0: "always",
		...extra,
	};
}

async function freshClone(
	name: string,
	extra: NodeJS.ProcessEnv = {},
	credential?: string,
): Promise<{ run: string; dir: string; env: NodeJS.ProcessEnv }> {
	const run = path.join(work, name);
	await mkdir(run);
	const dir = path.join(run, "repo");
	const env = proposalEnv(run, extra, credential);
	await cloneTreeless({
		cwd: run,
		url: `file://${source}`,
		ref: "main",
		dir,
		env,
	});
	await fetchPinnedCommit({ dir, sha: base, env });
	return { run, dir, env };
}

/** Objects the clone does not have, listed without fetching them. */
function missingObjects(dir: string, rev: string): string[] {
	return git(dir, ["rev-list", "--objects", "--missing=print", rev])
		.split("\n")
		.filter((line) => line.startsWith("?"))
		.map((line) => line.slice(1));
}

const DELTA: TreeDeltaEntry[] = [
	{
		path: "agents/nested/deep.md",
		mode: "100644",
		bytes: Buffer.from("deeper\n"),
	},
	{
		path: "agents/new.sh",
		mode: "100755",
		bytes: Buffer.from("#!/bin/sh\necho new\n"),
	},
	{ path: "agents/a.md", delete: true },
];

async function buildCommit(
	name: string,
	delta: readonly TreeDeltaEntry[] = DELTA,
): Promise<{
	run: string;
	dir: string;
	env: NodeJS.ProcessEnv;
	tree: string;
	commit: string;
	blobIds: Map<string, string>;
}> {
	const clone = await freshClone(name);
	const indexFile = path.join(clone.run, "index");
	await readBaseTree({
		dir: clone.dir,
		sha: base,
		indexFile,
		env: clone.env,
	});
	const { tree, blobIds } = await writeProposalTree({
		dir: clone.dir,
		indexFile,
		delta,
		env: clone.env,
	});
	const commit = await commitTree({
		dir: clone.dir,
		tree,
		parent: base,
		author: PERSON,
		committer: FABRIC,
		message: "Update coding instructions\n\nA synthetic proposal.\n",
		date: DATE,
		env: clone.env,
	});
	return { ...clone, tree, commit, blobIds };
}

function lsTree(dir: string, rev: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const record of gitBytes(dir, ["ls-tree", "-r", "-z", rev])
		.toString("latin1")
		.split("\0")) {
		if (record === "") {
			continue;
		}
		const tab = record.indexOf("\t");
		out.set(
			Buffer.from(record.slice(tab + 1), "latin1").toString("utf8"),
			record.slice(0, tab),
		);
	}
	return out;
}

describe.skipIf(!hasGit)(
	"proposal git plumbing against real git (spec §7)",
	() => {
		beforeAll(async () => {
			work = await mkdtemp(path.join(tmpdir(), "proposal-real-git-"));
			source = path.join(work, "source");
			await mkdir(path.join(source, "agents", "nested"), {
				recursive: true,
			});
			await writeFile(path.join(source, "agents/a.md"), "one\n");
			await writeFile(
				path.join(source, "agents/nested/deep.md"),
				"deep\n",
			);
			await writeFile(path.join(source, "agents/run.sh"), "#!/bin/sh\n");
			await chmod(path.join(source, "agents/run.sh"), 0o755);
			await symlink("a.md", path.join(source, "agents/link.md"));
			await writeFile(
				Buffer.concat([Buffer.from(`${source}/`), NON_UTF8]),
				"bad\n",
			);
			await writeFile(path.join(source, "other.md"), "keep\n");
			git(source, ["init", "-q", "-b", "main"]);
			git(source, ["config", "uploadpack.allowFilter", "true"]);
			git(source, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
			git(source, ["add", "-A"]);
			const zero = commitAll("zero");
			git(source, [
				"update-index",
				"--add",
				"--cacheinfo",
				`160000,${zero},agents/sub`,
			]);
			base = commitAll("base");
			await writeFile(path.join(source, "other.md"), "moved\n");
			git(source, ["add", "other.md"]);
			tip = commitAll("moved past the base");
			// A remote that refuses one branch name the way a hosting provider
			// refuses a push: through the report-status reason and `remote:` lines.
			await writeFile(
				path.join(source, ".git", "hooks", "pre-receive"),
				'#!/bin/sh\nwhile read old new ref; do case "$ref" in *hooked*) echo "an active pull request uses this branch" >&2; exit 1;; esac; done\nexit 0\n',
			);
			await chmod(
				path.join(source, ".git", "hooks", "pre-receive"),
				0o755,
			);
		});

		afterAll(async () => {
			await rm(work, { recursive: true, force: true });
		});

		it("lists blobs, symlinks, a gitlink and a non-UTF-8 path under the root, byte-exactly", async () => {
			const { dir, env } = await freshClone("list");
			const listed = await listTreeRaw({
				dir,
				sha: base,
				rootPath: "agents",
				maxEntries: 100,
				env,
			});
			expect(listed.ok).toBe(true);
			if (!listed.ok) {
				return;
			}
			const byPath = new Map<string | null, RawTreeEntry>(
				listed.entries.map((e) => [e.path, e]),
			);
			expect(byPath.get("agents/a.md")).toMatchObject({
				mode: "100644",
				type: "blob",
			});
			expect(byPath.get("agents/nested/deep.md")?.mode).toBe("100644");
			expect(byPath.get("agents/run.sh")?.mode).toBe("100755");
			expect(byPath.get("agents/link.md")).toMatchObject({
				mode: "120000",
				type: "blob",
			});
			expect(byPath.get("agents/sub")).toMatchObject({
				mode: "160000",
				type: "commit",
			});
			const bad = listed.entries.find((e) => e.path === null);
			expect(bad?.rawPath.equals(NON_UTF8)).toBe(true);
			expect(bad?.mode).toBe("100644");
			expect(listed.entries.some((e) => e.path === "other.md")).toBe(
				false,
			);
			expect(listed.entries).toHaveLength(6);
			for (const entry of listed.entries) {
				expect(entry.oid).toMatch(/^[0-9a-f]{40}$/);
			}
		});

		it("lists the whole tree for an empty root and stops at its entry cap", async () => {
			const { dir, env } = await freshClone("list-cap");
			const all = await listTreeRaw({
				dir,
				sha: base,
				rootPath: "",
				maxEntries: 100,
				env,
			});
			expect(
				all.ok && all.entries.some((e) => e.path === "other.md"),
			).toBe(true);
			expect(
				await listTreeRaw({
					dir,
					sha: base,
					rootPath: "",
					maxEntries: 3,
					env,
				}),
			).toEqual({ ok: false });
		});

		it("writes a blob from Buffer stdin byte-exactly", async () => {
			const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a]);
			const { dir, blobIds } = await buildCommit("bytes", [
				{ path: "agents/bin.md", mode: "100644", bytes },
			]);
			const oid = blobIds.get("agents/bin.md") as string;
			expect(gitBytes(dir, ["cat-file", "blob", oid]).equals(bytes)).toBe(
				true,
			);
			const independent = execFileSync(
				"git",
				["hash-object", "--no-filters", "--stdin"],
				{ input: bytes, encoding: "utf8" },
			).trim();
			expect(oid).toBe(independent);
		});

		it("writes a tree while unchanged blobs are missing locally", async () => {
			const clone = await freshClone("missing");
			const missingBefore = missingObjects(clone.dir, base);
			expect(missingBefore.length).toBeGreaterThan(0);
			const indexFile = path.join(clone.run, "index");
			await readBaseTree({
				dir: clone.dir,
				sha: base,
				indexFile,
				env: clone.env,
			});
			const { tree } = await writeProposalTree({
				dir: clone.dir,
				indexFile,
				delta: DELTA,
				env: clone.env,
			});
			expect(tree).toMatch(/^[0-9a-f]{40}$/);
			// Nothing was lazily fetched to write the tree.
			expect(missingObjects(clone.dir, base)).toEqual(missingBefore);
		});

		it("changes exactly the delta: nested root, kept modes, a new 100755 file, a delete, untouched neighbours", async () => {
			const { dir, commit } = await buildCommit("delta");
			const before = lsTree(dir, base);
			const after = lsTree(dir, commit);
			expect(after.has("agents/a.md")).toBe(false);
			expect(after.get("agents/new.sh")).toMatch(/^100755 blob /);
			expect(after.get("agents/nested/deep.md")).not.toBe(
				before.get("agents/nested/deep.md"),
			);
			for (const kept of [
				"agents/run.sh",
				"agents/link.md",
				"agents/sub",
				"other.md",
			]) {
				expect(after.get(kept)).toBe(before.get(kept));
			}
			expect(after.get("agents/run.sh")).toMatch(/^100755 /);
			expect(after.get("agents/link.md")).toMatch(/^120000 /);
			expect(after.get("agents/sub")).toMatch(/^160000 commit /);
			expect(after.size).toBe(before.size);
		});

		it("produces the identical SHA on two builds", async () => {
			const one = await buildCommit("repro-1");
			const two = await buildCommit("repro-2");
			expect(one.tree).toBe(two.tree);
			expect(one.commit).toBe(two.commit);
			expect(git(one.dir, ["cat-file", "-p", one.commit])).toContain(
				`author Example Person <${MAIL}> ${Date.parse(DATE) / 1000} +0000`,
			);
		});

		it("diffTreeEntries returns exactly the delta", async () => {
			const { dir, env, commit, blobIds } = await buildCommit("diff");
			const entries = await diffTreeEntries({
				dir,
				from: base,
				to: commit,
				env,
			});
			expect(
				[...entries].sort((a, b) => a.path.localeCompare(b.path)),
			).toEqual([
				{
					status: "D",
					path: "agents/a.md",
					oldMode: "100644",
					newMode: "000000",
					newOid: "0".repeat(40),
				},
				{
					status: "M",
					path: "agents/nested/deep.md",
					oldMode: "100644",
					newMode: "100644",
					newOid: blobIds.get("agents/nested/deep.md"),
				},
				{
					status: "A",
					path: "agents/new.sh",
					oldMode: "000000",
					newMode: "100755",
					newOid: blobIds.get("agents/new.sh"),
				},
			]);
		});

		it("pushes create-only, reports our own SHA and another SHA as existing, and a remote refusal as refused", async () => {
			const built = await buildCommit("push");
			const b = branch("push");
			expect(
				await pushCreateOnly({
					dir: built.dir,
					sha: built.commit,
					branch: b,
					env: built.env,
				}),
			).toEqual({ kind: "created" });
			expect(git(source, ["rev-parse", `refs/heads/${b}`])).toBe(
				built.commit,
			);
			// "refuses a create-only push at our own SHA" (R21): never adopted by SHA.
			expect(
				await pushCreateOnly({
					dir: built.dir,
					sha: built.commit,
					branch: b,
					env: built.env,
				}),
			).toEqual({ kind: "exists" });
			expect(
				await pushCreateOnly({
					dir: built.dir,
					sha: base,
					branch: b,
					env: built.env,
				}),
			).toEqual({ kind: "exists" });
			expect(git(source, ["rev-parse", `refs/heads/${b}`])).toBe(
				built.commit,
			);
			expect(
				await pushCreateOnly({
					dir: built.dir,
					sha: built.commit,
					branch: branch("hooked"),
					env: built.env,
				}),
			).toEqual({ kind: "refused" });
		});

		it("rethrows a push that fails before any ref is reported", async () => {
			const built = await buildCommit("push-fail");
			git(built.dir, [
				"remote",
				"set-url",
				"origin",
				`file://${path.join(work, "no-such-repo")}`,
			]);
			await expect(
				pushCreateOnly({
					dir: built.dir,
					sha: built.commit,
					branch: branch("pushfail"),
					env: built.env,
				}),
			).rejects.toMatchObject({ name: "GitCommandError", kind: "exit" });
		});

		it("lsRemoteRef returns the exact ref, and missing when only a tail-matching look-alike exists", async () => {
			const b = branch("lookalike");
			git(source, ["branch", `x/refs/heads/${b}`, base]);
			const env = proposalEnv(work);
			const url = `file://${source}`;
			expect(
				await lsRemoteRef({ cwd: work, url, branch: b, env }),
			).toEqual({
				kind: "missing",
			});
			git(source, ["branch", b, tip]);
			expect(
				await lsRemoteRef({ cwd: work, url, branch: b, env }),
			).toEqual({
				kind: "found",
				sha: tip,
			});
		});

		it("deletes only at the leased SHA: deleted, stale at a moved tip, absent, refused", async () => {
			const env = proposalEnv(work);
			const url = `file://${source}`;
			const ours = branch("delete");
			git(source, ["branch", ours, base]);
			// "refuses a leased delete at a moved tip"
			expect(
				await deleteBranch({
					cwd: work,
					url,
					branch: ours,
					sha: tip,
					env,
				}),
			).toEqual({ kind: "stale" });
			expect(git(source, ["rev-parse", `refs/heads/${ours}`])).toBe(base);
			expect(
				await deleteBranch({
					cwd: work,
					url,
					branch: ours,
					sha: base,
					env,
				}),
			).toEqual({ kind: "deleted" });
			expect(
				await lsRemoteRef({ cwd: work, url, branch: ours, env }),
			).toEqual({ kind: "missing" });
			expect(
				await deleteBranch({
					cwd: work,
					url,
					branch: branch("neverpushed"),
					sha: base,
					env,
				}),
			).toEqual({ kind: "absent" });
			const guarded = branch("hookeddelete");
			git(source, ["branch", guarded, base]);
			expect(
				await deleteBranch({
					cwd: work,
					url,
					branch: guarded,
					sha: base,
					env,
				}),
			).toEqual({ kind: "refused", activePullRequest: true });
			expect(git(source, ["rev-parse", `refs/heads/${guarded}`])).toBe(
				base,
			);
		});

		it("kills the process group when the signal aborts mid-push", async () => {
			const built = await buildCommit("abort");
			const sleepBin = execFileSync("sh", ["-c", "command -v sleep"], {
				encoding: "utf8",
			}).trim();
			const fakeBin = path.join(work, "fake-bin");
			await mkdir(fakeBin, { recursive: true });
			await writeFile(
				path.join(fakeBin, "git"),
				`#!/bin/sh\nexec ${sleepBin} 30\n`,
			);
			await chmod(path.join(fakeBin, "git"), 0o755);
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);
			const started = Date.now();
			await expect(
				pushCreateOnly({
					dir: built.dir,
					sha: built.commit,
					branch: branch("abort"),
					env: { ...built.env, PATH: fakeBin },
					signal: controller.signal,
				}),
			).rejects.toMatchObject({ kind: "cancelled", label: "push" });
			expect(Date.now() - started).toBeLessThan(10_000);
		});

		it("keeps the token out of argv and output", async () => {
			const traceFile = path.join(work, "trace.log");
			const built = await buildCommit("token");
			const env = {
				...proposalEnv(built.run, {}, TOKEN),
				GIT_TRACE: traceFile,
			};
			const b = branch("token");
			expect(
				await pushCreateOnly({
					dir: built.dir,
					sha: built.commit,
					branch: b,
					env,
				}),
			).toEqual({ kind: "created" });
			expect(
				await pushCreateOnly({
					dir: built.dir,
					sha: built.commit,
					branch: b,
					env,
				}),
			).toEqual({ kind: "exists" });
			const url = `file://${source}`;
			expect(
				await lsRemoteRef({ cwd: built.run, url, branch: b, env }),
			).toMatchObject({ kind: "found" });
			expect(
				await deleteBranch({
					cwd: built.run,
					url,
					branch: b,
					sha: built.commit,
					env,
				}),
			).toEqual({ kind: "deleted" });
			const trace = await readFile(traceFile, "utf8");
			// The trace lists every argv git ran, the push and its transport included.
			expect(trace).toContain("push");
			expect(trace).toContain("ls-remote");
			expect(trace).not.toContain(TOKEN);
			// A failing call with the trace on stderr: the token never reached it at
			// all (not merely redacted), and neither tail carries it.
			const failed = (await lsRemoteRef({
				cwd: built.run,
				url: `file://${path.join(work, "no-such-repo")}`,
				branch: b,
				env: { ...env, GIT_TRACE: "1" },
			}).catch((e: unknown) => e)) as GitCommandError;
			expect(failed).toBeInstanceOf(GitCommandError);
			expect(failed.stderrTail).toContain("trace:");
			expect(failed.stderrTail).toContain("ls-remote");
			expect(failed.stderrTail).not.toContain(TOKEN);
			expect(failed.stderrTail).not.toContain("***");
			expect(failed.stdoutTail ?? "").not.toContain(TOKEN);
		});
	},
);

// Outside the skipIf: these refuse before anything spawns, or use only `sh`.
describe("proposal plumbing guards", () => {
	it.each([
		"main",
		"fabric/instructions/../x",
		"-x",
		"fabric/instructions/",
		"fabric/instructions/C0000000000000000000000a",
		"fabric/instructions/c000000000000000000000000",
		"fabric/instructions/c00000000000000000000000-1",
		"fabric/instructions/c00000000000000000000000-01",
		"refs/heads/fabric/instructions/c00000000000000000000000",
	])("assertOperationBranch refuses %s", (value) => {
		expect(() => assertOperationBranch(value)).toThrow(GitCommandError);
	});

	it.each([
		"fabric/instructions/c00000000000000000000000",
		"fabric/instructions/cexample000000000000000a-2",
		"fabric/instructions/cexample000000000000000a-10",
		"fabric/instructions/cexample000000000000000a-9999",
	])("assertOperationBranch accepts %s", (value) => {
		expect(() => assertOperationBranch(value)).not.toThrow();
	});

	it("refuses a bad branch, SHA or URL before git spawns", async () => {
		const env = buildGitEnv({ home: tmpdir() });
		const sha = "a".repeat(40);
		await expect(
			pushCreateOnly({ dir: tmpdir(), sha, branch: "main", env }),
		).rejects.toMatchObject({ kind: "invalid_argument" });
		await expect(
			pushCreateOnly({
				dir: tmpdir(),
				sha: "--upload-pack=x",
				branch: branch("x"),
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
		await expect(
			deleteBranch({
				cwd: tmpdir(),
				url: `https://token@${"example.com"}/example-org/example-repo`,
				branch: branch("x"),
				sha,
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
		await expect(
			lsRemoteRef({
				cwd: tmpdir(),
				url: "https://example.com/example-org/example-repo",
				branch: "-x",
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
		await expect(
			commitTree({
				dir: tmpdir(),
				tree: "HEAD",
				parent: sha,
				author: PERSON,
				committer: FABRIC,
				message: "m",
				date: DATE,
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
	});

	it("refuses a delta path that would escape or break the index framing", async () => {
		const env = buildGitEnv({ home: tmpdir() });
		for (const bad of ["/abs.md", "a/../b.md", "a//b.md", "a\0b.md", ""]) {
			await expect(
				writeProposalTree({
					dir: tmpdir(),
					indexFile: path.join(tmpdir(), "never"),
					delta: [{ path: bad, delete: true }],
					env,
				}),
			).rejects.toMatchObject({ kind: "invalid_argument" });
		}
	});

	it("keeps a redacted stdout tail on a non-zero exit", async () => {
		const error = (await runBoundedProcess({
			command: "sh",
			args: ["-c", "echo 'ok secret-value'; exit 2"],
			cwd: tmpdir(),
			env: { PATH: process.env.PATH },
			label: "push",
			secrets: ["secret-value"],
		}).catch((e: unknown) => e)) as GitCommandError;
		expect(error.kind).toBe("exit");
		expect(error.stdoutTail).toBe("ok ***\n");
		expect(error.message).toBe("git push failed (exit)");
	});

	describe("a push refused before any ref is reported (Fizzy #2563)", () => {
		const url = "https://git.example.com/example-org/example-repo.git/";
		const http403 = `fatal: unable to access '${url}': The requested URL returned error: 403`;
		let fake: string;
		let fakeBin: string;

		beforeAll(async () => {
			fake = await mkdtemp(path.join(tmpdir(), "proposal-fake-git-"));
			fakeBin = path.join(fake, "bin");
			await mkdir(fakeBin, { recursive: true });
			// `init --bare` (deleteBranch's scratch repository) succeeds; any
			// other call prints the given stderr and fails as git does.
			await writeFile(
				path.join(fakeBin, "git"),
				[
					"#!/bin/sh",
					'for a in "$@"; do [ "$a" = init ] && exit 0; done',
					'printf "%s\\n" "$FAKE_GIT_STDERR" >&2',
					"exit 128",
					"",
				].join("\n"),
			);
			await chmod(path.join(fakeBin, "git"), 0o755);
		});
		afterAll(async () => {
			await rm(fake, { recursive: true, force: true });
		});

		const fakeEnv = (stderr: string) => ({
			PATH: fakeBin,
			FAKE_GIT_STDERR: stderr,
		});
		const sha = "a".repeat(40);

		const refusals: Array<[string, string]> = [
			[
				"GitHub, an App with read-only Contents",
				`remote: Write access to repository not granted.\n${http403}`,
			],
			[
				"GitHub, a user without push rights",
				`remote: Permission to example-org/example-repo.git denied to example-user.\n${http403}`,
			],
			[
				"GitLab, no push rights on the project",
				`remote: You are not allowed to push code to this project.\n${http403}`,
			],
			[
				"GitLab, a protected branch",
				"remote: GitLab: You are not allowed to push code to protected branches on this project.",
			],
			[
				"Azure DevOps, no Contribute permission",
				`remote: TF401027: You need the Git 'GenericContribute' permission to perform this action.\n${http403}`,
			],
		];
		const credentialFailures: Array<[string, string]> = [
			[
				"a rejected token",
				`remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for '${url}'`,
			],
			[
				"authentication wording beside a 403",
				`remote: HTTP Basic: Access denied.\n${http403}`,
			],
			[
				"a GitHub SAML SSO wall beside a 403",
				`remote: The 'example-org' organization has enabled or enforced SAML SSO.\nremote: To access this repository, you must re-authorize the OAuth Application.\n${http403}`,
			],
		];

		it.each(refusals)(
			"pushCreateOnly reports %s as refused",
			async (_provider, stderr) => {
				expect(
					await pushCreateOnly({
						dir: fake,
						sha,
						branch: branch("httprefused"),
						env: fakeEnv(stderr),
					}),
				).toEqual({ kind: "refused" });
			},
		);

		it.each(refusals)(
			"deleteBranch reports %s as refused, not an active pull request",
			async (_provider, stderr) => {
				expect(
					await deleteBranch({
						cwd: fake,
						url,
						branch: branch("httprefused"),
						sha,
						env: fakeEnv(stderr),
					}),
				).toEqual({ kind: "refused", activePullRequest: false });
			},
		);

		it.each(credentialFailures)(
			"pushCreateOnly and deleteBranch rethrow %s as a credential failure",
			async (_case, stderr) => {
				const pushError = await pushCreateOnly({
					dir: fake,
					sha,
					branch: branch("httpauth"),
					env: fakeEnv(stderr),
				}).catch((e: unknown) => e);
				expect(pushError).toMatchObject({
					name: "GitCommandError",
					kind: "exit",
				});
				expect(isCredentialFailure(pushError)).toBe(true);
				const deleteError = await deleteBranch({
					cwd: fake,
					url,
					branch: branch("httpauth"),
					sha,
					env: fakeEnv(stderr),
				}).catch((e: unknown) => e);
				expect(deleteError).toMatchObject({
					name: "GitCommandError",
					kind: "exit",
				});
				expect(isCredentialFailure(deleteError)).toBe(true);
			},
		);

		it("rethrows a bare 403 that names no write refusal", async () => {
			const error = await pushCreateOnly({
				dir: fake,
				sha,
				branch: branch("httpbare"),
				env: fakeEnv(http403),
			}).catch((e: unknown) => e);
			expect(error).toMatchObject({
				name: "GitCommandError",
				kind: "exit",
			});
			expect(isCredentialFailure(error)).toBe(false);
		});

		it("still rethrows an unreachable remote", async () => {
			await expect(
				pushCreateOnly({
					dir: fake,
					sha,
					branch: branch("httpother"),
					env: fakeEnv(
						`fatal: unable to access '${url}': Could not resolve host: git.example.com`,
					),
				}),
			).rejects.toMatchObject({ name: "GitCommandError", kind: "exit" });
		});
	});

	it("accepts Buffer stdin", async () => {
		const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a]);
		const result = await runBoundedProcess({
			command: "sh",
			args: ["-c", "cat"],
			cwd: tmpdir(),
			env: { PATH: process.env.PATH },
			stdin: bytes,
			label: "test",
		});
		expect(result.stdout.equals(bytes)).toBe(true);
	});
});
