import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runHook } from "./_helpers.mjs";

const HOOK = "block-claude-attribution.mjs";

async function bash(command) {
	return runHook(HOOK, { tool_name: "Bash", tool_input: { command } });
}

describe("block-claude-attribution — blocks", () => {
	const blocked = [
		[
			"git commit with Co-Authored-By trailer",
			`git commit -m "fix(api): handle null user

Co-Authored-By: Claude <noreply@anthropic.com>"`,
		],
		[
			"git commit with literal robot emoji prefix",
			`git commit -m "fix\n\n🤖 Generated with Claude Code"`,
		],
		[
			"gh pr create with Generated with Claude Code in body",
			`gh pr create --title "x" --body "Summary

Generated with Claude Code"`,
		],
		[
			"gh pr edit with --body containing 🤖 Generated",
			`gh pr edit 123 --body "🤖 Generated content"`,
		],
		[
			"heredoc commit message with Co-Authored-By: Claude",
			`git commit -m "$(cat <<'EOF'
fix(api): handle null user

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"`,
		],
		[
			"case-insensitive co-authored-by",
			`git commit -m "fix

co-authored-by: Claude <x@x>"`,
		],
	];
	for (const [label, command] of blocked) {
		it(`blocks: ${label}`, async () => {
			const result = await bash(command);
			assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);
			assert.match(result.stderr, /attribution/i);
			assert.match(result.stderr, /CLAUDE\.md:175-176/);
		});
	}
});

describe("block-claude-attribution — allows", () => {
	const allowed = [
		[
			"commit mentions Claude as a topic, not attribution",
			`git commit -m "fix(ai): handle Claude rate-limit headers"`,
		],
		["gh pr view", "gh pr view 123"],
		["gh pr list", "gh pr list"],
		[
			"gh pr create mentions claude in topic only",
			`gh pr create --title "claude integration" --body "ships claude SDK"`,
		],
		["non-commit, non-gh-pr command", "git status"],
		["gh pr checkout", "gh pr checkout 5"],
	];
	for (const [label, command] of allowed) {
		it(`allows: ${label}`, async () => {
			const result = await bash(command);
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		});
	}
});

describe("block-claude-attribution — non-Bash", () => {
	it("does nothing for non-Bash tools", async () => {
		const result = await runHook(HOOK, {
			tool_name: "Edit",
			tool_input: { file_path: "/tmp/x" },
		});
		assert.equal(result.exitCode, 0);
	});
});
