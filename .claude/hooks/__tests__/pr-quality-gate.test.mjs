import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { runHook } from "./_helpers.mjs";
import { GATED_GH_API_COMMANDS } from "./gate-fixtures.mjs";

const HOOK = "pr-quality-gate.mjs";

/**
 * Stub `pnpm` shell script. Inspects $1 (the script name) and exits
 * according to env vars set by the test:
 *   STUB_TYPECHECK_EXIT, STUB_LINT_EXIT, STUB_FORMAT_EXIT (default 0)
 *   STUB_TYPECHECK_OUTPUT, STUB_LINT_OUTPUT, STUB_FORMAT_OUTPUT (optional)
 *   STUB_TYPECHECK_BIG (print ~1.6 MB then a marker line)
 *   STUB_TYPECHECK_SLEEP + STUB_PIDFILE (start a `sleep 30` grandchild,
 *     record its PID, and wait on it — simulates a hung check)
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
    if [ -n "$STUB_TYPECHECK_BIG" ]; then
      yes 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | head -n 30000
      echo 'LAST-LINE-MARKER'
    fi
    if [ -n "$STUB_TYPECHECK_SLEEP" ]; then
      [ -n "$STUB_IGNORE_TERM" ] && trap '' TERM
      sleep 30 &
      echo "$!" > "$STUB_PIDFILE"
      wait
    fi
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

/**
 * Windows only: Git for Windows' `bin/bash.exe`, which puts Git's usr/bin
 * (`yes`, `head`, `sleep`) on PATH for the stub. Found from `git --exec-path`
 * (<git>/mingw64/libexec/git-core).
 *
 * @returns {string}
 */
function gitBash() {
	const execPath = execSync("git --exec-path").toString().trim();
	const bashPath = resolve(execPath, "..", "..", "..", "bin", "bash.exe");
	if (!existsSync(bashPath)) {
		throw new Error(`Git Bash not found at ${bashPath}; the stub needs it`);
	}
	return bashPath;
}

/**
 * Windows only: the hung check. Git Bash cannot stand in for it: a job
 * started with `sleep 30 &` is created by a forked bash that exits after
 * exec, so the sleep has no live Windows parent and no tree kill can reach
 * it. Real pnpm/turbo/tsc are native processes, so this native stand-in
 * (cmd.exe -> node -> node grandchild, grandchild pid in STUB_PIDFILE) is
 * the tree the hook actually has to kill.
 */
const WIN_HANG_JS = `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
	stdio: "ignore",
});
writeFileSync(process.env.STUB_PIDFILE, String(child.pid));
child.on("exit", (code) => process.exit(code ?? 1));
`;

/**
 * Windows only: `pnpm.cmd`. The hook launches pnpm through cmd.exe, which
 * only runs PATHEXT files, so this forwards to the bash stub, except for the
 * hung check (WIN_HANG_JS). Git's bash is named by absolute path because a
 * bare `bash` can resolve to WSL's System32\\bash.exe.
 *
 * @param {string} bashPath
 */
function winStubCmd(bashPath) {
	return [
		"@echo off",
		'if "%1"=="type-check:changed" if defined STUB_TYPECHECK_SLEEP (',
		'  node "%~dp0hang.js"',
		"  exit /b",
		")",
		`"${bashPath}" "%~dp0pnpm" %*`,
		"exit /b %ERRORLEVEL%",
		"",
	].join("\r\n");
}

/** @type {string} */
let stubDir;
/** @type {string} */
let stubRepoRoot;

