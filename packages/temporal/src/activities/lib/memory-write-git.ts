/**
 * Git plumbing for a Living Memory write (ADR-022): the branch a pull-request
 * write is pushed to, the read of exactly the tree entries a write touches
 * (folders and links included, which the instruction reader refuses), and the
 * search for a commit an earlier attempt of the same write already pushed.
 *
 * Everything runs through the same bounded runner, `GIT_SAFE_CONFIG`, askpass
 * environment and redaction as `instruction-sync-git.ts` (imported, not
 * duplicated), and every object id, path and branch is guarded before anything
 * spawns. The synced branch itself is written by `pushToSyncedRef`
 * (`instruction-branch-git.ts`); only the memory write's own branch, one per
 * write, is pushed from here.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import { execFileSync } from "node:child_process";
import { MEMORY_WRITE_TRAILER } from "@repo/instructions/pull-request-text";
import {
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

// ---------------------------------------------------------------------------
// The write's own branch
// ---------------------------------------------------------------------------

/** Every ref a pull-request write pushes, exactly: one branch per write, named by its id. */
const MEMORY_WRITE_BRANCH_PATTERN = /^fabric\/memory\/[A-Za-z0-9_-]{8,64}$/;

/** The branch a pull-request write is pushed to. */
export function memoryWriteBranch(writeId: string): string {
	const branch = `fabric/memory/${writeId}`;
	assertMemoryWriteBranch(branch);
	return branch;
}

/**
 * The guard in front of every push of a write's own branch: the ref pattern,
 * plus `check-ref-format --branch` for defense in depth. The pattern's charset
 * cannot produce anything `check-ref-format` refuses; it is cheap, and it keeps
 * a name that is not a write's branch out of a push refspec, whoever calls.
 */
export function assertMemoryWriteBranch(branch: string): void {
	if (!MEMORY_WRITE_BRANCH_PATTERN.test(branch)) {
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
 * Pushes `sha` to `refs/heads/<branch>` only if the ref does not exist (an
 * empty lease). `created` only on git's own `*` for exactly that ref; a ref
 * that exists, even at our own SHA, is `exists`, because ownership never comes
 * from a matching SHA (the caller reads the branch and its trailer). `refused`
 * is a ref the remote would not take (protection, a hook) or a push refused
 * for want of write permission; any other failure rethrows.
 */
export async function pushMemoryWriteBranch(
	input: GitCallBase & { dir: string; sha: string; branch: string },
): Promise<{ kind: "created" } | { kind: "exists" } | { kind: "refused" }> {
	assertObjectId(input.sha, "push");
	assertMemoryWriteBranch(input.branch);
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
			`--force-with-lease=${ref}:`,
			"origin",
			`${input.sha}:${ref}`,
		],
	});
	const line = porcelainFlag(stdout, ref);
	if (line?.flag === "*" && error === null) {
		return { kind: "created" };
	}
	if (
		line?.flag === "=" ||
		(line?.flag === "!" &&
			/stale info|already exists|fetch first/.test(line.summary))
	) {
		return { kind: "exists" };
	}
	if (line?.flag === "!") {
		return { kind: "refused" };
	}
	if (line === null && error !== null && isPushWriteRefusal(error)) {
		return { kind: "refused" };
	}
	throw error ?? new GitCommandError("exit", 0, "", "push");
}

/** The local ref a write's branch is fetched onto, never a name a caller controls. */
const MEMORY_WRITE_BRANCH_TIP_REF = "refs/fabric/memory-branch";

/**
 * The commit a write's own branch holds on the remote, fetched into the
 * workspace; `absent` when the branch does not exist. Used to recognise a
 * branch an earlier attempt of the same write pushed.
 */
