import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runHook } from "./_helpers.mjs";

/**
 * A session opened in the main checkout that works inside a worktree must be
 * judged against THAT worktree. `git status` with no `cwd` reads the directory
 * the hook process was spawned in — the main checkout — so a clean main and a
 * dirty worktree used to read as "nothing to lose" and `git reset --hard`
 * sailed through.
 *
 * These cases run real git rather than the FABRIC_TEST_IS_DIRTY seam: the seam
 * short-circuits before the git call, which is exactly the code under test.
 */

let root;
let mainTree;
let worktree;

const git = (cwd, ...args) =>
	execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });

before(() => {
	root = mkdtempSync(path.join(tmpdir(), "fabric-wt-"));
	mainTree = path.join(root, "main");
	worktree = path.join(root, "feature");

	execFileSync("git", ["init", "-q", "-b", "master", mainTree], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	git(mainTree, "config", "user.email", "test@example.com");
	git(mainTree, "config", "user.name", "test");
	writeFileSync(path.join(mainTree, "tracked.txt"), "original\n");
	git(mainTree, "add", "-A");
	git(mainTree, "commit", "-qm", "init");
	git(mainTree, "worktree", "add", "-q", "-b", "feature/x", worktree);

	// Dirty ONLY the worktree. The main checkout stays clean.
	writeFileSync(path.join(worktree, "tracked.txt"), "uncommitted edit\n");
});

after(() => {
	try {
		git(mainTree, "worktree", "remove", "--force", worktree);
	} catch {
		// best effort — the temp dir goes away regardless
	}
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Windows can hold a handle briefly; the OS reaps tmp anyway
	}
});

// The seam must be unset or it answers before git is ever consulted.
const realGit = { FABRIC_TEST_IS_DIRTY: undefined };

describe("block-destructive-bash — judges the tree the command runs in", () => {
	it("blocks `git reset --hard` when the payload cwd is a dirty worktree", async () => {
		const result = await runHook(
			"block-destructive-bash.mjs",
			{ tool_input: { command: "git reset --hard" }, cwd: worktree },
			{ env: realGit, spawnCwd: mainTree },
		);
		assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);
		assert.match(result.stderr, /uncommitted/);
	});

	it("allows `git reset --hard` when the payload cwd is the clean main checkout", async () => {
		const result = await runHook(
			"block-destructive-bash.mjs",
			{ tool_input: { command: "git reset --hard" }, cwd: mainTree },
			{ env: realGit, spawnCwd: mainTree },
		);
		assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
	});

	it("follows a leading `cd <worktree> &&` even when the payload cwd is clean", async () => {
		const result = await runHook(
			"block-destructive-bash.mjs",
			{
				tool_input: { command: `cd "${worktree}" && git reset --hard` },
				cwd: mainTree,
			},
			{ env: realGit, spawnCwd: mainTree },
		);
		assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);
	});

	it("still blocks when no cwd is supplied and the process tree is dirty", async () => {
		// Regression guard for the default path: omitting cwd must behave exactly
		// as before (execSync inherits the process cwd), not throw or fail open.
		const result = await runHook(
			"block-destructive-bash.mjs",
			{ tool_input: { command: "git reset --hard" } },
			{ env: { FABRIC_TEST_IS_DIRTY: "1" } },
		);
		assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);
	});
});

describe("enforce-branch-naming — reads the branch of the tree the push runs in", () => {
	it("blocks a push from a worktree whose branch breaks the convention", async () => {
		git(mainTree, "branch", "-q", "bad_branch_name");
		const badTree = path.join(root, "bad");
		git(mainTree, "worktree", "add", "-q", badTree, "bad_branch_name");

		const result = await runHook(
			"enforce-branch-naming.mjs",
			{ tool_input: { command: "git push origin HEAD" }, cwd: badTree },
			{ env: { FABRIC_TEST_BRANCH: undefined }, spawnCwd: mainTree },
		);
		assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);

		git(mainTree, "worktree", "remove", "--force", badTree);
	});
});
