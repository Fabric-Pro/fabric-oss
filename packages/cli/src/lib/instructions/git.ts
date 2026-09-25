/**
 * The only way this CLI runs `git`, and it only ever READS (Fizzy #2708).
 *
 * A repository-sourced project's session hook compares the checkout it runs
 * in with the commit the project last published from. That needs a handful
 * of facts about the checkout — where its work tree is, which remotes it
 * fetches from, which branch is checked out, whether the published commit is
 * in its history — and nothing else. So this module exports exactly those
 * questions, one function each, and no way to run an arbitrary git command:
 * nothing here fetches, pulls, merges, checks out, stashes, or writes to a
 * checkout, and a caller cannot make it.
 *
 * Every call is bounded and quiet:
 *
 *   - `spawn` with no shell, stdin closed, and a timeout taken from the
 *     caller's absolute deadline (SIGTERM, then SIGKILL a second later);
 *   - an environment with every `FABRIC_*` variable removed (the API key
 *     never reaches git or anything git might run), the variables that
 *     redirect git at a different repository removed, prompts disabled, and
 *     optional locks, lazy fetches and fsmonitor turned off;
 *   - stdout capped at 64 KiB, stderr captured and never printed.
 *
 * Every function answers with a discriminated result rather than throwing for
 * the expected failures: `absent` means "not a git repository", and
 * `unavailable` means git could not answer — it is not installed, it timed
 * out, it refused a repository it does not trust, the repository is bare, or
 * its `.git` points nowhere. The reason is fixed text chosen here, never
 * git's own message, which can quote paths and configuration.
 */
import { spawn } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import path from "node:path";

export type GitResult<T> =
	| { kind: "ok"; value: T }
	| { kind: "absent" }
	| { kind: "unavailable"; reason: string };

/** An absolute point in time, in epoch milliseconds, that no call may pass. */
export type GitDeadline = number;

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

const STDOUT_CAP_BYTES = 64 * 1024;
const STDERR_CAP_BYTES = 8 * 1024;
const KILL_GRACE_MS = 1_000;

/** A full, lowercase object name. Anything else is never passed to git. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The branch names this module will pass to git or print as a command: a
 * conservative literal on top of `git check-ref-format --branch`, which alone
 * would accept (and expand) `@{-1}` and friends.
 */
const BRANCH_LITERAL = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Remote names as `git remote` lists them; never one that reads as an option. */
const REMOTE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Removed from the inherited environment, alongside every `FABRIC_*` and
 * every `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`. Compared in upper
 * case, because Windows environment names are case-insensitive.
 *
 * The first group redirects git at a different repository; the
 * `GIT_CONFIG_*` group injects or relocates configuration — an `insteadOf`
 * there would change which URL a remote fetches from, and so which
 * repository this checkout is taken to be.
 */
const STRIPPED_VARIABLES = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_NAMESPACE",
	"GIT_COMMON_DIR",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
]);

const STRIPPED_PATTERN = /^(?:FABRIC_|GIT_CONFIG_(?:KEY|VALUE)_\d+$)/;

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

/**
 * Paths this CLI itself writes into a checkout: the session hook's settings.
 * `init` puts one there in every checkout it sets up, so counting it as "your
 * working tree has changes" would make every such checkout permanently dirty.
 */
const OWN_PATHS = [".claude/settings.local.json", ".codex/hooks.json"];

/** The environment every git call runs with, derived from `source`. */
export function gitEnvironment(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(source)) {
		const upper = name.toUpperCase();
		if (STRIPPED_VARIABLES.has(upper) || STRIPPED_PATTERN.test(upper)) {
			continue;
		}
		env[name] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_OPTIONAL_LOCKS = "0";
	env.GIT_NO_LAZY_FETCH = "1";
	env.LC_ALL = "C";
	return env;
}

type Spawned =
	| { kind: "exited"; code: number; stdout: string; stderr: string }
	| { kind: "unavailable"; reason: string; missing?: boolean };

/**
 * Run one read-only git command. Private on purpose: the exported functions
 * below are the whole vocabulary.
 */
