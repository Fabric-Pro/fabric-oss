/**
 * Git plumbing for the member proposal branch (design
 * 2026-09-26 §7): the workspace a branch's append/revert/settlement steps
 * share, the branch-tip and pull-request-head fetches, the provenance
 * primitives (`isAncestor`, `revListOutside`) §6.4 step 4/5 and §6.7/§6.8
 * read, byte-exact tree reads for the per-file rule, and the lease-enforced
 * fast-forward push that is every append/revert after the branch's first.
 *
 * Every command here runs through the same bounded runner, `GIT_SAFE_CONFIG`,
 * askpass env and redaction as `instruction-sync-git.ts` (imported, not
 * duplicated): `runGit`, `assertObjectId`, `assertTreePath` and
 * `assertNoUrlCredentials` are that file's own guards, exported for reuse so
 * this module's validation never drifts from the sync's and the #2563
 * proposal path's.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { TreeEntry } from "@repo/instructions";
import { MEMBER_BRANCH_PATTERN } from "@repo/instructions/proposal-branch-ref";
import {
	assertNoUrlCredentials,
	assertObjectId,
	assertTreePath,
	classifyGitFailure,
	type GitCallBase,
	GitCommandError,
	isPushWriteRefusal,
	MAX_CLONE_BYTES,
	porcelainFlag,
	runGit,
	runPush,
} from "./instruction-sync-git";

const watched = (dir: string) => ({
	watchDir: dir,
	maxDirBytes: MAX_CLONE_BYTES,
});

/**
 * Spec §7: the member proposal branch ref pattern (plan Global Constraints),
 * plus `check-ref-format --branch` for defense in depth. Synchronous, like
 * every other `assert*Branch` guard in this feature, so a caller can validate
 * before any async git call is even scheduled. `check-ref-format` cannot
 * actually reject anything `MEMBER_BRANCH_PATTERN` accepts — the pattern's
 * charset (`[a-z0-9-]` segments joined by exactly one `/`, ending in a bare
 * digit sequence) contains none of the characters or shapes
 * `check-ref-format` refuses (no `.`, `~`, `^`, `:`, `?`, `*`, `[`, `\`,
 * `@{`, leading `-`, or empty component) — but it is cheap, and it is what
 * spec §7's table asks for.
 */
export function assertMemberBranch(branch: string): void {
	if (!MEMBER_BRANCH_PATTERN.test(branch)) {
		throw new GitCommandError("invalid_argument", null, "", "branch");
	}
	try {
		execFileSync("git", ["check-ref-format", "--branch", branch], {
			stdio: "ignore",
		});
	} catch {
		throw new GitCommandError("invalid_argument", null, "", "branch");
	}
}

/**
 * Spec §7: a full (never shallow), blobless clone at `targetRef`, without a
 * checkout — the workspace every branch git step (fetches, tree reads,
 * builds, pushes) runs in for one branch's turn of work. Deliberately not
 * the sync's own treeless clone helper (`instruction-sync-git.ts` `cloneArgs`
 * / `cloneTreeless`), which is `--depth 1`: a shallow clone cannot answer
 * `isAncestor`/`revListOutside` about history the branch's own commits sit
 * on top of.
 */
export async function initBranchWorkspace(
	input: GitCallBase & { url: string; targetRef: string; dir: string },
): Promise<void> {
	assertNoUrlCredentials(input.url, "clone");
	const cwd = path.dirname(input.dir);
	await runGit({
		cwd,
		args: [
			"clone",
			"--quiet",
			"--filter=blob:none",
			"--single-branch",
			"--branch",
			input.targetRef,
			"--no-tags",
			"--no-checkout",
			"--",
			input.url,
			input.dir,
		],
		env: input.env,
		signal: input.signal,
		label: "clone",
		...watched(cwd),
	});
}

/** The local ref `fetchBranchHead` lands the remote tip on, never a name a caller controls. */
const BRANCH_TIP_REF = "refs/fabric/tip";

