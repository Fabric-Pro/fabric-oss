#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { leadingCdTarget } from "./lib/git-helpers.mjs";
import { readToolInput } from "./lib/parse-input.mjs";
import { writeAskDecision } from "./lib/permission-decision.mjs";

/**
 * Quality-gate commands run sequentially with fail-fast. Order is
 * cheapest-first to surface the most common failure mode quickly:
 * type errors > lint > format drift.
 *
 * Type-check is SCOPED to the packages changed vs origin/master (and
 * their dependents) via `type-check:changed`, mirroring how CI scopes
 * its tests (`turbo run test --filter=...[origin/<base>]` in
 * unit-tests.yml). A full-repo `tsc` sweep re-checks all ~45 packages
 * — including heavy source packages like `@repo/database` (its ~47MB
 * generated Prisma client is re-checked by every consumer) — which
 * needs >8GB and OOMs on normal machines. Scoping keeps the gate fast
 * and relevant ("is what I changed sound?") without imposing a large
 * memory floor. lint/format stay whole-tree (Biome is cheap, ~2s).
 */
const CHECKS = [
	{ argv: ["type-check:changed"], label: "pnpm type-check:changed" },
	{ argv: ["lint"], label: "pnpm lint" },
	{ argv: ["format:check"], label: "pnpm format:check" },
];

const MAX_OUTPUT_LINES = 20;

/**
 * `gh pr edit` is only gated when the call mutates the body via
 * `--body` or `--body-file`. Other flag combinations (labels, title,
 * reviewers, milestones) don't change the PR description, so they pass
 * through untouched.
 *
 * @param {string} command
 */
function isGatedGhPrEdit(command) {
	if (!/\bgh\s+pr\s+edit\b/.test(command)) {
		return false;
	}
	return (
		/(^|\s)--body(\s|=)/.test(command) ||
		/(^|\s)--body-file(\s|=)/.test(command)
	);
}

/**
 * `gh pr create` always triggers the gate (the act of creation
 * implies a body, even via `--fill`).
 *
 * @param {string} command
 */
function isGatedGhPrCreate(command) {
	return /\bgh\s+pr\s+create\b/.test(command);
}

/**
 * Returns the last N non-empty lines of `text`, joined by `\n`. Used
 * to truncate the failing command's output so the block message stays
 * readable in Claude Code's stderr panel.
 *
 * @param {string} text
 * @param {number} n
 */
function tailLines(text, n) {
	const lines = text.split(/\r?\n/);
	// strip trailing blank lines so the tail isn't all whitespace
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
		lines.pop();
	}
	if (lines.length <= n) {
		return lines.join("\n");
	}
	return lines.slice(lines.length - n).join("\n");
}

/**
 * Runs one quality check and returns either `null` (pass) or an
 * object describing the failure.
 *
 * Captures stdout AND stderr because Biome and `tsc` both write
 * diagnostics to stdout, not stderr, despite being "errors". A
 * non-zero exit + empty stderr would otherwise leave the user with
 * no actionable info.
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @returns {{output: string, exitCode: number} | null}
 */
function runCheck(argv, cwd) {
	try {
		execFileSync("pnpm", argv, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// Mirror CI's Type Check job heap (.github/workflows/type-check.yml:
			// `NODE_OPTIONS: --max-old-space-size=16384`). `turbo type-check`
			// pulls @repo/web's Next production build in via `^build`, and that
			// build's workers OOM at the default heap locally; CI only clears it
			// because of this env. Set gate-local (like CI's job env) so the hook
			// passes iff CI does — NOT baked into the shared `type-check` script.
			env: {
				...process.env,
				NODE_OPTIONS:
					`${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=16384`.trim(),
			},
		});
		return null;
	} catch (err) {
		const stdout = err?.stdout?.toString?.("utf8") ?? "";
		const stderr = err?.stderr?.toString?.("utf8") ?? "";
		const exitCode = typeof err?.status === "number" ? err.status : 1;
		const combined = [stdout, stderr].filter(Boolean).join("\n");
		return { output: combined, exitCode };
	}
}

