import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runHook } from "./_helpers.mjs";

const HOOK = "enforce-branch-naming.mjs";

/**
 * Run the hook with a stubbed current branch (no real git lookup).
 *
 * @param {string} command
 * @param {string} branch  use `"__DETACHED__"` to simulate detached HEAD
 */
async function bashFromBranch(command, branch) {
	return runHook(
		HOOK,
		{ tool_name: "Bash", tool_input: { command } },
		{ env: { FABRIC_TEST_BRANCH: branch } },
	);
}

describe("enforce-branch-naming — blocks", () => {
	const blocked = [
		["wip-stuff", "git push"],
		["random-branch", "git push"],
		["feature_underscore", "git push"], // no `/`
		["FEATURE/bar", "git push"], // uppercase prefix
		["feature/", "git push"], // empty suffix
		["feature/Mixed-Case", "git push"], // uppercase chars in suffix
		["myname/feature-x", "git push"], // wrong prefix
		["wip-stuff", "git push origin HEAD"], // explicit ref but still a branch push
		["junk", "cd packages/web && git push"], // chained
	];
	for (const [branch, command] of blocked) {
		it(`blocks: branch '${branch}' → ${command}`, async () => {
			const result = await bashFromBranch(command, branch);
			assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);
			assert.match(result.stderr, new RegExp(`branch '${branch}'`));
			assert.match(result.stderr, /CONTRIBUTING\.md:50-57/);
		});
	}
});

describe("enforce-branch-naming — allows", () => {
	const allowed = [
		["feature/foo", "git push"],
		["feature/foo-bar.baz", "git push"], // hyphens, dots
		["fix/bar", "git push"],
		["docs/baz", "git push"],
		["refactor/qux", "git push"],
		["main", "git push"], // protected branches explicitly allowed
		["master", "git push"],
		["staging", "git push"], // protected integration branch
		["wip-stuff", "git push --tags"], // tag push
		["wip-stuff", "git push origin v1.2.3"], // tag-like positional ref
		["wip-stuff", "git push origin v0.0.0-rc.1"], // pre-release tag
		["wip-stuff", "git push --tags origin"], // --tags anywhere
	];
	for (const [branch, command] of allowed) {
		it(`allows: branch '${branch}' → ${command}`, async () => {
			const result = await bashFromBranch(command, branch);
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		});
	}
});

describe("enforce-branch-naming — non-push / non-Bash short-circuit", () => {
	it("ignores non-Bash tool calls", async () => {
		const result = await runHook(HOOK, {
			tool_name: "Edit",
			tool_input: { file_path: "/tmp/x" },
		});
		assert.equal(result.exitCode, 0);
	});

	it("ignores non-push git commands", async () => {
		const result = await bashFromBranch("git status", "wip-stuff");
		assert.equal(result.exitCode, 0);
	});

	it("ignores empty command", async () => {
		const result = await runHook(HOOK, {
			tool_name: "Bash",
			tool_input: { command: "" },
		});
		assert.equal(result.exitCode, 0);
	});
});

describe("enforce-branch-naming — detached HEAD", () => {
	it("allows when HEAD is detached (currentBranch returns null)", async () => {
		const result = await bashFromBranch(
			"git push origin v1.2.3",
			"__DETACHED__",
		);
		assert.equal(result.exitCode, 0);
	});

	it("allows plain `git push` from detached HEAD (fail open)", async () => {
		const result = await bashFromBranch("git push", "__DETACHED__");
		assert.equal(result.exitCode, 0);
	});
});

describe("enforce-branch-naming — judges the repo the push runs in", () => {
	// Real repos, no FABRIC_TEST_BRANCH seam: the seam answers before the
	// target directory is consulted, which is exactly the code under test.
	let root;
	let onStaging;
	let onBadBranch;
	const initRepo = (dir, branch) => {
		execFileSync("git", ["init", "-q", "-b", branch, dir], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		execFileSync(
			"git",
			[
				"-c",
				"user.email=t@example.com",
				"-c",
				"user.name=t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"init",
			],
			{ cwd: dir, stdio: "ignore" },
		);
	};
	/** @param {string} command @param {string} cwd */
	const run = (command, cwd) =>
		runHook(
			HOOK,
			{ tool_name: "Bash", tool_input: { command }, cwd },
			{ env: { FABRIC_TEST_BRANCH: undefined }, spawnCwd: root },
		);
	const allowed = async (command, cwd) => {
		const r = await run(command, cwd);
		assert.equal(r.exitCode, 0, `expected allow: ${command}\n${r.stderr}`);
	};
	const blocked = async (command, cwd) => {
		const r = await run(command, cwd);
		assert.equal(r.exitCode, 2, `expected block: ${command}\n${r.stderr}`);
		assert.match(r.stderr, /branch 'wip-stuff'/);
	};

	before(() => {
		root = mkdtempSync(path.join(tmpdir(), "fabric-branch-"));
		onStaging = path.join(root, "on-staging");
		onBadBranch = path.join(root, "on-bad-branch");
		initRepo(onStaging, "staging");
		initRepo(onBadBranch, "wip-stuff");
	});
	after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("allows a push from staging", () => allowed("git push", onStaging));

	it("blocks a push from a bad branch", () =>
		blocked("git push", onBadBranch));

	it("judges `git -C <dir> push` by <dir>, not the session cwd", async () => {
		await allowed(`git -C ${onStaging} push`, onBadBranch);
		await blocked(`git -C ${onBadBranch} push`, onStaging);
	});

	it('judges `git -C "<quoted dir>" push` by that dir', async () => {
		await allowed(`git -C "${onStaging}" push`, onBadBranch);
		await blocked(`git -C '${onBadBranch}' push`, onStaging);
	});

	it("judges a leading literal `cd <dir> &&` by <dir>", async () => {
		await allowed(`cd ${onStaging} && git push`, onBadBranch);
		await blocked(`cd ${onBadBranch} && git push`, onStaging);
	});

	it("judges `git -C <relative dir>` relative to a leading cd", async () => {
		await allowed(`cd ${root} && git -C on-staging push`, onBadBranch);
		await blocked(`cd ${root} && git -C on-bad-branch push`, onStaging);
	});

	it("judges EVERY push in the command, not just the first", async () => {
		await blocked(`git -C ${onStaging} push; git push`, onBadBranch);
		await blocked(`git push; git -C ${onBadBranch} push`, onStaging);
		await allowed(`git -C ${onStaging} push && git push`, onStaging);
	});

	it("keeps `cd .` working", () => allowed("cd . && git push", onStaging));

	it("a leading cd to a directory that does not exist falls back to the session cwd", async () => {
		await blocked("cd - && git push", onBadBranch);
		await blocked("cd /definitely-missing && git push", onBadBranch);
		await allowed("cd - && git push", onStaging);
	});

	it("a -C directory that is not a plain literal is judged by the session cwd", async () => {
		for (const dir of ["$R", "$(pwd)", "../x", "~/x"]) {
			await blocked(`git -C ${dir} push`, onBadBranch);
			await allowed(`git -C ${dir} push`, onStaging);
		}
	});

	it("a -C directory that does not exist is judged by the session cwd", async () => {
		await blocked("git -C /definitely-missing push", onBadBranch);
	});

	it("does not treat other commands that mention a push as a push to allow", async () => {
		await blocked("echo hi && git push", onBadBranch);
	});
});
