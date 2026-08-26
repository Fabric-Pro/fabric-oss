import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runHook } from "./_helpers.mjs";

const HOOK = "pr-quality-gate.mjs";

/**
 * Stub `pnpm` shell script. Inspects $1 (the script name) and exits
 * according to env vars set by the test:
 *   STUB_TYPECHECK_EXIT, STUB_LINT_EXIT, STUB_FORMAT_EXIT (default 0)
 *   STUB_TYPECHECK_OUTPUT, STUB_LINT_OUTPUT, STUB_FORMAT_OUTPUT (optional)
 *
 * Output is written to stdout (matches real-world tsc/biome behavior:
 * diagnostics go to stdout, not stderr) so the hook's stdout-capture
 * path is exercised.
 */
const STUB_PNPM = `#!/usr/bin/env bash
case "$1" in
  type-check|type-check:changed)
    [ -n "$STUB_ECHO_PWD" ] && printf 'PWD=%s\\n' "$(pwd)"
    [ -n "$STUB_TYPECHECK_OUTPUT" ] && printf '%s\\n' "$STUB_TYPECHECK_OUTPUT"
    exit "\${STUB_TYPECHECK_EXIT:-0}"
    ;;
  lint)
    [ -n "$STUB_LINT_OUTPUT" ] && printf '%s\\n' "$STUB_LINT_OUTPUT"
    exit "\${STUB_LINT_EXIT:-0}"
    ;;
  format:check)
    [ -n "$STUB_FORMAT_OUTPUT" ] && printf '%s\\n' "$STUB_FORMAT_OUTPUT"
    exit "\${STUB_FORMAT_EXIT:-0}"
    ;;
  *)
    echo "stub pnpm: unexpected subcommand: $*" >&2
    exit 99
    ;;
esac
`;

/** @type {string} */
let stubDir;
/** @type {string} */
let stubRepoRoot;

before(() => {
	stubDir = mkdtempSync(join(tmpdir(), "pr-quality-gate-stub-"));
	const stubPath = join(stubDir, "pnpm");
	writeFileSync(stubPath, STUB_PNPM, "utf8");
	chmodSync(stubPath, 0o755);
	stubRepoRoot = mkdtempSync(join(tmpdir(), "pr-quality-gate-cwd-"));
});

after(() => {
	if (stubDir) {
		rmSync(stubDir, { recursive: true, force: true });
	}
	if (stubRepoRoot) {
		rmSync(stubRepoRoot, { recursive: true, force: true });
	}
});

/**
 * @param {string} command
 * @param {Record<string, string|undefined>} [stubEnv]
 */
async function bash(command, stubEnv = {}) {
	const env = {
		PATH: `${stubDir}${delimiter}${process.env.PATH ?? ""}`,
		CLAUDE_PROJECT_DIR: stubRepoRoot,
		// reset the stub knobs each call so leftovers don't bleed across tests
		STUB_TYPECHECK_EXIT: undefined,
		STUB_TYPECHECK_OUTPUT: undefined,
		STUB_LINT_EXIT: undefined,
		STUB_LINT_OUTPUT: undefined,
		STUB_FORMAT_EXIT: undefined,
		STUB_FORMAT_OUTPUT: undefined,
		STUB_ECHO_PWD: undefined,
		...stubEnv,
	};
	return runHook(
		HOOK,
		{ tool_name: "Bash", tool_input: { command } },
		{ env },
	);
}

/**
 * Parses the PreToolUse decision JSON the hook writes to stdout and
 * returns the `hookSpecificOutput` object. Throws if stdout isn't the
 * expected decision JSON (which is itself a useful test failure).
 * @param {string} stdout
 */
function askDecision(stdout) {
	const parsed = JSON.parse(stdout);
	return parsed.hookSpecificOutput;
}

describe("pr-quality-gate — asks the user on a failing check", () => {
	it("asks (does not hard-block) when type-check fails", async () => {
		const result = await bash("gh pr create --fill", {
			STUB_TYPECHECK_EXIT: "1",
			STUB_TYPECHECK_OUTPUT:
				"src/foo.ts(10,5): error TS2322: type mismatch",
		});
		assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		const decision = askDecision(result.stdout);
		assert.equal(decision.hookEventName, "PreToolUse");
		assert.equal(decision.permissionDecision, "ask");
		assert.match(decision.permissionDecisionReason, /pnpm type-check/);
		assert.match(
			decision.permissionDecisionReason,
			/CONTRIBUTING\.md:79-86/,
		);
		assert.match(decision.permissionDecisionReason, /type mismatch/);
	});

	it("asks when lint fails (type-check passes first)", async () => {
		const result = await bash("gh pr create --title x --body y", {
			STUB_LINT_EXIT: "1",
			STUB_LINT_OUTPUT: "biome lint: 3 errors found",
		});
		assert.equal(result.exitCode, 0);
		const decision = askDecision(result.stdout);
		assert.equal(decision.permissionDecision, "ask");
		assert.match(decision.permissionDecisionReason, /pnpm lint/);
		assert.match(decision.permissionDecisionReason, /biome lint: 3 errors/);
	});

	it("asks when format:check fails", async () => {
		const result = await bash("gh pr create --fill", {
			STUB_FORMAT_EXIT: "1",
			STUB_FORMAT_OUTPUT: "would format src/a.ts",
		});
		assert.equal(result.exitCode, 0);
		const decision = askDecision(result.stdout);
		assert.equal(decision.permissionDecision, "ask");
		assert.match(decision.permissionDecisionReason, /pnpm format:check/);
		assert.match(decision.permissionDecisionReason, /would format/);
	});

	it("asks on `gh pr edit --body` when type-check fails", async () => {
		const result = await bash('gh pr edit 5 --body "updated"', {
			STUB_TYPECHECK_EXIT: "1",
		});
		assert.equal(result.exitCode, 0);
		assert.equal(askDecision(result.stdout).permissionDecision, "ask");
	});

	it("asks on `gh pr edit --body-file` when lint fails", async () => {
		const result = await bash("gh pr edit 5 --body-file body.md", {
			STUB_LINT_EXIT: "1",
		});
		assert.equal(result.exitCode, 0);
		assert.equal(askDecision(result.stdout).permissionDecision, "ask");
	});

	it("truncates very long check output to ~20 lines in the ask reason", async () => {
		const big = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const result = await bash("gh pr create --fill", {
			STUB_TYPECHECK_EXIT: "1",
			STUB_TYPECHECK_OUTPUT: big,
		});
		assert.equal(result.exitCode, 0);
		const reason = askDecision(result.stdout).permissionDecisionReason;
		assert.match(reason, /line 100/);
		// the first line (`line 1`) should not be in the tail
		assert.doesNotMatch(reason, /\bline 1\b/);
	});
});

