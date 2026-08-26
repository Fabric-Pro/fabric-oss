import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