/**
 * Spec §7: the current tip of `refs/heads/<branch>` on `origin`, fetched
 * blobless and complete into the workspace `initBranchWorkspace` built (so
 * the branch's own history, not just its tip commit, is locally available
 * for `isAncestor`/`revListOutside`). A ref that no longer exists on the
 * remote is `absent` (spec §6.4 step 1: "a head is recorded but the ref is
 * absent" retires the branch); any other fetch failure rethrows.
 */
export async function fetchBranchHead(
	input: GitCallBase & { dir: string; branch: string },
): Promise<{ kind: "present"; sha: string } | { kind: "absent" }> {
	assertMemberBranch(input.branch);
	try {
		await runGit({
			cwd: input.dir,
			args: [
				"fetch",
				"--quiet",
				"--no-tags",
				"--filter=blob:none",
				"origin",
				`+refs/heads/${input.branch}:${BRANCH_TIP_REF}`,
			],
			env: input.env,
			signal: input.signal,
			label: "fetch",
			...watched(input.dir),
		});
	} catch (error) {
		if (
			error instanceof GitCommandError &&
			error.kind === "exit" &&
			classifyGitFailure(error.stderrTail) === "commit_missing"
		) {
			return { kind: "absent" };
		}
		throw error;
	}
	const { stdout } = await runGit({
		cwd: input.dir,
		args: ["rev-parse", "--verify", `${BRANCH_TIP_REF}^{commit}`],
		env: input.env,
		signal: input.signal,
		label: "rev-parse",
		maxStdoutBytes: 256,
	});
	const sha = stdout.toString("utf8").trim();
	assertObjectId(sha, "rev-parse");
	return { kind: "present", sha };
}

/** A provider's head ref, as `pullRequestHeadRef` (spec §7) supplies it: `refs/...`, nothing else. */
const PROVIDER_REF_PATTERN = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function assertProviderRef(ref: string): void {
	if (!PROVIDER_REF_PATTERN.test(ref) || ref.includes("..")) {
		throw new GitCommandError("invalid_argument", null, "", "fetch");
	}
}

/** The local ref `fetchPullRequestHead` lands the provider's head on. */
const PULL_REQUEST_HEAD_REF = "refs/fabric/pr-head";

/**
 * Spec §7: fetches the adapter-supplied provider head ref (`pullRequestHeadRef`)
 * blobless and complete, then requires it to equal the observed `sha`
 * exactly — never partial trust of a ref name alone. `unavailable` covers
 * both a fetch the provider refuses (spec §7: GitLab deletes the ref 14 days
 * after merge or close) and a fetched ref that does not match, which
 * classification (spec §6.6) falls back on the branch ref for.
 */
export async function fetchPullRequestHead(
	input: GitCallBase & { dir: string; ref: string; sha: string },
): Promise<{ kind: "ok" } | { kind: "unavailable" }> {
	assertObjectId(input.sha, "fetch");
	assertProviderRef(input.ref);
	try {
		await runGit({
			cwd: input.dir,
			args: [
				"fetch",
				"--quiet",
				"--no-tags",
				"--filter=blob:none",
				"origin",
				`${input.ref}:${PULL_REQUEST_HEAD_REF}`,
			],
			env: input.env,
			signal: input.signal,
			label: "fetch",
			...watched(input.dir),
		});
	} catch (error) {
		if (error instanceof GitCommandError && error.kind === "exit") {
			return { kind: "unavailable" };
		}
		throw error;
	}
	const { stdout } = await runGit({
		cwd: input.dir,
		args: ["rev-parse", "--verify", `${PULL_REQUEST_HEAD_REF}^{commit}`],
		env: input.env,
		signal: input.signal,
		label: "rev-parse",
		maxStdoutBytes: 256,
	});
	const sha = stdout.toString("utf8").trim();
	return sha === input.sha ? { kind: "ok" } : { kind: "unavailable" };
}

/** Bounded `ls-tree` output for a handful of explicit paths. */
const READ_TREE_ENTRIES_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

const TREE_ENTRY_HEADER = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})$/;

