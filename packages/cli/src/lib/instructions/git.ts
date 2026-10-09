/**
 * The only way this CLI runs `git`: a fixed vocabulary of read-only questions
 * and three bounded writes — `cloneInto`, `fetchRef` and `fastForwardTo`
 * (Fizzy #2708, #2878).
 *
 * A repository-sourced project's session hook compares the checkout it runs
 * in with the commit the project last published from. That needs a handful
 * of facts about the checkout — where its work tree is, which remotes it
 * fetches from, which branch is checked out and what it tracks, whether the
 * published commit is in its history, whether anything else is writing — and
 * nothing else. So this module exports exactly those questions, one function
 * each, and no way to run an arbitrary git command. The process runner is
 * `git-run.ts` and the two writes to an existing checkout are `git-write.ts`;
 * callers import only this file.
 *
 * The three writes are callable only from `init` and the session hook:
 *
 *   - `cloneInto` clones a project's repository into an EMPTY folder, with
 *     the person at the keyboard;
 *   - `fetchRef` fetches one branch into its remote-tracking ref, never
 *     forced, so a rewritten upstream is refused rather than followed;
 *   - `fastForwardTo` moves the checked-out branch to a commit that descends
 *     from HEAD (`merge --ff-only`).
 *
 * Nothing here pulls, rebases, stashes or checks out, and a caller cannot make
 * it.
 *
 * Every call is bounded and quiet:
 *
 *   - `spawn` with no shell, stdin closed, and a timeout taken from the
 *     caller's absolute deadline (SIGTERM, then SIGKILL a second later unless
 *     the process has exited by then);
 *   - an environment with every inherited `FABRIC_*` variable removed, the
 *     variables that redirect git at a different repository removed, prompts
 *     disabled, and optional locks, lazy fetches and fsmonitor turned off.
 *     The Fabric Git gateway adds a single URL-scoped Authorization header to
 *     its child process only; no credential is written to Git configuration;
 *   - stdout capped at 64 KiB, stderr captured and never printed.
 *
 * The clone differs in one way: it needs the developer's own git credentials,
 * so `init --clone` keeps their credential helpers and their `GIT_ASKPASS` and
 * `SSH_ASKPASS` programs on purpose. That makes it interactive by design: a
 * helper may ask the person in its own window. git's own terminal prompt is
 * still off, and the clone is bounded by `CLONE_TIMEOUT_MS`, 5 minutes. The
 * session hook's fetch and merge run unattended: `hookWriteEnvironment` strips
 * both askpass programs, so nothing can open a prompt nobody is there to
 * answer.
 *
 * Every function answers with a discriminated result rather than throwing for
 * the expected failures: `absent` means "not a git repository", and
 * `unavailable` means git could not answer — it is not installed, it timed
 * out, it refused a repository it does not trust, the repository is bare, or
 * its `.git` points nowhere. The reason is fixed text chosen here, never
 * git's own message, which can quote paths and configuration.
 */
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import {
	COMMIT_SHA,
	cloneableUrl,
	isBranchLiteral,
	isRemoteName,
} from "./git-literals.js";
import {
	exitReason,
	type GitDeadline,
	type GitHttpAuthorization,
	type GitResult,
	isNotARepository,
	lines,
	runGit,
	simple,
} from "./git-run.js";

export { changedTrackedPaths } from "./git-diff.js";
export {
	cloneableUrl,
	isBranchLiteral,
	isCommitSha,
	isRemoteName,
} from "./git-literals.js";
export {
	type GitDeadline,
	type GitHttpAuthorization,
	type GitResult,
	gitEnvironment,
	hookWriteEnvironment,
} from "./git-run.js";
export { fastForwardTo, fetchRef, fetchRefFromUrl } from "./git-write.js";

export interface WorkTree {
	/** The work tree's top level, as git reports it. */
	toplevel: string;
	gitDir: string;
	shallow: boolean;
	/** The superproject's work tree when this is a submodule checkout. */
	superproject: string | null;
}

export type GitOperation =
	| "merge"
	| "rebase"
	| "cherry-pick"
	| "revert"
	| "bisect";

export interface CheckoutTraits {
	shallow: boolean;
	sparse: boolean;
	superproject: boolean;
}

