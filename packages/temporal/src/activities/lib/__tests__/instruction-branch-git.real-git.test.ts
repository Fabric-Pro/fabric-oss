import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertMemberBranch,
	fetchBranchHead,
	fetchPullRequestHead,
	initBranchWorkspace,
	isAncestor,
	pushFastForward,
	readTreeEntries,
	revListOutside,
} from "../instruction-branch-git";
import {
	buildGitEnv,
	commitTree,
	GitCommandError,
	pushCreateOnly,
	readBaseTree,
	type TreeDeltaEntry,
	writeProposalTree,
} from "../instruction-sync-git";

// Real git over file:// (member proposal branch spec §7), in the pattern of
// instruction-proposal-git.real-git.test.ts. Skipped cleanly where git is
// absent.
let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}

const MAIL = ["dev", "example.com"].join("@");
const PERSON = { name: "Example Person", email: MAIL };
const FABRIC = { name: "Fabric", email: ["noreply", "example.com"].join("@") };
const DATE = "2026-09-26T00:00:00Z";

/** A well-formed member proposal branch ref, one per test to avoid cross-test coupling. */
function memberBranch(tag: string): string {
	return `fabric/instructions/members/${tag}-a1b2/1`;
}

/** A #2563 operation branch ref (disjoint pattern), which nothing pushes any more (Fizzy #2748). */
function operationBranch(tag: string): string {
	return `fabric/instructions/c${tag.padEnd(23, "0")}`;
}

let work: string;
let source: string;
let base: string;
let idxCounter = 0;

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

function setBranch(name: string, sha: string): void {
	git(source, ["update-ref", `refs/heads/${name}`, sha]);
}

/** The production env, plus the file protocol for this test only. */
function sourceEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...buildGitEnv({ home: work }),
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "protocol.file.allow",
		GIT_CONFIG_VALUE_0: "always",
		...extra,
	};
}

/**
 * Builds a commit directly against `source`'s own object database (no
 * checkout, no clone): plumbing-only, like the base fixture's own commits, so
 * every test's topology lives in one repository and a workspace fetches only
 * what a real workflow step would fetch.
 */
async function buildOn(
	parent: string,
	delta: readonly TreeDeltaEntry[],
	message: string,
): Promise<string> {
	const indexFile = path.join(work, `idx-${idxCounter++}`);
	const env = sourceEnv();
	await readBaseTree({ dir: source, sha: parent, indexFile, env });
	const { tree } = await writeProposalTree({
		dir: source,
		indexFile,
		delta,
		env,
	});
	return commitTree({
		dir: source,
		tree,
		parent,
		author: PERSON,
		committer: FABRIC,
		message,
		date: DATE,
		env,
	});
}

async function freshWorkspace(name: string): Promise<{
	run: string;
	dir: string;
	env: NodeJS.ProcessEnv;
}> {
	const run = path.join(work, name);
	await mkdir(run, { recursive: true });
	const dir = path.join(run, "repo");
	const env = sourceEnv();
	await initBranchWorkspace({
		url: `file://${source}`,
		targetRef: "main",
		dir,
		env,
	});
	return { run, dir, env };
}