/**
 * Resolve the git worktree the PR command actually runs in, so the gate
 * validates the branch being PR'd rather than whatever directory the session
 * was launched from. `CLAUDE_PROJECT_DIR` is fixed at session start, so a
 * session opened in the main checkout that `cd`s into a worktree would
 * otherwise gate against the wrong tree. Resolution order, each normalized to
 * its git top-level:
 *   1. a leading `cd <dir> &&` in the command (the effective cwd of the gh call),
 *   2. the session cwd from the hook payload,
 *   3. CLAUDE_PROJECT_DIR (legacy behavior / main-worktree fallback).
 * A candidate that isn't a git worktree is skipped; if none resolve we return
 * CLAUDE_PROJECT_DIR verbatim, so running from the main checkout (no `cd`, cwd
 * == project dir) behaves exactly as before.
 *
 * @param {string} command
 * @param {string | undefined} payloadCwd
 * @returns {string | null}
 */
function resolveRepoRoot(command, payloadCwd) {
	const projectDir = process.env.CLAUDE_PROJECT_DIR;
	const candidates = [
		leadingCdTarget(command),
		payloadCwd,
		projectDir,
	].filter(Boolean);
	for (const dir of candidates) {
		try {
			const top = execFileSync(
				"git",
				["-C", String(dir), "rev-parse", "--show-toplevel"],
				{ stdio: ["ignore", "pipe", "ignore"] },
			)
				.toString()
				.trim();
			if (top) {
				return top;
			}
		} catch {
			// not a git worktree (or git unavailable) — try the next candidate
		}
	}
	return projectDir ?? null;
}

/**
 * Blank out single- and double-quoted spans so gate-matching sees the
 * command's shell structure, not string contents. A `gh pr create` that lives
 * inside quotes — a script argument, an echo, regex test-data like
 * `node -e '… "gh pr create" …'` — is thus ignored, while a real invocation
 * (whose own args may be quoted) still matches. Prevents false-positive gate
 * prompts on commands that merely *mention* the trigger text.
 *
 * @param {string} command
 * @returns {string}
 */
function stripQuotedSpans(command) {
	return command
		.replace(/'(?:[^'\\]|\\.)*'/g, " ")
		.replace(/"(?:[^"\\]|\\.)*"/g, " ");
}

function main() {
	let toolCall;
	try {
		toolCall = readToolInput();
	} catch (err) {
		process.stderr.write(`pr-quality-gate: ${err.message}\n`);
		process.exit(0);
	}

	if (toolCall.tool_name !== "Bash") {
		process.exit(0);
	}
	const command = String(toolCall.tool_input?.command ?? "");
	if (!command) {
		process.exit(0);
	}

	// Match on the command with quoted spans blanked out, so a *mention* of
	// `gh pr create` inside a string / script arg / test-data doesn't trip the
	// gate — only a real, unquoted invocation does.
	const gateCommand = stripQuotedSpans(command);
	if (!isGatedGhPrCreate(gateCommand) && !isGatedGhPrEdit(gateCommand)) {
		process.exit(0);
	}

	const repoRoot = resolveRepoRoot(command, toolCall.cwd);
	// Without a repo root we can't run the checks reliably; fail open
	// rather than blocking on an environment quirk.
	if (!repoRoot) {
		process.stderr.write(
			"pr-quality-gate: CLAUDE_PROJECT_DIR not set and no runnable cwd; skipping checks (fail open)\n",
		);
		process.exit(0);
	}

	for (const { argv, label } of CHECKS) {
		const failure = runCheck(argv, repoRoot);
		if (!failure) {
			continue;
		}
		const tail = tailLines(failure.output, MAX_OUTPUT_LINES);
		const reason = [
			`Pre-PR check failed: \`${label}\` exited ${failure.exitCode} (CONTRIBUTING.md:79-86).`,
			"The checks already ran — answering here does NOT run or fix anything.",
			tail &&
				`\nLast ${MAX_OUTPUT_LINES} lines of \`${label}\`:\n${tail}`,
			"\nYes → create the PR anyway, leaving these issues unfixed." +
				"\nNo  → cancel (nothing is created) so you can fix them first.",
		]
			.filter(Boolean)
			.join("\n");
		// Don't hard-block: escalate to the user. They see the findings and
		// decide whether to fix or create the PR anyway. Exit 0 so the "ask"
		// decision JSON is authoritative.
		writeAskDecision(reason);
		process.exit(0);
	}

	process.exit(0);
}

main();