function runGit(
	cwd: string,
	args: readonly string[],
	deadline: GitDeadline,
): Promise<Spawned> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		return Promise.resolve({
			kind: "unavailable",
			reason: "git timed out",
		});
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: Spawned): void => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(result);
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("git", ["-c", "core.fsmonitor=false", ...args], {
				cwd,
				env: gitEnvironment(),
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				windowsHide: true,
			});
		} catch (error) {
			resolve(spawnFailure(error));
			return;
		}
		const out: Buffer[] = [];
		let outBytes = 0;
		const err: Buffer[] = [];
		let errBytes = 0;
		child.stdout?.on("data", (chunk: Buffer) => {
			if (outBytes < STDOUT_CAP_BYTES) {
				const room = STDOUT_CAP_BYTES - outBytes;
				out.push(chunk.subarray(0, room));
				outBytes += Math.min(room, chunk.length);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (errBytes < STDERR_CAP_BYTES) {
				const room = STDERR_CAP_BYTES - errBytes;
				err.push(chunk.subarray(0, room));
				errBytes += Math.min(room, chunk.length);
			}
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			const escalate = setTimeout(() => {
				child.kill("SIGKILL");
			}, KILL_GRACE_MS);
			escalate.unref();
			finish({ kind: "unavailable", reason: "git timed out" });
		}, remaining);
		timer.unref();
		child.on("error", (error) => {
			finish(spawnFailure(error));
		});
		child.on("close", (code) => {
			finish({
				kind: "exited",
				code: code ?? -1,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		});
	});
}

function spawnFailure(error: unknown): Spawned {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	if (code === "ENOENT") {
		return {
			kind: "unavailable",
			reason: "git is not installed",
			missing: true,
		};
	}
	if (code === "EACCES" || code === "EPERM") {
		return { kind: "unavailable", reason: "git could not be run" };
	}
	return { kind: "unavailable", reason: "git could not be run" };
}

/**
 * git's refusal as a fixed reason. Only the SHAPE of stderr is read (with
 * `LC_ALL=C` it is English); none of it is ever returned.
 */
function exitReason(result: { code: number; stderr: string }): string {
	const text = result.stderr;
	if (/dubious ownership/i.test(text)) {
		return "git does not trust this repository's owner (safe.directory)";
	}
	if (/must be run in a work tree/i.test(text)) {
		return "not a working tree (a bare repository, or inside .git)";
	}
	if (/not a git repository/i.test(text)) {
		return "its .git points to a repository that does not exist";
	}
	if (/permission denied/i.test(text)) {
		return "permission denied";
	}
	return `git exited with status ${result.code}`;
}

/** `not a git repository (or any of the parent directories)` — and only that. */
function isNotARepository(stderr: string): boolean {
	return /not a git repository \(or any/i.test(stderr);
}

function lines(stdout: string): string[] {
	const trimmed = stdout.replace(/\r?\n$/, "");
	return trimmed === "" ? [] : trimmed.split(/\r?\n/);
}

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

async function simple(
	root: string,
	args: readonly string[],
	deadline: GitDeadline,
): Promise<GitResult<{ code: number; stdout: string }>> {
	const result = await runGit(root, args, deadline);
	if (result.kind === "unavailable") {
		return { kind: "unavailable", reason: result.reason };
	}
	if (result.code === 128 && isNotARepository(result.stderr)) {
		return { kind: "absent" };
	}
	return {
		kind: "ok",
		value: { code: result.code, stdout: result.stdout },
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
	if (!REMOTE_NAME.test(remote)) {
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
 * Whether the work tree has no changes, untracked files included — except the
 * session hook's own settings files (`OWN_PATHS`) while they are UNTRACKED,
 * which is how `init` leaves them. A committed copy of either that has been
 * modified is a change like any other.
 *
 * Two questions: everything but the own paths (untracked included), then the
 * own paths among tracked files only.
 */
export async function isClean(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<boolean>> {
	const everythingElse = await porcelainIsEmpty(
		root,
		[
			"--untracked-files=normal",
			"--",
			":/",
			...OWN_PATHS.map((own) => `:(exclude,top)${own}`),
		],
		deadline,
	);
	if (everythingElse.kind !== "ok" || !everythingElse.value) {
		return everythingElse;
	}
	return porcelainIsEmpty(
		root,
		[
			"--untracked-files=no",
			"--",
			...OWN_PATHS.map((own) => `:(top)${own}`),
		],
		deadline,
	);
}

async function porcelainIsEmpty(
	root: string,
	args: readonly string[],
	deadline: GitDeadline,
): Promise<GitResult<boolean>> {
	const result = await simple(
		root,
		["status", "--porcelain=v1", "--ignore-submodules=none", ...args],
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
	return { kind: "ok", value: result.value.stdout.trim() === "" };
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

/** The literal half of `checkRefFormat`, exported for tests and callers that must not spawn. */
export function isBranchLiteral(ref: string): boolean {
	return (
		ref.length <= 255 &&
		BRANCH_LITERAL.test(ref) &&
		!ref.includes("..") &&
		!ref.includes("@{") &&
		!ref.includes("//") &&
		!ref.endsWith("/") &&
		!ref.endsWith(".") &&
		!ref.endsWith(".lock")
	);
}

/** Whether `sha` is a full commit name this module would pass to git. */
export function isCommitSha(sha: string): boolean {
	return COMMIT_SHA.test(sha);
}