describe("pr-quality-gate — validates the worktree the PR command runs in", () => {
	it("runs checks in a leading `cd <worktree>` over CLAUDE_PROJECT_DIR", async () => {
		// A real git worktree, distinct from CLAUDE_PROJECT_DIR (stubRepoRoot,
		// which is a bare temp dir, not a git repo).
		const worktree = mkdtempSync(join(tmpdir(), "pr-quality-gate-wt-"));
		execSync("git init -q", { cwd: worktree });
		try {
			const result = await bash(
				`cd "${worktree}" && gh pr create --fill`,
				{
					STUB_TYPECHECK_EXIT: "1",
					STUB_ECHO_PWD: "1",
				},
			);
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			const reason = askDecision(result.stdout).permissionDecisionReason;
			// The stub printed its own cwd; the check must have run in the
			// worktree's git top-level, not the (non-git) CLAUDE_PROJECT_DIR.
			// The legacy fallback (no `cd`, CLAUDE_PROJECT_DIR only) is covered
			// by every other test in this file.
			assert.match(reason, /pr-quality-gate-wt-/);
			assert.doesNotMatch(reason, /pr-quality-gate-cwd-/);
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
	});
});

describe("pr-quality-gate — allows (no prompt) when all checks pass", () => {
	it("emits no decision for `gh pr create --fill` when stubbed checks all exit 0", async () => {
		const result = await bash("gh pr create --fill");
		assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		assert.equal(
			result.stdout.trim(),
			"",
			"pass case must not emit an ask decision",
		);
	});

	it("emits no decision for `gh pr edit 5 --body x` when all checks pass", async () => {
		const result = await bash('gh pr edit 5 --body "x"');
		assert.equal(result.exitCode, 0);
		assert.equal(result.stdout.trim(), "");
	});
});

describe("pr-quality-gate — skips for non-gated gh subcommands", () => {
	const skipped = [
		"gh pr view 5",
		"gh pr list",
		"gh pr checkout 5",
		"gh pr merge 5",
		"gh pr review 5",
		"gh pr comment 5 --body 'lgtm'", // comment, not edit
		"gh pr edit 5 --add-label foo", // edit without body
		"gh pr edit 5 --title 'new title'", // edit without body
	];
	for (const command of skipped) {
		it(`does not run checks for: ${command}`, async () => {
			// Stub every check to FAIL — if the hook ran them, it would emit an ask.
			const result = await bash(command, {
				STUB_TYPECHECK_EXIT: "1",
				STUB_LINT_EXIT: "1",
				STUB_FORMAT_EXIT: "1",
			});
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			assert.equal(
				result.stdout.trim(),
				"",
				"must not run checks / emit a decision",
			);
		});
	}
});

describe("pr-quality-gate — ignores mentions of the trigger inside quotes", () => {
	const mentions = [
		'echo "remember to run gh pr create"',
		`node -e 'const s = "gh pr create"'`,
		"grep -r 'gh pr create' .",
	];
	for (const command of mentions) {
		it(`does not gate a quoted mention: ${command}`, async () => {
			// Fail every check — if the hook mistook the mention for a real
			// invocation and ran them, it would emit an ask decision.
			const result = await bash(command, {
				STUB_TYPECHECK_EXIT: "1",
				STUB_LINT_EXIT: "1",
				STUB_FORMAT_EXIT: "1",
			});
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			assert.equal(
				result.stdout.trim(),
				"",
				"a quoted mention must not trigger the gate",
			);
		});
	}
});

describe("pr-quality-gate — non-Bash / missing-env short-circuits", () => {
	it("ignores non-Bash tool calls", async () => {
		const result = await runHook(HOOK, {
			tool_name: "Edit",
			tool_input: { file_path: "/tmp/x" },
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.stdout.trim(), "");
	});

	it("fails open when CLAUDE_PROJECT_DIR is unset", async () => {
		const result = await runHook(
			HOOK,
			{
				tool_name: "Bash",
				tool_input: { command: "gh pr create --fill" },
			},
			{
				env: {
					PATH: `${stubDir}${delimiter}${process.env.PATH ?? ""}`,
					CLAUDE_PROJECT_DIR: undefined,
					STUB_TYPECHECK_EXIT: "1", // would block if checks ran
				},
			},
		);
		assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		assert.match(result.stderr, /CLAUDE_PROJECT_DIR not set/);
		assert.equal(
			result.stdout.trim(),
			"",
			"fail-open must not emit an ask decision",
		);
	});
});