export async function fetchMemoryWriteBranchHead(
	input: GitCallBase & { dir: string; branch: string },
): Promise<{ kind: "present"; sha: string } | { kind: "absent" }> {
	assertMemoryWriteBranch(input.branch);
	try {
		await runGit({
			cwd: input.dir,
			args: [
				"fetch",
				"--quiet",
				"--no-tags",
				"--filter=blob:none",
				"origin",
				`+refs/heads/${input.branch}:${MEMORY_WRITE_BRANCH_TIP_REF}`,
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
		args: [
			"rev-parse",
			"--verify",
			`${MEMORY_WRITE_BRANCH_TIP_REF}^{commit}`,
		],
		env: input.env,
		signal: input.signal,
		label: "rev-parse",
		maxStdoutBytes: 256,
	});
	const sha = stdout.toString("utf8").trim();
	assertObjectId(sha, "rev-parse");
	return { kind: "present", sha };
}

// ---------------------------------------------------------------------------
// The entries a write touches
// ---------------------------------------------------------------------------

/** What stands at a path in a tree. A `tree` is a folder. */
export type PathEntry = {
	type: "blob" | "symlink" | "gitlink" | "tree";
	mode: string;
	oid: string;
};

/** Bounded `ls-tree` output for the explicit paths of one write: 50 entries and their ancestors. */
const READ_PATH_ENTRIES_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

const PATH_ENTRY_HEADER = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})$/;

function pathEntryTypeFor(
	mode: string,
	gitType: string,
): PathEntry["type"] | null {
	if (gitType === "blob" && (mode === "100644" || mode === "100755")) {
		return "blob";
	}
	if (gitType === "blob" && mode === "120000") {
		return "symlink";
	}
	if (gitType === "commit" && mode === "160000") {
		return "gitlink";
	}
	if (gitType === "tree" && mode === "040000") {
		return "tree";
	}
	return null;
}

