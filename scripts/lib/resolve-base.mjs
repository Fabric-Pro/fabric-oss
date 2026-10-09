import { spawnSync } from "node:child_process";

/** Candidate bases, in tie-break order: staging wins a tie. */
export const CANDIDATE_BASES = ["origin/staging", "origin/master"];

export class BaseResolutionError extends Error {}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function git(args, cwd) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.error) {
		throw new BaseResolutionError(
			`Could not run git: ${result.error.message}`,
		);
	}
	return {
		status: result.status ?? 1,
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
	};
}

/**
 * Splits `--base=<ref>` out of an argument list.
 * @param {string[]} args
 * @returns {{ base: string | undefined, rest: string[] }}
 */
export function extractBaseArg(args) {
	let base;
	const rest = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--base") {
			const value = args[++i];
			if (!value) {
				throw new BaseResolutionError(
					"--base requires a ref, e.g. --base=origin/staging",
				);
			}
			base = value;
		} else if (arg.startsWith("--base=")) {
			base = arg.slice("--base=".length);
			if (!base) {
				throw new BaseResolutionError(
					"--base requires a ref, e.g. --base=origin/staging",
				);
			}
		} else {
			rest.push(arg);
		}
	}
	return { base, rest };
}

/**
 * Picks the comparison base for type-check and changeset tooling.
 *
 * An explicit ref wins. Otherwise the candidate with the fewest commits in
 * `<candidate>..HEAD` wins (a branch cut from staging is closest to staging),
 * and a tie goes to origin/staging. The mode (`STAGING_RELEASE_ENABLED`)
 * decides which branch PRs target, so the base is derived from the branch's
 * history rather than hard-coded.
 *
 * @param {{ explicit?: string, cwd?: string }} [options]
 * @returns {{ base: string, reason: string }}
 */
export function resolveBase({ explicit, cwd = process.cwd() } = {}) {
	if (explicit) {
		const verify = git(
			["rev-parse", "--verify", "--quiet", `${explicit}^{commit}`],
			cwd,
		);
		if (verify.status !== 0) {
			throw new BaseResolutionError(
				`--base ref "${explicit}" does not resolve to a commit.`,
			);
		}
		return { base: explicit, reason: "explicit --base" };
	}

	/** @type {{ ref: string, ahead: number }[]} */
	const scored = [];
	for (const ref of CANDIDATE_BASES) {
		if (
			git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)
				.status !== 0
		) {
			continue;
		}
		const count = git(["rev-list", "--count", `${ref}..HEAD`], cwd);
		const ahead = Number.parseInt(count.stdout.trim(), 10);
		if (count.status !== 0 || !Number.isInteger(ahead)) {
			throw new BaseResolutionError(
				`Could not count commits for ${ref}..HEAD: ${count.stderr.trim() || "unexpected output"}`,
			);
		}
		scored.push({ ref, ahead });
	}

	if (scored.length === 0) {
		throw new BaseResolutionError(
			`Neither ${CANDIDATE_BASES.join(" nor ")} exists. Fetch them (git fetch origin) or pass --base=<ref>.`,
		);
	}

	// Array.sort is stable, so equal counts keep CANDIDATE_BASES order (staging first).
	scored.sort((a, b) => a.ahead - b.ahead);
	const [best] = scored;
	return { base: best.ref, reason: `${best.ahead} commit(s) ahead of it` };
}

/**
 * Resolves the base and reports the choice on stderr.
 * @param {{ explicit?: string, cwd?: string }} [options]
 */
export function resolveAndAnnounce(options = {}) {
	const result = resolveBase(options);
	process.stderr.write(`Base: ${result.base} (${result.reason})\n`);
	return result;
}