before(() => {
	stubDir = mkdtempSync(join(tmpdir(), "pr-quality-gate-stub-"));
	const stubPath = join(stubDir, "pnpm");
	writeFileSync(stubPath, STUB_PNPM, "utf8");
	chmodSync(stubPath, 0o755);
	if (process.platform === "win32") {
		writeFileSync(join(stubDir, "hang.js"), WIN_HANG_JS, "utf8");
		writeFileSync(join(stubDir, "pnpm.cmd"), winStubCmd(gitBash()), "utf8");
	}
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
		STUB_TYPECHECK_BIG: undefined,
		STUB_TYPECHECK_SLEEP: undefined,
		STUB_PIDFILE: undefined,
		STUB_IGNORE_TERM: undefined,
		FABRIC_GATE_TEST_STREAM_ERROR: undefined,
		FABRIC_GATE_TEST_IGNORE_KILL: undefined,
		FABRIC_GATE_TEST_KILL_LOG: undefined,
		FABRIC_GATE_TIMEOUT_MS: undefined,
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
		// Short prompt: what failed, what to review, what Yes/No do, then output.
		const lines = decision.permissionDecisionReason.split("\n");
		assert.equal(
			lines[0],
			"PR check failed: `pnpm type-check:changed` (exit code 1)",
		);
		assert.equal(
			lines[1],
			"To review: this check failed; inspect its output below and fix the cause.",
		);
		assert.equal(
			lines[2],
			"Yes = go ahead with the PR anyway   No = cancel and fix first",
		);
		assert.equal(lines[3], "");
		assert.equal(lines[4], "src/foo.ts(10,5): error TS2322: type mismatch");
		assert.equal(lines.length, 5);
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

	it("shows only the three prompt lines when the failing check prints nothing", async () => {
		const result = await bash("gh pr create --fill", {
			STUB_LINT_EXIT: "2",
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(
			askDecision(result.stdout).permissionDecisionReason.split("\n"),
			[
				"PR check failed: `pnpm lint` (exit code 2)",
				"To review: this check failed; inspect its output below and fix the cause.",
				"Yes = go ahead with the PR anyway   No = cancel and fix first",
			],
		);
	});

	it("truncates very long check output to 8 lines in the ask reason", async () => {
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
		assert.match(reason, /\bline 93\b/);
		// only the last 8 lines are shown
		assert.doesNotMatch(reason, /\bline 92\b/);
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

describe("pr-quality-gate — gates PR creation and body edits through `gh api`", () => {
	const gated = GATED_GH_API_COMMANDS;
	for (const command of gated) {
		it(`runs the checks for: ${command}`, async () => {
			const result = await bash(command, { STUB_TYPECHECK_EXIT: "1" });
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			assert.equal(askDecision(result.stdout).permissionDecision, "ask");
		});
	}

	const notGated = [
		"gh api repos/o/r/pulls",
		"gh api repos/o/r/pulls/5",
		"gh api -X PATCH repos/o/r/pulls/5 -f title=x",
		"gh api -X POST repos/o/r/issues/5/labels --input -",
		"gh api -X POST repos/o/r/pulls/5/comments -f body=x",
		"gh api -X POST repos/o/r/pulls/5/reviews -f body=x",
		'echo "gh api -X POST repos/o/r/pulls"',
		"grep -r 'gh api repos/o/r/pulls' .",
		"gh api graphql -f query='query { viewer { login } }'",
		"gh api -X=PATCH repos/o/r/pulls/5 -f title=x",
		"gh api -iX PATCH repos/o/r/pulls/5 -f title=x",
		"gh api graphql -f query=@q.graphql",
	];
	for (const command of notGated) {
		it(`does not gate: ${command}`, async () => {
			const result = await bash(command, {
				STUB_TYPECHECK_EXIT: "1",
				STUB_LINT_EXIT: "1",
				STUB_FORMAT_EXIT: "1",
			});
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			assert.equal(result.stdout.trim(), "");
		});
	}
});

/** True when `pid` is gone; a zombie (state Z in /proc) counts as gone. */
function isDead(pid) {
	try {
		process.kill(pid, 0);
	} catch (err) {
		return err.code === "ESRCH";
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return (
			stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) ===
			"Z"
		);
	} catch {
		return false;
	}
}

/** @param {Record<string, string>} extraEnv */
async function runHungCheck(extraEnv) {
	const pidFile = join(stubRepoRoot, `grandchild-${Date.now()}.pid`);
	const started = Date.now();
	const result = await bash("gh pr create --fill", {
		STUB_TYPECHECK_SLEEP: "1",
		STUB_PIDFILE: pidFile,
		FABRIC_GATE_TIMEOUT_MS: "500",
		...extraEnv,
	});
	const elapsedMs = Date.now() - started;
	assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
	const decision = askDecision(result.stdout);
	assert.equal(decision.permissionDecision, "ask");
	assert.match(decision.permissionDecisionReason, /PR check timed out: /);
	assert.equal(
		decision.permissionDecisionReason.split("\n")[1],
		"To review: this check ran past its time limit, so its result is unverified.",
	);
	assert.match(decision.permissionDecisionReason, /pnpm type-check/);
	assert.ok(existsSync(pidFile), "stub never recorded the grandchild PID");
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	assert.ok(pid > 0);
	let dead = false;
	for (let i = 0; i < 20 && !dead; i++) {
		dead = isDead(pid);
		if (!dead) {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	if (!dead) {
		process.kill(pid, "SIGKILL");
	}
	assert.equal(dead, true, "grandchild survived the timeout");
	return elapsedMs;
}

describe("pr-quality-gate — timeouts fail visibly", () => {
	it(
		"asks (timed out) and kills the whole process group of a hung check",
		{ timeout: 20000 },
		async () => {
			const elapsedMs = await runHungCheck({});
			assert.ok(elapsedMs < 10_000, `hook took ${elapsedMs}ms`);
		},
	);

	it(
		"settles at the SIGKILL deadline and kills a SIGTERM-resistant grandchild",
		{ timeout: 20000 },
		async () => {
			const elapsedMs = await runHungCheck({ STUB_IGNORE_TERM: "1" });
			assert.ok(elapsedMs < 10_000, `hook took ${elapsedMs}ms`);
		},
	);
});

describe("pr-quality-gate — timeout settles without child exit", () => {
	it(
		"reports a timeout at the deadline even if the child never exits",
		{ timeout: 20000 },
		async () => {
			const pidFile = join(stubRepoRoot, `noexit-${Date.now()}.pid`);
			const started = Date.now();
			const result = await bash("gh pr create --fill", {
				STUB_TYPECHECK_SLEEP: "1",
				STUB_PIDFILE: pidFile,
				FABRIC_GATE_TIMEOUT_MS: "500",
				FABRIC_GATE_TEST_IGNORE_KILL: "1",
			});
			const elapsedMs = Date.now() - started;
			try {
				assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
				assert.match(
					askDecision(result.stdout).permissionDecisionReason,
					/PR check timed out: /,
				);
				assert.ok(elapsedMs < 10_000, `hook took ${elapsedMs}ms`);
			} finally {
				// The seam left the stub running; clean it up.
				if (existsSync(pidFile)) {
					try {
						process.kill(
							Number(readFileSync(pidFile, "utf8").trim()),
							"SIGKILL",
						);
					} catch {
						// already gone
					}
				}
			}
		},
	);
});

describe("pr-quality-gate — stream errors", () => {
	it(
		"reports an output stream error as unverified instead of crashing",
		{ timeout: 20000 },
		async () => {
			const result = await bash("gh pr create --fill", {
				FABRIC_GATE_TEST_STREAM_ERROR: "1",
			});
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			const reason = askDecision(result.stdout).permissionDecisionReason;
			assert.match(reason, /output stream error/);
			assert.match(reason, /PR check unverified: /);
			assert.equal(
				reason.split("\n")[1],
				"To review: this check's result is unknown, so treat it as not run.",
			);
		},
	);
});

describe("pr-quality-gate — chatty and unstartable checks", () => {
	it("keeps the tail and real exit code of > 1.5 MB of output", async () => {
		const result = await bash("gh pr create --fill", {
			STUB_TYPECHECK_BIG: "1",
			STUB_TYPECHECK_EXIT: "3",
		});
		assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		const reason = askDecision(result.stdout).permissionDecisionReason;
		assert.match(reason, /LAST-LINE-MARKER/);
		assert.match(reason, /\(exit code 3\)/);
	});

	it("asks (does not pass) when pnpm cannot be started", async () => {
		const emptyBin = mkdtempSync(join(tmpdir(), "pr-quality-gate-nopnpm-"));
		try {
			const result = await runHook(
				HOOK,
				{
					tool_name: "Bash",
					tool_input: { command: "gh pr create --fill" },
				},
				{ env: { PATH: emptyBin, CLAUDE_PROJECT_DIR: stubRepoRoot } },
			);
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			const reason = askDecision(result.stdout).permissionDecisionReason;
			assert.match(reason, /PR check could not start: /);
			assert.equal(
				reason.split("\n")[1],
				"To review: this check did not run; the error below says why.",
			);
			assert.match(reason, /ENOENT/);
		} finally {
			rmSync(emptyBin, { recursive: true, force: true });
		}
	});
});

describe("pr-quality-gate — Windows launches pnpm.cmd", () => {
	// Real pnpm on Windows is only `pnpm.cmd`, which a shell-less spawn cannot
	// start (spawn pnpm ENOENT). This stub has no extensionless file and no
	// bash, so it passes only if the hook goes through cmd.exe.
	const skip = process.platform !== "win32" && "pnpm.cmd is Windows-only";
	const CMD_ONLY_STUB = [
		"@echo off",
		'if "%1"=="type-check:changed" if defined STUB_TYPECHECK_EXIT (',
		"  echo CMD-ONLY-STUB %1",
		"  exit /b %STUB_TYPECHECK_EXIT%",
		")",
		"exit /b 0",
		"",
	].join("\r\n");

	/** @param {Record<string, string|undefined>} stubEnv */
	async function runCmdOnly(stubEnv) {
		const cmdBin = mkdtempSync(join(tmpdir(), "pr-quality-gate-cmdonly-"));
		writeFileSync(join(cmdBin, "pnpm.cmd"), CMD_ONLY_STUB, "utf8");
		try {
			return await runHook(
				HOOK,
				{
					tool_name: "Bash",
					tool_input: { command: "gh pr create --fill" },
				},
				{
					env: {
						PATH: `${cmdBin}${delimiter}${process.env.SystemRoot ?? "C:\\Windows"}\\System32`,
						CLAUDE_PROJECT_DIR: stubRepoRoot,
						STUB_TYPECHECK_EXIT: undefined,
						...stubEnv,
					},
				},
			);
		} finally {
			rmSync(cmdBin, { recursive: true, force: true });
		}
	}

	it("honours a failing pnpm.cmd check", { skip }, async () => {
		const result = await runCmdOnly({ STUB_TYPECHECK_EXIT: "4" });
		assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		const reason = askDecision(result.stdout).permissionDecisionReason;
		assert.match(reason, /CMD-ONLY-STUB type-check:changed/);
		assert.match(reason, /\(exit code 4\)/);
		assert.doesNotMatch(reason, /PR check could not start: /);
	});

	it("passes when every pnpm.cmd check exits 0", { skip }, async () => {
		const result = await runCmdOnly({});
		assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		assert.equal(result.stdout.trim(), "");
	});
});

describe("pr-quality-gate — Windows runs the pnpm it resolved", () => {
	const skip = process.platform !== "win32" && "Windows pnpm resolution";
	const system32 = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;

	/** @type {string[]} */
	let dirs = [];
	/** @param {string} prefix */
	const tempDir = (prefix) => {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		dirs.push(dir);
		return dir;
	};
	after(() => {
		for (const dir of dirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		dirs = [];
	});

	it(
		"skips a relative PATH entry that cmd.exe would resolve in the check's cwd",
		{ skip },
		async () => {
			// The check cwd (the tree being PR'd) holds a passing pnpm.cmd; the
			// hook's own cwd is elsewhere. `.` first on PATH must not let it run.
			const checkCwd = tempDir("pr-quality-gate-localpnpm-");
			writeFileSync(join(checkCwd, "pnpm.cmd"), "@exit /b 0\r\n", "utf8");
			const hookCwd = tempDir("pr-quality-gate-hookcwd-");
			const result = await runHook(
				HOOK,
				{
					tool_name: "Bash",
					tool_input: { command: "gh pr create --fill" },
				},
				{
					env: {
						PATH: `.${delimiter}${stubDir}${delimiter}${system32}`,
						CLAUDE_PROJECT_DIR: checkCwd,
						STUB_TYPECHECK_EXIT: "1",
						STUB_TYPECHECK_OUTPUT: "PATH-STUB-RAN",
					},
					spawnCwd: hookCwd,
				},
			);
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			const reason = askDecision(result.stdout).permissionDecisionReason;
			assert.match(reason, /PATH-STUB-RAN/);
			assert.match(reason, /\(exit code 1\)/);
		},
	);

	it(
		"reports a directory named pnpm.cmd as a check that could not start",
		{ skip },
		async () => {
			const bin = tempDir("pr-quality-gate-dirpnpm-");
			mkdirSync(join(bin, "pnpm.cmd"));
			const result = await runHook(
				HOOK,
				{
					tool_name: "Bash",
					tool_input: { command: "gh pr create --fill" },
				},
				{
					env: {
						PATH: `${bin}${delimiter}${system32}`,
						CLAUDE_PROJECT_DIR: stubRepoRoot,
					},
				},
			);
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			const reason = askDecision(result.stdout).permissionDecisionReason;
			assert.match(reason, /PR check could not start: /);
			assert.equal(
				reason.split("\n")[1],
				"To review: this check did not run; the error below says why.",
			);
			assert.match(reason, /ENOENT/);
		},
	);

	it(
		"refuses a pnpm path containing % (expanded by cmd.exe inside quotes)",
		{ skip },
		async () => {
			const bin = tempDir("pr-quality-gate-pct%x-");
			writeFileSync(join(bin, "pnpm.cmd"), "@exit /b 0\r\n", "utf8");
			const result = await runHook(
				HOOK,
				{
					tool_name: "Bash",
					tool_input: { command: "gh pr create --fill" },
				},
				{
					env: {
						PATH: `${bin}${delimiter}${system32}`,
						CLAUDE_PROJECT_DIR: stubRepoRoot,
					},
				},
			);
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			const reason = askDecision(result.stdout).permissionDecisionReason;
			assert.match(reason, /PR check could not start: /);
			assert.match(reason, /refusing unsafe pnpm path/);
		},
	);
});

describe("pr-quality-gate — Windows never kills an exited check's pid", () => {
	const skip = process.platform !== "win32" && "taskkill is Windows-only";

	it(
		"makes no taskkill attempt for a pipe error after cmd.exe exited",
		{ skip, timeout: 20000 },
		async () => {
			// pnpm.cmd starts a node grandchild that keeps the stdout pipe open,
			// then cmd.exe exits 0. The seam injects a stdout error from the
			// `exit` handler, i.e. after the root exited and while the pipe is
			// still open — the window where taskkill would hit a stale pid.
			const bin = mkdtempSync(join(tmpdir(), "pr-quality-gate-linger-"));
			const pidFile = join(bin, "grandchild.pid");
			const killLog = join(bin, "kill.log");
			writeFileSync(
				join(bin, "linger.js"),
				`const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], {
	stdio: ["ignore", "inherit", "inherit"],
	detached: true,
});
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
c.unref();
`,
				"utf8",
			);
			writeFileSync(
				join(bin, "pnpm.cmd"),
				`@"${process.execPath}" "%~dp0linger.js"\r\n@exit /b 0\r\n`,
				"utf8",
			);
			try {
				const result = await runHook(
					HOOK,
					{
						tool_name: "Bash",
						tool_input: { command: "gh pr create --fill" },
					},
					{
						env: {
							PATH: `${bin}${delimiter}${process.env.SystemRoot ?? "C:\\Windows"}\\System32`,
							// Its own check cwd: the grandchild outlives the hook and
							// would otherwise hold the shared stubRepoRoot open.
							CLAUDE_PROJECT_DIR: bin,
							FABRIC_GATE_TEST_STREAM_ERROR: "after-exit",
							FABRIC_GATE_TEST_KILL_LOG: killLog,
						},
					},
				);
				assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
				const reason = askDecision(
					result.stdout,
				).permissionDecisionReason;
				assert.match(reason, /injected stream error after exit/);
				assert.match(reason, /PR check unverified: /);
				assert.ok(existsSync(pidFile), "grandchild never started");
				const attempts = existsSync(killLog)
					? readFileSync(killLog, "utf8").trim()
					: "";
				assert.equal(
					attempts,
					"",
					"taskkill was aimed at an exited pid",
				);
			} finally {
				if (existsSync(pidFile)) {
					const pid = Number(readFileSync(pidFile, "utf8"));
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// already gone
					}
					// Termination is asynchronous; the directory stays locked as
					// the grandchild's cwd until it is really gone.
					for (let i = 0; i < 30 && !isDead(pid); i++) {
						await new Promise((r) => setTimeout(r, 100));
					}
				}
				// Windows releases the dead grandchild's cwd lock asynchronously
				// (EPERM for a few hundred ms observed), and rmSync's maxRetries
				// did not retry it here, so retry by hand for up to 5 s. A
				// leftover temp dir must not fail the test.
				for (let i = 0; i < 50; i++) {
					try {
						rmSync(bin, { recursive: true, force: true });
						break;
					} catch {
						await new Promise((r) => setTimeout(r, 100));
					}
				}
			}
		},
	);
});