/** Git's `(mode, type)` pair to this feature's `TreeEntry["type"]` (spec §4.1 "Entry"). */
function treeEntryTypeFor(
	mode: string,
	gitType: string,
): TreeEntry["type"] | null {
	if (gitType === "blob" && (mode === "100644" || mode === "100755")) {
		return "blob";
	}
	if (gitType === "blob" && mode === "120000") {
		return "symlink";
	}
	if (gitType === "commit" && mode === "160000") {
		return "gitlink";
	}
	return null;
}

/**
 * Spec §7: `ls-tree -z --full-tree <sha> -- <literal paths>`, byte-exact
 * (type, mode, object id), for exactly the given repository paths. A path
 * `ls-tree` does not report — because it is absent from the tree — maps to
 * `null` rather than being left out of the returned map, so a caller never
 * confuses "not asked for" with "not present".
 */
export async function readTreeEntries(
	input: GitCallBase & { dir: string; sha: string; rawPaths: string[] },
): Promise<Map<string, TreeEntry | null>> {
	assertObjectId(input.sha, "ls-tree");
	const result = new Map<string, TreeEntry | null>(
		input.rawPaths.map((rawPath) => [rawPath, null]),
	);
	if (input.rawPaths.length === 0) {
		return result;
	}
	for (const rawPath of input.rawPaths) {
		assertTreePath(rawPath);
	}
	const { stdout } = await runGit({
		cwd: input.dir,
		args: [
			"ls-tree",
			"-z",
			"--full-tree",
			input.sha,
			"--",
			...input.rawPaths,
		],
		env: input.env,
		signal: input.signal,
		label: "ls-tree",
		maxStdoutBytes: READ_TREE_ENTRIES_MAX_STDOUT_BYTES,
	});
	for (const record of stdout.toString("utf8").split("\0")) {
		if (record === "") {
			continue;
		}
		const tab = record.indexOf("\t");
		const header =
			tab < 0 ? null : TREE_ENTRY_HEADER.exec(record.slice(0, tab));
		if (!header) {
			throw new GitCommandError("exit", 0, "", "ls-tree");
		}
		const [, mode, gitType, oid] = header as unknown as [
			string,
			string,
			string,
			string,
		];
		const type = treeEntryTypeFor(mode, gitType);
		if (type === null) {
			// ls-tree matched an explicit pathspec with something this feature
			// never stores an entry for (a directory, most likely): a caller
			// bug, not absence, so this fails loudly rather than reading null.
			throw new GitCommandError("exit", 0, "", "ls-tree");
		}
		const rawPath = record.slice(tab + 1);
		if (result.has(rawPath)) {
			result.set(rawPath, { type, mode, oid });
		}
	}
	return result;
}

/**
 * Spec §7: `merge-base --is-ancestor` → `"true"`, `"false"` (exit 1), or
 * `"error"` (any other exit, including a missing object). Object existence
 * (`cat-file -e`) is never evidence of ancestry, and an `"error"` is never
 * read as `"false"` by a caller: both spec §6.4 step 4 and §6.7 step 0 treat
 * an inconclusive check the same as a foreign-history finding.
 */
export async function isAncestor(
	input: GitCallBase & { dir: string; ancestor: string; descendant: string },
): Promise<"true" | "false" | "error"> {
	assertObjectId(input.ancestor, "merge-base");
	assertObjectId(input.descendant, "merge-base");
	try {
		await runGit({
			cwd: input.dir,
			args: [
				"merge-base",
				"--is-ancestor",
				input.ancestor,
				input.descendant,
			],
			env: input.env,
			signal: input.signal,
			label: "merge-base",
			maxStdoutBytes: 256,
		});
		return "true";
	} catch (error) {
		if (error instanceof GitCommandError && error.kind === "exit") {
			return error.exitCode === 1 ? "false" : "error";
		}
		throw error;
	}
}

/** Default cap on commits `revListOutside` reports (spec §7 "bounded"). */
const REV_LIST_DEFAULT_LIMIT = 5_000;
/** Wide enough for a SHA-256 hex line (64 + newline) at the default limit. */
const REV_LIST_BYTES_PER_LINE = 65;

