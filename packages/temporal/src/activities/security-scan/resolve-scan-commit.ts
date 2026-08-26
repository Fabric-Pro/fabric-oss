/**
 * Resolve the commit range a branch-scoped scan should cover (incremental /
 * branch-scoped scanning).
 *
 * This runs BEFORE the code scanners (Semgrep + git-history) and answers two
 * questions without cloning anything:
 *   - `targetSha`: the branch's current remote HEAD (via `git ls-remote`), which
 *     becomes the scan's checkpoint once it completes.
 *   - `baseSha`: the commit the branch was last scanned at (the stored
 *     checkpoint), or null when the branch has never had a completed scan.
 *
 * From those it decides `codeScanMode`: "DIFF" only when this is an INCREMENTAL
 * scan that has a base to diff against and a resolvable head, and the caller
 * didn't force a full re-scan; otherwise "FULL". The code scanners use that to
 * scope Semgrep to changed files and gitleaks to new commits.
 *
 * GRACEFUL DEGRADATION (non-negotiable): resolving a remote HEAD hits the
 * network and reads a checkpoint from the DB — either can fail. This activity
 * NEVER throws: on any failure it returns the safe FULL default (no base, no
 * target), so the scan simply runs a full code scan instead of an incremental
 * one. A failed resolve must never fail the overall scan.
 */

import {
	getProjectReposForCodeSearch,
	getScanCheckpoint,
} from "@repo/database";
import { logger } from "@repo/logs";
import { buildAuthenticatedCloneUrl } from "./semgrep-scan";

export interface ResolveScanCommitInput {
	projectId: string;
	organizationId?: string | null;
	/** The concrete branch this scan runs against (matches the scan row's branch). */
	branch: string;
	/** FULL never diffs; INCREMENTAL diffs when a base checkpoint exists. */
	mode: "FULL" | "INCREMENTAL";
	/** Caller forced a full re-scan (e.g. a purge) — pins codeScanMode to FULL. */
	forceFull?: boolean;
}

export interface ResolveScanCommitOutput {
	/** Echoed back so the workflow threads the same branch downstream. */
	branch: string;
	/** The branch's current remote HEAD, or null when it couldn't be resolved. */
	targetSha: string | null;
	/** The last-scanned commit for this branch (checkpoint), or null on first run. */
	baseSha: string | null;
	/** "DIFF" ⇒ scope code scanners to the base..target range; "FULL" otherwise. */
	codeScanMode: "FULL" | "DIFF";
}

/**
 * Parse the leading commit SHA out of `git ls-remote` output. Each line is
 * `<sha>\t<ref>`; return the first line's SHA. Tolerant of blank lines and CRLF.
 * Pure + exported for unit testing.
 */
export function parseLsRemoteSha(output: string): string | null {
	if (typeof output !== "string") {
		return null;
	}
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const sha = trimmed.split(/\s+/)[0];
		if (sha && /^[0-9a-f]{7,64}$/i.test(sha)) {
			return sha;
		}
	}
	return null;
}

/**
 * Decide the code-scan mode from the resolved base/target. DIFF requires an
 * INCREMENTAL scan, a base checkpoint to diff from, a resolvable head to diff to,
 * and no caller-forced full re-scan. Pure + exported for unit testing.
 */
export function decideCodeScanMode(opts: {
	mode: "FULL" | "INCREMENTAL";
	baseSha: string | null;
	targetSha: string | null;
	forceFull?: boolean;
}): "FULL" | "DIFF" {
	return opts.mode === "INCREMENTAL" &&
		!!opts.baseSha &&
		!opts.forceFull &&
		!!opts.targetSha
		? "DIFF"
		: "FULL";
}

export async function resolveScanCommitActivity(
	input: ResolveScanCommitInput,
): Promise<ResolveScanCommitOutput> {
	const { projectId, branch, mode, forceFull } = input;
	// The safe default: a full scan with no diff scope. Returned on ANY failure.
	const fullResult: ResolveScanCommitOutput = {
		branch,
		targetSha: null,
		baseSha: null,
		codeScanMode: "FULL",
	};

	const trimmedBranch = branch?.trim();
	if (!trimmedBranch) {
		// No concrete branch ⇒ nothing to resolve; run a full scan.
		return fullResult;
	}

	try {
		// 1. Remote HEAD SHA WITHOUT cloning — `git ls-remote <authUrl>
		// refs/heads/<branch>` over the project's first active repo.
		let targetSha: string | null = null;
		const repos = await getProjectReposForCodeSearch(projectId);
		const repo = repos[0];
		if (repo) {
			const authUrl = await buildAuthenticatedCloneUrl(repo);
			if (authUrl) {
				const simpleGit = (await import("simple-git")).default;
				const output = await simpleGit().listRemote([
					authUrl,
					`refs/heads/${trimmedBranch}`,
				]);
				targetSha = parseLsRemoteSha(output ?? "");
			}
		}

		// 2. Base = the branch's last-scanned commit (checkpoint), or null.
		const checkpoint = await getScanCheckpoint(projectId, trimmedBranch);
		const baseSha = checkpoint?.commitSha ?? null;

		return {
			branch,
			targetSha,
			baseSha,
			codeScanMode: decideCodeScanMode({
				mode,
				baseSha,
				targetSha,
				forceFull,
			}),
		};
	} catch (error) {
		// NEVER throw — a failed resolve degrades to a full scan. Do not log the
		// authed URL (it carries a token); the repo slug isn't needed here.
		logger.warn(
			"[ResolveScanCommit] Failed to resolve scan commit — defaulting to a full scan",
			{
				projectId,
				branch: trimmedBranch,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return fullResult;
	}
}