/** Every proper ancestor folder path of `path`, shortest first. */
export function ancestorsOf(path: string): string[] {
	const segments = path.split("/");
	return segments
		.slice(0, -1)
		.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/**
 * `ls-tree -z --full-tree <sha> -- <literal paths>`, byte-exact (type, mode,
 * object id) for exactly the given repository paths, folders and links
 * included: the one read the write plan makes of the tip. A path `ls-tree`
 * does not report, because it is absent (or because a file stands where one of
 * its folders would), maps to `null`, so a caller never confuses "not asked
 * for" with "not present". Pathspecs are literal (`GIT_LITERAL_PATHSPECS`, set
 * by `buildGitEnv`).
 *
 * The paths are read one DEPTH at a time. `ls-tree` lists the children of a
 * folder that is both a pathspec and the parent of a deeper one, which for a
 * folder holding thousands of files is a listing nobody asked for; paths of
 * one depth can never nest, so each call returns exactly the entries named.
 */
export async function readPathEntries(
	input: GitCallBase & { dir: string; sha: string; paths: readonly string[] },
): Promise<Map<string, PathEntry | null>> {
	assertObjectId(input.sha, "ls-tree");
	const result = new Map<string, PathEntry | null>(
		input.paths.map((path) => [path, null]),
	);
	const byDepth = new Map<number, string[]>();
	for (const path of result.keys()) {
		assertTreePath(path);
		const depth = path.split("/").length;
		byDepth.set(depth, [...(byDepth.get(depth) ?? []), path]);
	}
	for (const [, group] of [...byDepth].sort(([a], [b]) => a - b)) {
		const { stdout } = await runGit({
			cwd: input.dir,
			args: ["ls-tree", "-z", "--full-tree", input.sha, "--", ...group],
			env: input.env,
			signal: input.signal,
			label: "ls-tree",
			maxStdoutBytes: READ_PATH_ENTRIES_MAX_STDOUT_BYTES,
		});
		for (const record of stdout.toString("utf8").split("\0")) {
			if (record === "") {
				continue;
			}
			const tab = record.indexOf("\t");
			const header =
				tab < 0 ? null : PATH_ENTRY_HEADER.exec(record.slice(0, tab));
			if (!header) {
				throw new GitCommandError("exit", 0, "", "ls-tree");
			}
			const [, mode, gitType, oid] = header as unknown as [
				string,
				string,
				string,
				string,
			];
			const type = pathEntryTypeFor(mode, gitType);
			if (type === null) {
				throw new GitCommandError("exit", 0, "", "ls-tree");
			}
			const path = record.slice(tab + 1);
			if (result.has(path)) {
				result.set(path, { type, mode, oid });
			}
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Recognising an earlier attempt's commit
// ---------------------------------------------------------------------------

/** The commits `findLandedWriteCommit` reads the messages of: a spoofed match is skipped, so a few are enough. */
const LANDED_COMMIT_CANDIDATES = 20;

/** The most output the candidates' messages may fill; a larger one is a git failure, never a match. */
const LANDED_COMMIT_MAX_STDOUT_BYTES = 1024 * 1024;

/** A write id is an id this codebase issues, never free text. */
const WRITE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Whether `message` ends in a trailer paragraph that holds exactly this write's
 * `Fabric-Memory-Write` line, as the commit builder writes it
 * (`<message>\n\nFabric-Memory-Write: <id>\n[Fabric-Agent: <id>\n]`). A line of
 * that shape anywhere else in a message is somebody else's text, however it
 * got there.
 */
export function endsWithOwnWriteTrailer(
	message: string,
	writeId: string,
): boolean {
	const paragraphs = message.replace(/\s+$/, "").split(/\n[ \t]*\n/);
	const last = paragraphs[paragraphs.length - 1] ?? "";
	return last
		.split("\n")
		.some((line) => line.trim() === `${MEMORY_WRITE_TRAILER}: ${writeId}`);
}

/**
 * The commit of this write already on `tip`'s history, if an earlier attempt
 * pushed it and lost the acknowledgement: the newest commit since `since`
 * whose message ENDS in this write's trailer. `--grep` narrows the history to
 * commits that mention it on some line; the message is then parsed, because a
 * teammate's commit that merely quotes the line (a pasted message, a squash of
 * a commit that had it) is not ours, and taking it for ours would settle a
 * write that never landed. `since` bounds the walk: a write cannot have landed
 * before it was admitted.
 */
export async function findLandedWriteCommit(
	input: GitCallBase & {
		dir: string;
		tip: string;
		writeId: string;
		since: Date;
	},
): Promise<string | null> {
	assertObjectId(input.tip, "log");
	if (!WRITE_ID.test(input.writeId)) {
		throw new GitCommandError("invalid_argument", null, "", "log");
	}
	const { stdout } = await runGit({
		cwd: input.dir,
		args: [
			"log",
			"--extended-regexp",
			`--grep=^${MEMORY_WRITE_TRAILER}: ${input.writeId}$`,
			`--since=${input.since.toISOString()}`,
			"-n",
			String(LANDED_COMMIT_CANDIDATES),
			"--format=%H%x00%B%x01",
			input.tip,
		],
		env: input.env,
		signal: input.signal,
		label: "log",
		maxStdoutBytes: LANDED_COMMIT_MAX_STDOUT_BYTES,
	});
	for (const record of stdout.toString("utf8").split("\u0001")) {
		const [sha, message] = record.trim().split("\u0000");
		if (
			sha !== undefined &&
			message !== undefined &&
			endsWithOwnWriteTrailer(message, input.writeId)
		) {
			assertObjectId(sha, "log");
			return sha;
		}
	}
	return null;
}

/** The full message of one commit the workspace has, for recognising a branch an earlier attempt pushed. */
export async function readCommitMessage(
	input: GitCallBase & { dir: string; sha: string },
): Promise<string> {
	assertObjectId(input.sha, "log");
	const { stdout } = await runGit({
		cwd: input.dir,
		args: ["log", "-n", "1", "--format=%B", input.sha],
		env: input.env,
		signal: input.signal,
		label: "log",
		maxStdoutBytes: LANDED_COMMIT_MAX_STDOUT_BYTES,
	});
	return stdout.toString("utf8");
}