/**
 * Spec §7: `rev-list --full-history <from>..<to> [-- <literal path>]` minus
 * `known` (the branch's own established journal shas), bounded. `--full-history`
 * is what makes a merge commit that brought in foreign history count (spec
 * §6.4 step 4): first-parent-only traversal would skip it. `{kind: "error"}`
 * on any git failure or on exceeding `limit`, read the same way as `isAncestor`'s
 * `"error"`: inconclusive, never "clean".
 */
export async function revListOutside(
	input: GitCallBase & {
		dir: string;
		from: string;
		to: string;
		known: ReadonlySet<string>;
		rawPath?: string;
		limit?: number;
	},
): Promise<{ kind: "ok"; outside: string[] } | { kind: "error" }> {
	assertObjectId(input.from, "rev-list");
	assertObjectId(input.to, "rev-list");
	if (input.rawPath !== undefined) {
		assertTreePath(input.rawPath);
	}
	const limit = input.limit ?? REV_LIST_DEFAULT_LIMIT;
	const args = ["rev-list", "--full-history", `${input.from}..${input.to}`];
	if (input.rawPath !== undefined) {
		args.push("--", input.rawPath);
	}
	try {
		const { stdout } = await runGit({
			cwd: input.dir,
			args,
			env: input.env,
			signal: input.signal,
			label: "rev-list",
			maxStdoutBytes: (limit + 1) * REV_LIST_BYTES_PER_LINE,
		});
		const shas = stdout
			.toString("utf8")
			.split("\n")
			.filter((line) => line !== "");
		return {
			kind: "ok",
			outside: shas.filter((sha) => !input.known.has(sha)),
		};
	} catch (error) {
		if (
			error instanceof GitCommandError &&
			(error.kind === "exit" || error.kind === "output_limit")
		) {
			return { kind: "error" };
		}
		throw error;
	}
}

/**
 * Spec §7: asserts `sha`'s only parent is `parentSha` (never a merge, never a
 * rewrite), then leases the ref at `parentSha` with
 * `--force-with-lease=refs/heads/<branch>:<parentSha>` — git's lease alone
 * does not refuse a non-fast-forward, so this assertion is what makes the
 * push safe (spec Decision 5). `+` refspecs are never used on a push, only
 * the lease syntax above. Classified with the same porcelain parser
 * `pushCreateOnly` uses: `stale` on a lease mismatch, `refused` on a hook,
 * protection or write-permission refusal, `pushed` only on git's own
 * fast-forward flag for exactly this ref.
 */
export async function pushFastForward(
	input: GitCallBase & {
		dir: string;
		parentSha: string;
		sha: string;
		branch: string;
	},
): Promise<{ kind: "pushed" } | { kind: "stale" } | { kind: "refused" }> {
	assertObjectId(input.parentSha, "rev-parse");
	assertObjectId(input.sha, "push");
	assertMemberBranch(input.branch);
	const { stdout: parentsOut } = await runGit({
		cwd: input.dir,
		args: ["rev-parse", `${input.sha}^@`],
		env: input.env,
		signal: input.signal,
		label: "rev-parse",
		maxStdoutBytes: 4096,
	});
	const parents = parentsOut
		.toString("utf8")
		.split("\n")
		.filter((line) => line !== "");
	if (parents.length !== 1 || parents[0] !== input.parentSha) {
		throw new GitCommandError("invalid_argument", null, "", "rev-parse");
	}
	const ref = `refs/heads/${input.branch}`;
	const { stdout, error } = await runPush({
		cwd: input.dir,
		env: input.env,
		signal: input.signal,
		label: "push",
		...watched(input.dir),
		args: [
			"push",
			"--porcelain",
			"--no-follow-tags",
			`--force-with-lease=${ref}:${input.parentSha}`,
			"origin",
			`${input.sha}:${ref}`,
		],
	});
	const line = porcelainFlag(stdout, ref);
	if (line !== null && line.flag === "" && error === null) {
		return { kind: "pushed" };
	}
	if (line?.flag === "!" && /stale info|fetch first/.test(line.summary)) {
		return { kind: "stale" };
	}
	if (line?.flag === "!") {
		return { kind: "refused" };
	}
	if (line === null && error !== null && isPushWriteRefusal(error)) {
		return { kind: "refused" };
	}
	throw error ?? new GitCommandError("exit", 0, "", "push");
}