describe.skipIf(!hasGit)(
	"member proposal branch git plumbing against real git (spec §7)",
	() => {
		beforeAll(async () => {
			work = await mkdtemp(path.join(tmpdir(), "branch-real-git-"));
			source = path.join(work, "source");
			await mkdir(path.join(source, "agents", "nested"), {
				recursive: true,
			});
			await writeFile(path.join(source, "agents/a.md"), "one\n");
			await writeFile(path.join(source, "agents/exe.sh"), "#!/bin/sh\n");
			await chmod(path.join(source, "agents/exe.sh"), 0o755);
			await writeFile(
				path.join(source, "agents/nested/deep.md"),
				"deep\n",
			);
			await writeFile(path.join(source, "other.md"), "keep\n");
			git(source, ["init", "-q", "-b", "main"]);
			git(source, ["config", "uploadpack.allowFilter", "true"]);
			git(source, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
			git(source, ["add", "-A"]);
			base = commitAll("base");
		});

		afterAll(async () => {
			await rm(work, { recursive: true, force: true });
		});

		it("fetchBranchHead reports absent, then follows a moved (non-fast-forward) tip", async () => {
			const branch = memberBranch("moved");
			const { dir, env } = await freshWorkspace("moved");
			expect(await fetchBranchHead({ dir, branch, env })).toEqual({
				kind: "absent",
			});
			const sibling1 = await buildOn(base, [], "sibling 1");
			setBranch(branch, sibling1);
			expect(await fetchBranchHead({ dir, branch, env })).toEqual({
				kind: "present",
				sha: sibling1,
			});
			// sibling2 is not a descendant of sibling1 (both are children of
			// base): a genuine non-fast-forward move of the remote branch, so
			// only the `+` refspec forces the local tip ref to follow it.
			const sibling2 = await buildOn(base, [], "sibling 2");
			setBranch(branch, sibling2);
			expect(await fetchBranchHead({ dir, branch, env })).toEqual({
				kind: "present",
				sha: sibling2,
			});
		});

		it("pushFastForward pushes, then refuses a stale lease when origin moved", async () => {
			const branch = memberBranch("stale");
			setBranch(branch, base);
			const { dir, env } = await freshWorkspace("stale");
			const c1 = await commitTree({
				dir,
				tree: git(source, ["rev-parse", `${base}^{tree}`]),
				parent: base,
				author: PERSON,
				committer: FABRIC,
				message: "first append",
				date: DATE,
				env,
			});
			expect(
				await pushFastForward({
					dir,
					parentSha: base,
					sha: c1,
					branch,
					env,
				}),
			).toEqual({ kind: "pushed" });
			expect(git(source, ["rev-parse", `refs/heads/${branch}`])).toBe(c1);
			// Origin moves out from under the workspace's lease.
			const hand = await buildOn(base, [], "hand edit");
			setBranch(branch, hand);
			const c2 = await commitTree({
				dir,
				tree: git(source, ["rev-parse", `${c1}^{tree}`]),
				parent: c1,
				author: PERSON,
				committer: FABRIC,
				message: "second append",
				date: DATE,
				env,
			});
			expect(
				await pushFastForward({
					dir,
					parentSha: c1,
					sha: c2,
					branch,
					env,
				}),
			).toEqual({ kind: "stale" });
			expect(git(source, ["rev-parse", `refs/heads/${branch}`])).toBe(
				hand,
			);
		});

		it("pushFastForward refuses before pushing when sha's parent is not parentSha", async () => {
			const branch = memberBranch("parentcheck");
			setBranch(branch, base);
			const { dir, env } = await freshWorkspace("parentcheck");
			const c1 = await commitTree({
				dir,
				tree: git(source, ["rev-parse", `${base}^{tree}`]),
				parent: base,
				author: PERSON,
				committer: FABRIC,
				message: "c1",
				date: DATE,
				env,
			});
			const c2 = await commitTree({
				dir,
				// c1 was never pushed: it exists only in the workspace, so its
				// tree must be read from `dir`, not `source`.
				tree: git(dir, ["rev-parse", `${c1}^{tree}`]),
				parent: c1,
				author: PERSON,
				committer: FABRIC,
				message: "c2",
				date: DATE,
				env,
			});
			await expect(
				pushFastForward({
					dir,
					// c2's real parent is c1, not base: must throw before push.
					parentSha: base,
					sha: c2,
					branch,
					env,
				}),
			).rejects.toMatchObject({
				name: "GitCommandError",
				kind: "invalid_argument",
			});
			expect(git(source, ["rev-parse", `refs/heads/${branch}`])).toBe(
				base,
			);
		});

		it("revListOutside reports a foreign side branch and the merge commit that brought it in", async () => {
			const m1 = await buildOn(base, [], "fabric append");
			const foreign = await buildOn(base, [], "foreign side branch");
			const mergeTree = git(source, ["rev-parse", `${m1}^{tree}`]);
			const merge = await commitTree({
				dir: source,
				tree: mergeTree,
				parent: m1,
				author: PERSON,
				committer: FABRIC,
				message: "merge",
				date: DATE,
				env: sourceEnv(),
			});
			// commitTree only takes one parent; attach the second with a raw
			// commit rewrite so the object is a genuine two-parent merge.
			// `execFileSync` (not the trimming `git()` helper) keeps the
			// commit's exact bytes, including its trailing message newline,
			// so the rewritten object re-hashes to something git accepts.
			const rawMerge = execFileSync(
				"git",
				["-C", source, "cat-file", "commit", merge],
				{ encoding: "utf8" },
			).replace(`parent ${m1}\n`, `parent ${m1}\nparent ${foreign}\n`);
			const realMerge = execFileSync(
				"git",
				["-C", source, "hash-object", "-w", "-t", "commit", "--stdin"],
				{ input: rawMerge, encoding: "utf8" },
			).trim();
			const known = new Set([base, m1]);
			const result = await revListOutside({
				dir: source,
				from: base,
				to: realMerge,
				known,
				env: sourceEnv(),
			});
			expect(result.kind).toBe("ok");
			expect(result.kind === "ok" && result.outside.sort()).toEqual(
				[foreign, realMerge].sort(),
			);
		});

		it("isAncestor is false once a rebase abandons the original commit", async () => {
			const original = await buildOn(base, [], "original");
			const rebased = await buildOn(base, [], "original (rebased)");
			expect(
				await isAncestor({
					dir: source,
					ancestor: original,
					descendant: rebased,
					env: sourceEnv(),
				}),
			).toBe("false");
		});

		it("revListOutside path-scopes: ignores a foreign commit on another path, reports a mode-only change on the queried path", async () => {
			const own = await buildOn(base, [], "fabric append");
			const otherPathChange = await buildOn(
				own,
				[
					{
						path: "other.md",
						mode: "100644",
						bytes: Buffer.from("moved\n"),
					},
				],
				"foreign change to another path",
			);
			const modeOnly = await buildOn(
				otherPathChange,
				[
					{
						path: "agents/a.md",
						mode: "100755",
						bytes: Buffer.from("one\n"),
					},
				],
				"foreign mode-only change",
			);
			const known = new Set([base, own]);
			const result = await revListOutside({
				dir: source,
				from: base,
				to: modeOnly,
				known,
				rawPath: "agents/a.md",
				env: sourceEnv(),
			});
			expect(result).toEqual({ kind: "ok", outside: [modeOnly] });
		});

		it("isAncestor: an unknown object id is error, a locally present but unreachable commit is false or error, never true", async () => {
			const tip = await buildOn(base, [], "tip");
			const unknown = "f".repeat(40);
			expect(
				await isAncestor({
					dir: source,
					ancestor: unknown,
					descendant: tip,
					env: sourceEnv(),
				}),
			).toBe("error");
			// A commit object that exists (hash-object -w) but is reachable
			// from no ref: never merged into tip's history.
			const danglingTree = git(source, ["rev-parse", `${base}^{tree}`]);
			const rawCommit = [
				`tree ${danglingTree}`,
				`author ${PERSON.name} <${PERSON.email}> 1758844800 +0000`,
				`committer ${FABRIC.name} <${FABRIC.email}> 1758844800 +0000`,
				"",
				"dangling",
				"",
			].join("\n");
			const dangling = execFileSync(
				"git",
				["-C", source, "hash-object", "-w", "-t", "commit", "--stdin"],
				{ input: rawCommit, encoding: "utf8" },
			).trim();
			const verdict = await isAncestor({
				dir: source,
				ancestor: dangling,
				descendant: tip,
				env: sourceEnv(),
			});
			expect(["false", "error"]).toContain(verdict);
		});

		it("readTreeEntries returns null for an absent path and the mode for an executable", async () => {
			const entries = await readTreeEntries({
				dir: source,
				sha: base,
				rawPaths: ["agents/exe.sh", "agents/missing.md"],
				env: sourceEnv(),
			});
			expect(entries.get("agents/missing.md")).toBeNull();
			expect(entries.get("agents/exe.sh")).toMatchObject({
				type: "blob",
				mode: "100755",
			});
		});

		it("assertMemberBranch accepts a well-formed ref and rejects malformed shapes", () => {
			expect(() =>
				assertMemberBranch(
					"fabric/instructions/members/dev-example-a1b2/1",
				),
			).not.toThrow();
			for (const bad of [
				"fabric/instructions/members/Dev/1",
				"fabric/instructions/members/dev-example-a1b2/0",
				"fabric/instructions/members/dev-example-a1b2/1/",
				"fabric/instructions/abcdefghijklmnopqrstuvwx",
			]) {
				expect(() => assertMemberBranch(bad)).toThrow(GitCommandError);
			}
		});

		it("pushCreateOnly refuses a #2563 operation-shaped ref: only a member branch is pushed", async () => {
			const env = sourceEnv();
			await expect(
				pushCreateOnly({
					dir: source,
					sha: base,
					branch: operationBranch("mismatch"),
					env,
				}),
			).rejects.toMatchObject({ kind: "invalid_argument" });
			expect(
				git(source, ["for-each-ref", "--format=%(refname)"]),
			).not.toContain(operationBranch("mismatch"));
		});

		it("initBranchWorkspace clones full (never shallow)", async () => {
			const { dir } = await freshWorkspace("noshallow");
			await expect(
				access(path.join(dir, ".git", "shallow")),
			).rejects.toThrow();
		});

		it("fetchPullRequestHead confirms the provider's head equals the observed sha, else unavailable", async () => {
			const { dir, env } = await freshWorkspace("prhead");
			const prSha = await buildOn(base, [], "pr commit");
			git(source, ["update-ref", "refs/pull/1/head", prSha]);
			expect(
				await fetchPullRequestHead({
					dir,
					ref: "refs/pull/1/head",
					sha: prSha,
					env,
				}),
			).toEqual({ kind: "ok" });
			expect(
				await fetchPullRequestHead({
					dir,
					ref: "refs/pull/1/head",
					sha: base,
					env,
				}),
			).toEqual({ kind: "unavailable" });
			expect(
				await fetchPullRequestHead({
					dir,
					ref: "refs/pull/999/head",
					sha: prSha,
					env,
				}),
			).toEqual({ kind: "unavailable" });
		});
	},
);
