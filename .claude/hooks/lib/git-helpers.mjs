import { execSync } from "node:child_process";
import path from "node:path";

/**
 * Test seam. Setting `FABRIC_TEST_BRANCH` overrides `currentBranch()`;
 * use the literal `"__DETACHED__"` to simulate a detached HEAD.
 */
const TEST_BRANCH_ENV = "FABRIC_TEST_BRANCH";

/**
 * Test seam. Setting `FABRIC_TEST_IS_DIRTY` to `"1"` forces a dirty
 * result, `"0"` forces clean. Unset → real `git status` call.
 */
const TEST_DIRTY_ENV = "FABRIC_TEST_IS_DIRTY";

// `ops` is the long-lived operations branch (deploy workflows + ledger, see
// docs/open-source/open-sourcing-plan.md §4.2) — like main/master it is
// pushed to directly, not via prefixed feature branches.
const PROTECTED_BRANCHES = new Set(["main", "master", "ops"]);

/**
 * Extract `<dir>` from a command that leads with `cd <dir> && …` — the pattern
 * used to run a command inside a worktree. Handles single/double-quoted and
 * bare paths; returns null when the command doesn't start with a `cd`.
 *
 * Moved here from pr-quality-gate.mjs so the destructive-op and branch-naming
 * guards can resolve the same effective tree that gate already did, instead of
 * each growing its own copy.
 *
 * @param {string} command
 * @returns {string | null}
 */
export function leadingCdTarget(command) {
	const m = String(command ?? "").match(
		/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s'"&|;]+))\s*&&/,
	);
	return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/**
 * The directory a command actually runs in. A session opened in the main
 * checkout that works inside a worktree — either because Claude Code sends the
 * worktree as the payload `cwd`, or because the command itself leads with
 * `cd <worktree> &&` — must be judged against THAT tree. Reading the launch
 * directory instead can report a clean main worktree while the worktree the
 * command targets has uncommitted work, which is how `git reset --hard` gets
 * waved through.
 *
 * Returns `undefined` when nothing is known, which leaves `execSync` inheriting
 * the process cwd exactly as before.
 *
 * @param {string} [command]
 * @param {string} [payloadCwd]
 * @returns {string | undefined}
 */
export function resolveEffectiveCwd(command, payloadCwd) {
	const target = leadingCdTarget(command ?? "");
	if (target) {
		if (path.isAbsolute(target)) {
			return target;
		}
		return payloadCwd ? path.resolve(payloadCwd, target) : undefined;
	}
	return payloadCwd || undefined;
}

/**
 * Returns the current branch name, or `null` for detached HEAD /
 * non-git contexts. Failing closed here would lock devs out — always
 * fail open (return `null`) on any error.
 *
 * @param {string} [cwd] Directory to read the branch from. Omitted → the
 *   process cwd, i.e. the previous behaviour.
 * @returns {string | null}
 */
export function currentBranch(cwd) {
	const override = process.env[TEST_BRANCH_ENV];
	if (override !== undefined) {
		return override === "__DETACHED__" ? null : override;
	}
	try {
		const out = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
		if (out === "HEAD" || out === "") {
			return null;
		}
		return out;
	} catch {
		return null;
	}
}

/**
 * Returns true when `git status --porcelain` reports any change.
 * Returns `false` for non-git directories so destructive-but-safe
 * commands (e.g. `git reset --hard` in a fresh clone) aren't blocked.
 *
 * @param {string} [cwd] Tree to inspect. Omitted → the process cwd, i.e. the
 *   previous behaviour.
 * @returns {boolean}
 */
export function isDirty(cwd) {
	const override = process.env[TEST_DIRTY_ENV];
	if (override === "1") {
		return true;
	}
	if (override === "0") {
		return false;
	}
	try {
		const out = execSync("git status --porcelain", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		}).toString();
		return out.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * @param {string | null | undefined} name
 */
export function isProtectedBranch(name) {
	if (!name) {
		return false;
	}
	return PROTECTED_BRANCHES.has(name);
}
