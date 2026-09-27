import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	fetchPullRequestHead,
	initBranchWorkspace,
	isAncestor,
	pushFastForward,
	readTreeEntries,
	revListOutside,
} from "../instruction-branch-git";
import { buildGitEnv, GitCommandError } from "../instruction-sync-git";

// No real git is ever spawned in this file: every case here throws (or
// short-circuits) before a git process would be scheduled. The scenarios
// that need real git (`assertMemberBranch`'s accept case, `pushFastForward`'s
// classification, provenance across a merge/rebase, ...) live in
// instruction-branch-git.real-git.test.ts.

const env = buildGitEnv({ home: tmpdir() });
const validSha = "a".repeat(40);
const validBranch = "fabric/instructions/members/dev-example-a1b2/1";

describe("readTreeEntries", () => {
	it("returns an empty map without running git when no paths are asked for", async () => {
		const result = await readTreeEntries({
			dir: tmpdir(),
			sha: validSha,
			rawPaths: [],
			env,
		});
		expect(result.size).toBe(0);
	});

	it("refuses a malformed sha before spawning git", async () => {
		await expect(
			readTreeEntries({
				dir: tmpdir(),
				sha: "--upload-pack=x",
				rawPaths: ["agents/a.md"],
				env,
			}),
		).rejects.toMatchObject({
			name: "GitCommandError",
			kind: "invalid_argument",
		});
	});

	it("refuses a raw path that would escape or break the pathspec framing", async () => {
		for (const bad of ["/abs.md", "a/../b.md", "a//b.md", "a\0b.md", ""]) {
			await expect(
				readTreeEntries({
					dir: tmpdir(),
					sha: validSha,
					rawPaths: [bad],
					env,
				}),
			).rejects.toMatchObject({ kind: "invalid_argument" });
		}
	});
});

describe("isAncestor / revListOutside argument guards", () => {
	it("isAncestor refuses a malformed object id before spawning git", async () => {
		await expect(
			isAncestor({
				dir: tmpdir(),
				ancestor: "-x",
				descendant: validSha,
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
		await expect(
			isAncestor({
				dir: tmpdir(),
				ancestor: validSha,
				descendant: "not-a-sha",
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
	});

	it("revListOutside refuses a malformed range or path before spawning git", async () => {
		await expect(
			revListOutside({
				dir: tmpdir(),
				from: "--x",
				to: validSha,
				known: new Set(),
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
		await expect(
			revListOutside({
				dir: tmpdir(),
				from: validSha,
				to: validSha,
				known: new Set(),
				rawPath: "a/../b.md",
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
	});
});

describe("pushFastForward argument guards", () => {
	it("refuses a malformed sha, branch or parent before spawning git", async () => {
		await expect(
			pushFastForward({
				dir: tmpdir(),
				parentSha: "-x",
				sha: validSha,
				branch: validBranch,
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
		await expect(
			pushFastForward({
				dir: tmpdir(),
				parentSha: validSha,
				sha: "-x",
				branch: validBranch,
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
		await expect(
			pushFastForward({
				dir: tmpdir(),
				parentSha: validSha,
				sha: validSha,
				// A #2563 per-proposal-shaped ref, never a member branch.
				branch: "fabric/instructions/cexample000000000000000a",
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
	});
});

describe("fetchPullRequestHead argument guards", () => {
	it("refuses a malformed sha or provider ref before spawning git", async () => {
		await expect(
			fetchPullRequestHead({
				dir: tmpdir(),
				ref: "refs/pull/1/head",
				sha: "not-a-sha",
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
		for (const bad of [
			"pull/1/head",
			"refs/pull/1/head:x",
			"-x",
			"refs/../etc",
		]) {
			await expect(
				fetchPullRequestHead({
					dir: tmpdir(),
					ref: bad,
					sha: validSha,
					env,
				}),
			).rejects.toMatchObject({ kind: "invalid_argument" });
		}
	});
});

describe("initBranchWorkspace argument guards", () => {
	it("refuses a URL carrying credentials or extra components before spawning git", async () => {
		await expect(
			initBranchWorkspace({
				url: "https://token@example.com/example-org/example-repo",
				targetRef: "main",
				dir: `${tmpdir()}/never`,
				env,
			}),
		).rejects.toMatchObject({
			name: "GitCommandError",
			kind: "invalid_argument",
		});
		await expect(
			initBranchWorkspace({
				url: "https://example.com/example-org/example-repo?x=1",
				targetRef: "main",
				dir: `${tmpdir()}/never`,
				env,
			}),
		).rejects.toMatchObject({ kind: "invalid_argument" });
	});
});

describe("GitCommandError shape", () => {
	it("carries no argv or stderr in its message", () => {
		const error = new GitCommandError("invalid_argument", null, "", "push");
		expect(error.message).toBe("git push failed (invalid_argument)");
	});
});