/** The files and directories git leaves while each operation is in progress. */
const OPERATION_MARKERS: ReadonlyArray<{
	marker: string;
	operation: GitOperation;
}> = [
	{ marker: "MERGE_HEAD", operation: "merge" },
	{ marker: "REBASE_HEAD", operation: "rebase" },
	{ marker: "rebase-merge", operation: "rebase" },
	{ marker: "rebase-apply", operation: "rebase" },
	{ marker: "CHERRY_PICK_HEAD", operation: "cherry-pick" },
	{ marker: "REVERT_HEAD", operation: "revert" },
	{ marker: "BISECT_LOG", operation: "bisect" },
	// Left by a multi-commit cherry-pick or revert between steps; the two
	// HEAD markers above name which one while a step is stopped.
	{ marker: "sequencer", operation: "cherry-pick" },
];

/** The nearest existing directory at or above `dir`, or null. */
async function nearestExistingDirectory(dir: string): Promise<string | null> {
	let current = path.resolve(dir);
	for (;;) {
		const found = await stat(current).catch(() => null);
		if (found?.isDirectory()) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

/** Whether any directory at or above `dir` holds a `.git` entry. */
async function hasGitEntryAbove(dir: string): Promise<boolean> {
	let current = dir;
	for (;;) {
		if (
			(await lstat(path.join(current, ".git")).catch(() => null)) !== null
		) {
			return true;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return false;
		}
		current = parent;
	}
}

/**
 * The work tree `dir` belongs to — `dir` itself, or its nearest existing
 * ancestor when it does not exist yet.
 *
 * When git is not installed, a directory with no `.git` anywhere above it is
 * still answered `absent`: it is certainly not a checkout, and treating it as
 * "unknown" would stop a machine without git from doing what it did before.
 */
export async function findWorkTree(
	dir: string,
	deadline: GitDeadline,
): Promise<GitResult<WorkTree>> {
	const cwd = await nearestExistingDirectory(dir);
	if (cwd === null) {
		return { kind: "absent" };
	}
	const result = await runGit(
		cwd,
		[
			"rev-parse",
			"--show-toplevel",
			"--is-bare-repository",
			"--is-shallow-repository",
			"--git-dir",
			"--show-superproject-working-tree",
		],
		deadline,
	);
	if (result.kind === "unavailable") {
		if (result.missing && !(await hasGitEntryAbove(cwd))) {
			return { kind: "absent" };
		}
		return { kind: "unavailable", reason: result.reason };
	}
	if (result.code !== 0) {
		return isNotARepository(result.stderr)
			? { kind: "absent" }
			: { kind: "unavailable", reason: exitReason(result) };
	}
	const [toplevel, bare, shallow, gitDir, superproject, ...rest] = lines(
		result.stdout,
	);
	if (
		!toplevel ||
		!gitDir ||
		rest.length > 0 ||
		(bare !== "true" && bare !== "false") ||
		(shallow !== "true" && shallow !== "false")
	) {
		return { kind: "unavailable", reason: "git answered unexpectedly" };
	}
	if (bare === "true") {
		return { kind: "unavailable", reason: "a bare repository" };
	}
	return {
		kind: "ok",
		value: {
			toplevel,
			gitDir: path.resolve(cwd, gitDir),
			shallow: shallow === "true",
			superproject: superproject ? superproject : null,
		},
	};
}

/** The configured remote names. */
export async function remotes(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<string[]>> {
	const result = await simple(root, ["remote"], deadline);
	if (result.kind !== "ok") {
		return result;
	}
	if (result.value.code !== 0) {
		return {
			kind: "unavailable",
			reason: `git exited with status ${result.value.code}`,
		};
	}
	return { kind: "ok", value: lines(result.value.stdout) };
}

/**
 * The URL git would actually FETCH from for `remote` — after `insteadOf`
 * rewriting, which is why the configured `remote.<name>.url` is not read.
 * `null` when the remote has none: `ls-remote --get-url` echoes a name it
 * cannot resolve, and a name that reads as an option is never passed at all.
 * Contacts no server.
 */
export async function effectiveFetchUrl(
	root: string,
	remote: string,
	deadline: GitDeadline,
): Promise<GitResult<string | null>> {
	if (!isRemoteName(remote)) {
		return { kind: "ok", value: null };
	}
	const result = await simple(
		root,
		["ls-remote", "--get-url", remote],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	if (result.value.code !== 0) {
		return {
			kind: "unavailable",
			reason: `git exited with status ${result.value.code}`,
		};
	}
	const [url] = lines(result.value.stdout);
	return { kind: "ok", value: url && url !== remote ? url : null };
}

/** The checked-out branch's short name, or `null` for a detached HEAD. */
export async function currentBranch(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<string | null>> {
	const result = await simple(
		root,
		["symbolic-ref", "--short", "-q", "HEAD"],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	if (result.value.code === 1) {
		return { kind: "ok", value: null };
	}
	if (result.value.code !== 0) {
		return {
			kind: "unavailable",
			reason: `git exited with status ${result.value.code}`,
		};
	}
	const [branch] = lines(result.value.stdout);
	return { kind: "ok", value: branch ?? null };
}

/** The commit HEAD names, or `null` on a branch with no commits yet. */
export async function headSha(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<string | null>> {
	const result = await simple(
		root,
		["rev-parse", "--verify", "-q", "HEAD"],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	if (result.value.code === 1) {
		return { kind: "ok", value: null };
	}
	const [sha] = lines(result.value.stdout);
	if (result.value.code !== 0 || !sha || !COMMIT_SHA.test(sha)) {
		return { kind: "unavailable", reason: "git answered unexpectedly" };
	}
	return { kind: "ok", value: sha };
}

/**
 * Whether `ancestorSha` is in `descendantSha`'s history. `unavailable` when
 * git cannot say — most often because the commit has not been fetched into
 * this clone. Both must be full object names; nothing else is passed to git.
 */
export async function isAncestor(
	root: string,
	ancestorSha: string,
	descendantSha: string,
	deadline: GitDeadline,
): Promise<GitResult<boolean>> {
	if (!COMMIT_SHA.test(ancestorSha) || !COMMIT_SHA.test(descendantSha)) {
		return { kind: "unavailable", reason: "not a commit name" };
	}
	const result = await simple(
		root,
		["merge-base", "--is-ancestor", ancestorSha, descendantSha],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	if (result.value.code === 0) {
		return { kind: "ok", value: true };
	}
	if (result.value.code === 1) {
		return { kind: "ok", value: false };
	}
	return { kind: "unavailable", reason: "the commit is not in this clone" };
}

/**
 * Whether no tracked file's CONTENT differs from the index or from HEAD. Asked
 * of git's own content comparison (`diff --quiet`, then `diff --cached
 * --quiet`) rather than `status`: a file whose only difference is how its
 * line endings are stored (`core.autocrlf`, a tool that rewrites generated
 * files on every session) is listed by `status` but has no content change.
 * Untracked files are not changes: `git pull --ff-only` is not stopped by
 * them either, and when an incoming commit does want one of those paths git
 * itself refuses, naming it.
 */
export async function hasNoTrackedContentChanges(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<boolean>> {
	for (const scope of [[], ["--cached"]]) {
		const result = await simple(
			root,
			["diff", "--quiet", "--ignore-submodules=none", ...scope],
			deadline,
		);
		if (result.kind !== "ok") {
			return result;
		}
		if (result.value.code === 1) {
			return { kind: "ok", value: false };
		}
		if (result.value.code !== 0) {
			return {
				kind: "unavailable",
				reason: `git exited with status ${result.value.code}`,
			};
		}
	}
	return { kind: "ok", value: true };
}

/**
 * The subset of `relativePaths` that Git tracks. Callers use this before
 * changing Fabric-owned local setup, because an untracked file is personal
 * configuration but a tracked one belongs to the repository.
 */
export async function trackedPaths(
	root: string,
	relativePaths: readonly string[],
	deadline: GitDeadline,
): Promise<GitResult<string[]>> {
	if (relativePaths.length === 0) {
		return { kind: "ok", value: [] };
	}
	if (
		relativePaths.some(
			(relativePath) =>
				relativePath === "" ||
				relativePath.startsWith("-") ||
				path.isAbsolute(relativePath) ||
				path.win32.isAbsolute(relativePath) ||
				relativePath.split(/[\\/]/).some((part) => part === ".."),
		)
	) {
		return {
			kind: "unavailable",
			reason: "not paths git can be asked about",
		};
	}
	const result = await simple(
		root,
		["ls-files", "-z", "--", ...relativePaths],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	if (result.value.code !== 0) {
		return {
			kind: "unavailable",
			reason: `git exited with status ${result.value.code}`,
		};
	}
	return {
		kind: "ok",
		value: result.value.stdout.split("\0").filter((entry) => entry !== ""),
	};
}

/**
 * A conservative signature of Git having created an empty index but failed to
 * populate the work tree. It deliberately does not treat ordinary local edits
 * as interrupted work: a normal dirty checkout still has its tracked index.
 */
export async function checkoutAppearsIncomplete(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<boolean>> {
	const index = await simple(root, ["ls-files", "--stage", "-z"], deadline);
	if (index.kind !== "ok") {
		return index;
	}
	if (index.value.code !== 0) {
		return {
			kind: "unavailable",
			reason: `git exited with status ${index.value.code}`,
		};
	}
	if (index.value.stdout !== "") {
		return { kind: "ok", value: false };
	}
	const [headTree, staged, untracked] = await Promise.all([
		simple(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"], deadline),
		simple(root, ["diff", "--cached", "--quiet", "--exit-code"], deadline),
		simple(
			root,
			["ls-files", "--others", "--exclude-standard", "-z"],
			deadline,
		),
	]);
	if (headTree.kind !== "ok") {
		return headTree;
	}
	if (staged.kind !== "ok") {
		return staged;
	}
	if (untracked.kind !== "ok") {
		return untracked;
	}
	if (
		headTree.value.code !== 0 ||
		(staged.value.code !== 0 && staged.value.code !== 1) ||
		untracked.value.code !== 0
	) {
		return { kind: "unavailable", reason: "git answered unexpectedly" };
	}
	return {
		kind: "ok",
		value:
			headTree.value.stdout !== "" &&
			staged.value.code === 1 &&
			untracked.value.stdout !== "",
	};
}

/** The operation in progress in this checkout, or `null` when there is none. */
export async function operationInProgress(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<GitOperation | null>> {
	const result = await simple(
		root,
		[
			"rev-parse",
			...OPERATION_MARKERS.flatMap(({ marker }) => [
				"--git-path",
				marker,
			]),
		],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	const paths = lines(result.value.stdout);
	if (result.value.code !== 0 || paths.length !== OPERATION_MARKERS.length) {
		return { kind: "unavailable", reason: "git answered unexpectedly" };
	}
	for (const [index, { operation }] of OPERATION_MARKERS.entries()) {
		const marker = path.resolve(root, paths[index] as string);
		if ((await lstat(marker).catch(() => null)) !== null) {
			return { kind: "ok", value: operation };
		}
	}
	return { kind: "ok", value: null };
}

/** Shallow clone, sparse checkout, submodule of a superproject. */
export async function checkoutTraits(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<CheckoutTraits>> {
	const tree = await simple(
		root,
		[
			"rev-parse",
			"--is-shallow-repository",
			"--show-superproject-working-tree",
		],
		deadline,
	);
	if (tree.kind !== "ok") {
		return tree;
	}
	const [shallow, superproject] = lines(tree.value.stdout);
	if (tree.value.code !== 0) {
		return { kind: "unavailable", reason: "git answered unexpectedly" };
	}
	const sparse = await simple(
		root,
		["config", "--get", "core.sparseCheckout"],
		deadline,
	);
	if (sparse.kind !== "ok") {
		return sparse;
	}
	return {
		kind: "ok",
		value: {
			shallow: shallow === "true",
			sparse:
				sparse.value.code === 0 &&
				lines(sparse.value.stdout)[0]?.toLowerCase() === "true",
			superproject: Boolean(superproject),
		},
	};
}

/**
 * Whether `ref` is a branch name this CLI will compare, print and put in a
 * suggested command: the literal must pass `BRANCH_LITERAL` with no `..`, no
 * `@{`, no trailing `/` or `.lock`, AND git's own `check-ref-format --branch`
 * must accept it unchanged.
 */
export async function checkRefFormat(
	root: string,
	ref: string,
	deadline: GitDeadline,
): Promise<GitResult<boolean>> {
	if (!isBranchLiteral(ref)) {
		return { kind: "ok", value: false };
	}
	const result = await simple(
		root,
		["check-ref-format", "--branch", ref],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	const [normalized] = lines(result.value.stdout);
	return { kind: "ok", value: result.value.code === 0 && normalized === ref };
}

/**
 * The upstream a local branch tracks, as `<remote>/<branch>`, or `null` when
 * it tracks nothing. A branch name that is not a plain literal is never passed
 * to git and has none.
 */
export async function upstreamOf(
	root: string,
	branch: string,
	deadline: GitDeadline,
): Promise<GitResult<string | null>> {
	if (!isBranchLiteral(branch)) {
		return { kind: "ok", value: null };
	}
	const result = await simple(
		root,
		["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	if (result.value.code !== 0) {
		return {
			kind: "unavailable",
			reason: `git exited with status ${result.value.code}`,
		};
	}
	const [upstream] = lines(result.value.stdout);
	return { kind: "ok", value: upstream ? upstream : null };
}

/**
 * Whether git is writing in this checkout right now: an `index.lock` or a
 * `HEAD.lock` exists. Asked of git for the paths (a linked worktree keeps its
 * own), then `lstat`.
 */
export async function lockFilesPresent(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<boolean>> {
	const result = await simple(
		root,
		["rev-parse", "--git-path", "index.lock", "--git-path", "HEAD.lock"],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	const paths = lines(result.value.stdout);
	if (result.value.code !== 0 || paths.length !== 2) {
		return { kind: "unavailable", reason: "git answered unexpectedly" };
	}
	for (const lock of paths) {
		if (
			(await lstat(path.resolve(root, lock)).catch(() => null)) !== null
		) {
			return { kind: "ok", value: true };
		}
	}
	return { kind: "ok", value: false };
}

/**
 * The work trees of this repository that have the branch `ref` checked out,
 * this one included: `git worktree list --porcelain`.
 */
export async function worktreesOnBranch(
	root: string,
	ref: string,
	deadline: GitDeadline,
): Promise<GitResult<string[]>> {
	if (!isBranchLiteral(ref)) {
		return { kind: "ok", value: [] };
	}
	const result = await simple(
		root,
		["worktree", "list", "--porcelain"],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	if (result.value.code !== 0) {
		return {
			kind: "unavailable",
			reason: `git exited with status ${result.value.code}`,
		};
	}
	const holders: string[] = [];
	let current: string | null = null;
	for (const line of lines(result.value.stdout)) {
		if (line.startsWith("worktree ")) {
			current = line.slice("worktree ".length);
		} else if (current !== null && line === `branch refs/heads/${ref}`) {
			holders.push(current);
		}
	}
	return { kind: "ok", value: holders };
}

/**
 * The repository's common directory (`.git` of the main checkout, which a
 * linked worktree shares), as an absolute path.
 */
export async function commonDir(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<string>> {
	const result = await simple(
		root,
		["rev-parse", "--git-common-dir"],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	const [dir] = lines(result.value.stdout);
	if (result.value.code !== 0 || !dir) {
		return { kind: "unavailable", reason: "git answered unexpectedly" };
	}
	return { kind: "ok", value: path.resolve(root, dir) };
}

/**
 * Where git keeps this checkout's local, untracked ignore rules
 * (`info/exclude`), as an absolute path. Asked of git rather than guessed,
 * because a linked worktree shares the main checkout's file and a `.git`
 * that is a pointer has no `info` directory of its own.
 */
export async function excludeFilePath(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<string>> {
	const result = await simple(
		root,
		["rev-parse", "--git-path", "info/exclude"],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	const [answer] = lines(result.value.stdout);
	if (result.value.code !== 0 || !answer) {
		return { kind: "unavailable", reason: "git answered unexpectedly" };
	}
	return { kind: "ok", value: path.resolve(root, answer) };
}

/**
 * Whether git already ignores `relativePath` (relative to `root`, the work
 * tree's top level) by any rule — a repository's `.gitignore`, the developer's
 * global one, or `info/exclude`. The path need not exist.
 */
export async function isIgnored(
	root: string,
	relativePath: string,
	deadline: GitDeadline,
): Promise<GitResult<boolean>> {
	if (relativePath.startsWith("-") || relativePath === "") {
		return {
			kind: "unavailable",
			reason: "not a path git can be asked about",
		};
	}
	const result = await simple(
		root,
		["check-ignore", "-q", "--", relativePath],
		deadline,
	);
	if (result.kind !== "ok") {
		return result;
	}
	if (result.value.code === 0) {
		return { kind: "ok", value: true };
	}
	if (result.value.code === 1) {
		return { kind: "ok", value: false };
	}
	return {
		kind: "unavailable",
		reason: "git could not say whether it is ignored",
	};
}

export type CloneFailure =
	| "auth"
	| "network"
	| "missing-ref"
	| "not-empty"
	/** Git downloaded the repository but could not populate the working tree. */
	| "checkout"
	/** Fabric's gateway transport needs git 2.31 (`--config-env`). */
	| "old-git"
	| "other";

export type CloneResult =
	| { kind: "cloned" }
	| { kind: "failed"; reason: CloneFailure }
	| { kind: "unavailable"; reason: string };

/** git's refusal to clone as a class. Only the SHAPE of stderr is read. */
export function cloneFailureOf(stderr: string): CloneFailure {
	if (/config-env/i.test(stderr) && /unknown option|usage:/i.test(stderr)) {
		return "old-git";
	}
	if (/already exists and is not an empty directory/i.test(stderr)) {
		return "not-empty";
	}
	if (/Remote branch .* not found/i.test(stderr)) {
		return "missing-ref";
	}
	if (
		/Filename too long|unable to create file|unable to checkout working tree/i.test(
			stderr,
		)
	) {
		return "checkout";
	}
	if (
		/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied|HTTP (401|403)|error: (401|403)|returned error: (401|403)|Repository not found|access denied/i.test(
			stderr,
		)
	) {
		return "auth";
	}
	if (
		/Could not resolve host|Failed to connect|Connection (refused|timed out|reset)|Operation timed out|unable to access|SSL|TLS/i.test(
			stderr,
		)
	) {
		return "network";
	}
	return "other";
}

/**
 * The one write: clone `url` at `ref` into `dir`, which must be an existing,
 * EMPTY directory (git refuses otherwise, and so does the caller, first).
 *
 * Exactly `git clone --branch <ref> -- <url> .`, except that a Windows clone
 * explicitly enables Git's long-path support and disables its file-system
 * cache for this NEW repository. Both command settings apply while Git checks
 * the work tree out, and the local settings make later Git operations in this
 * clone follow the same rule. No global Git configuration is changed.
 * The clone otherwise keeps Git's normal config, branches and tags, so later
 * fetches and pulls behave as Git's own do. It uses the developer's own
 * credentials and never a prompt (`gitEnvironment`'s `write`). `url` must be
 * a `cloneableUrl`. git's own words are never returned.
 */
export async function cloneInto(
	dir: string,
	url: string,
	ref: string,
	deadline: GitDeadline,
	options: { httpAuthorization?: GitHttpAuthorization } = {},
): Promise<CloneResult> {
	const validUrl = options.httpAuthorization
		? options.httpAuthorization.url === url
		: cloneableUrl(url) === url;
	if (!validUrl || !isBranchLiteral(ref)) {
		return {
			kind: "unavailable",
			reason: "not a repository this will clone",
		};
	}
	const result = await runGit(
		dir,
		[
			...(process.platform === "win32"
				? ["-c", "core.longpaths=true", "-c", "core.fscache=false"]
				: []),
			"clone",
			"--quiet",
			...(process.platform === "win32"
				? [
						"--config",
						"core.longpaths=true",
						"--config",
						"core.fscache=false",
					]
				: []),
			"--branch",
			ref,
			"--",
			url,
			".",
		],
		deadline,
		{ write: true, ...options },
	);
	if (result.kind === "unavailable") {
		return { kind: "unavailable", reason: result.reason };
	}
	return result.code === 0
		? { kind: "cloned" }
		: { kind: "failed", reason: cloneFailureOf(result.stderr) };
}

/**
 * Restore the provider URL after a new clone travelled through Fabric's
 * one-shot authenticated gateway. This is deliberately unavailable to
 * adoption and existing-checkout paths.
 */
export async function setRemoteUrl(
	root: string,
	remote: string,
	url: string,
	deadline: GitDeadline,
): Promise<GitResult<void>> {
	if (!isRemoteName(remote) || cloneableUrl(url) !== url) {
		return { kind: "unavailable", reason: "not a repository remote" };
	}
	const result = await runGit(
		root,
		["remote", "set-url", remote, url],
		deadline,
		{ write: true },
	);
	if (result.kind === "unavailable") {
		return result;
	}
	return result.code === 0
		? { kind: "ok", value: undefined }
		: { kind: "unavailable", reason: "git refused the provider remote" };
}
