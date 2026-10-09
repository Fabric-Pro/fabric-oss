/**
 * The two writes a repository-sourced project's session hook may make to an
 * existing checkout: fetch one branch, and fast-forward to a commit. Both run
 * unattended, so they use `hookWriteEnvironment` (askpass programs stripped,
 * git's terminal prompt and Git Credential Manager off, ssh in batch mode
 * unless the developer chose a program) and `-c credential.interactive=never`.
 *
 * Neither ever rewrites history. The fetch's refspec is NOT forced, so a
 * branch whose upstream was rewritten is refused as `diverged` instead of
 * silently reset, and the merge is `--ff-only`. The one thing written to the
 * work tree besides the merge itself is a file whose only difference from the
 * index is how its line endings are stored, put back from the index when
 * that is all that stands in the merge's way. Nothing here pulls, rebases,
 * stashes or checks out a branch. git's own words are never returned: stderr
 * is classified by shape only.
 */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { COMMIT_SHA, isBranchLiteral, isRemoteName } from "./git-literals.js";
import {
	type GitDeadline,
	type GitHttpAuthorization,
	lines,
	runGit,
} from "./git-run.js";

export type FetchFailure =
	| "auth"
	| "network"
	| "timeout"
	| "missing-ref"
	| "diverged"
	| "old-git"
	| "other";

export type FetchResult =
	| { kind: "fetched"; tip: string }
	| { kind: "failed"; reason: FetchFailure }
	/** The caller's deadline killed git: nothing is known about the remote. */
	| { kind: "timed-out" }
	| { kind: "unavailable"; reason: string };

/**
 * Why `merge --ff-only` refused. Only a refusal over local changes names
 * files: the ones a person has to deal with, after any whose only difference
 * is line endings has been put back.
 */
export type MergeFailure =
	| { reason: "local-changes"; files: string[] }
	| { reason: "diverged" | "busy" | "other" };

export type MergeResult =
	| { kind: "merged"; head: string }
	| ({ kind: "failed" } & MergeFailure)
	| { kind: "timed-out" }
	| { kind: "unavailable"; reason: string };

/** git's refusal to fetch, as a class. Only the SHAPE of stderr is read. */
export function fetchFailureOf(stderr: string): FetchFailure {
	// Fabric's gateway transport hands git its credential with `--config-env`
	// (git 2.31); an older git refuses the option before it connects.
	if (/config-env/i.test(stderr) && /unknown option|usage:/i.test(stderr)) {
		return "old-git";
	}
	if (/\(non-fast-forward\)|\[rejected\]|cannot fast-forward/i.test(stderr)) {
		return "diverged";
	}
	if (/couldn't find remote ref|invalid refspec/i.test(stderr)) {
		return "missing-ref";
	}
	if (
		/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied|HTTP (401|403)|error: (401|403)|returned error: (401|403)|Repository not found|access denied/i.test(
			stderr,
		)
	) {
		return "auth";
	}
	if (
		/Operation timed out|Connection timed out|Timeout was reached|RPC failed; HTTP 408|curl 28/i.test(
			stderr,
		)
	) {
		return "timeout";
	}
	if (
		/Could not resolve host|Failed to connect|Connection (refused|reset)|unable to access|SSL|TLS|Could not read from remote repository/i.test(
			stderr,
		)
	) {
		return "network";
	}
	return "other";
}

/** git's refusal to fast-forward, as a class. Only the SHAPE of stderr is read. */
export function mergeFailureOf(stderr: string): MergeFailure["reason"] {
	if (
		/Unable to create '.*\.lock'|\.lock': File exists|Another git process/i.test(
			stderr,
		)
	) {
		return "busy";
	}
	if (
		/would be overwritten by merge/i.test(stderr) &&
		/local changes|untracked working tree files/i.test(stderr)
	) {
		return "local-changes";
	}
	if (
		/Not possible to fast-forward|refusing to merge unrelated histories|diverging branches/i.test(
			stderr,
		)
	) {
		return "diverged";
	}
	return "other";
}

/**
 * The files git names when it refuses a merge because a change in the tree
 * would be overwritten: the tab-indented lines under its "would be
 * overwritten by merge:" heading. Paths are git's own words, shown and capped
 * by the caller; none is ever run as anything but a literal path.
 */
function blockedFilesOf(stderr: string): string[] {
	const files: string[] = [];
	let listing = false;
	for (const line of stderr.split(/\r?\n/)) {
		if (/would be overwritten by merge:\s*$/i.test(line)) {
			listing = true;
		} else if (listing && /^\s+\S/.test(line)) {
			files.push(line.trim());
		} else {
			listing = false;
		}
	}
	return files;
}

/**
 * `--no-write-fetch-head` needs git 2.29. It is used until a git that does not
 * know it says so, once, rather than reading the version at every fetch.
 */
let fetchHeadFlagWorks = true;

/** For tests: forget what an earlier fetch learned about the git in use. */
export function resetFetchHeadFlagForTests(): void {
	fetchHeadFlagWorks = true;
}

function timedOut(reason: string): boolean {
	return reason === "git timed out";
}

/**
 * Fetch `ref` of `source` (a remote name, or the gateway's URL) into the
 * remote-tracking ref of `remote` and answer the tip.
 *
 * `git fetch --no-recurse-submodules --no-tags --no-write-fetch-head --
 * <source> refs/heads/<ref>:refs/remotes/<remote>/<ref>`, then
 * `rev-parse --verify` of that ref. Only the tracked branch is asked for: no
 * tags (a session start does not need them, and asking for them is an extra
 * round of negotiation) and no `FETCH_HEAD` to rewrite. NOT
 * `--no-show-forced-updates`: it also skips the fast-forward check, so a
 * rewritten upstream would be taken instead of refused. The remote must pass
 * `isRemoteName` and the branch `isBranchLiteral`; anything else is never
 * passed to git.
 *
 * Not `--quiet`: a fetch that refuses a non-fast-forward update says nothing
 * at all under it, and the shape of that refusal is how `diverged` is told
 * from every other failure. stderr is captured and never printed.
 */
async function fetchInto(
	root: string,
	source: string,
	remote: string,
	ref: string,
	deadline: GitDeadline,
	httpAuthorization?: GitHttpAuthorization,
): Promise<FetchResult> {
	if (!isRemoteName(remote) || !isBranchLiteral(ref)) {
		return { kind: "unavailable", reason: "not a branch this will fetch" };
	}
	const tracking = `refs/remotes/${remote}/${ref}`;
	const fetchWith = (skipFetchHead: boolean) =>
		runGit(
			root,
			[
				"-c",
				"gc.auto=0",
				"-c",
				"maintenance.auto=false",
				"fetch",
				"--no-recurse-submodules",
				"--no-tags",
				...(skipFetchHead ? ["--no-write-fetch-head"] : []),
				"--",
				source,
				`refs/heads/${ref}:${tracking}`,
			],
			deadline,
			{
				write: true,
				unattended: true,
				...(httpAuthorization === undefined
					? {}
					: { httpAuthorization }),
			},
		);
	let fetched = await fetchWith(fetchHeadFlagWorks);
	if (
		fetched.kind === "exited" &&
		fetched.code !== 0 &&
		fetchHeadFlagWorks &&
		/no-write-fetch-head/i.test(fetched.stderr)
	) {
		// git older than 2.29 does not know the flag: ask again without it, and
		// remember not to use it.
		fetchHeadFlagWorks = false;
		fetched = await fetchWith(false);
	}
	if (fetched.kind === "unavailable") {
		return timedOut(fetched.reason)
			? { kind: "timed-out" }
			: { kind: "unavailable", reason: fetched.reason };
	}
	if (fetched.code !== 0) {
		return { kind: "failed", reason: fetchFailureOf(fetched.stderr) };
	}
	const tip = await runGit(
		root,
		["rev-parse", "--verify", "-q", `${tracking}^{commit}`],
		deadline,
	);
	if (tip.kind === "unavailable") {
		return timedOut(tip.reason)
			? { kind: "timed-out" }
			: { kind: "unavailable", reason: tip.reason };
	}
	const [sha] = lines(tip.stdout);
	if (tip.code !== 0 || !sha || !COMMIT_SHA.test(sha)) {
		return { kind: "failed", reason: "missing-ref" };
	}
	return { kind: "fetched", tip: sha };
}

/** Fetch `ref` of the checkout's own `remote` into its remote-tracking ref. */
export function fetchRef(
	root: string,
	remote: string,
	ref: string,
	deadline: GitDeadline,
): Promise<FetchResult> {
	return fetchInto(root, remote, remote, ref, deadline);
}

/**
 * Fetch through Fabric's authenticated Git gateway into the existing remote
 * tracking ref. The configured provider remote is never rewritten.
 */
export function fetchRefFromUrl(
	root: string,
	url: string,
	remote: string,
	ref: string,
	deadline: GitDeadline,
	httpAuthorization: GitHttpAuthorization,
): Promise<FetchResult> {
	return fetchInto(root, url, remote, ref, deadline, httpAuthorization);
}

async function mergeOnce(
	root: string,
	sha: string,
	deadline: GitDeadline,
): Promise<MergeResult> {
	const merged = await runGit(
		root,
		[
			"-c",
			"core.quotepath=false",
			"merge",
			"--ff-only",
			"--no-edit",
			"--quiet",
			sha,
		],
		deadline,
		{ write: true, unattended: true },
	);
	if (merged.kind === "unavailable") {
		return timedOut(merged.reason)
			? { kind: "timed-out" }
			: { kind: "unavailable", reason: merged.reason };
	}
	if (merged.code !== 0) {
		const reason = mergeFailureOf(merged.stderr);
		return reason === "local-changes"
			? { kind: "failed", reason, files: blockedFilesOf(merged.stderr) }
			: { kind: "failed", reason };
	}
	const head = await runGit(
		root,
		["rev-parse", "--verify", "-q", "HEAD"],
		deadline,
	);
	if (head.kind === "unavailable") {
		return timedOut(head.reason)
			? { kind: "timed-out" }
			: { kind: "unavailable", reason: head.reason };
	}
	const [now] = lines(head.stdout);
	return head.code === 0 && now === sha
		? { kind: "merged", head: now }
		: { kind: "failed", reason: "other" };
}

/** The NUL-separated paths a `-z` listing holds. */
function nulPaths(stdout: string): string[] {
	return stdout.split("\0").filter((entry) => entry !== "");
}

/** Attributes that change what git stores or shows for a file: its content is not the bytes on disk. */
const CONVERTING_ATTRIBUTES = ["filter", "ident", "working-tree-encoding"];

/** A file this large is never read to decide it is only a line-ending difference. */
const MAX_COMPARED_BYTES = 1024 * 1024;

const CRLF = /\r\n/g;

/** A `-z` listing split on NUL, dropping only the terminator after the last field (an empty field in the middle is a value). */
function nulFields(stdout: string): string[] {
	const fields = stdout.split("\0");
	if (fields[fields.length - 1] === "") {
		fields.pop();
	}
	return fields;
}

/**
 * The blobs `ids` names, read raw in one `git cat-file --batch`, as `latin1`
 * strings (one character per byte). `null` for a blob that is missing or
 * larger than a file is ever compared; `"ran-out-of-time"` when the deadline
 * stopped the read; `undefined` when git could not answer otherwise.
 */
async function readBlobs(
	root: string,
	ids: readonly string[],
	deadline: GitDeadline,
): Promise<Map<string, string | null> | "ran-out-of-time" | undefined> {
	const read = new Map<string, string | null>();
	const unique = [...new Set(ids)];
	if (unique.length === 0) {
		return read;
	}
	const answer = await runGit(root, ["cat-file", "--batch"], deadline, {
		binary: true,
		binaryCapBytes: 16 * MAX_COMPARED_BYTES,
		input: `${unique.join("\n")}\n`,
	});
	if (answer.kind === "unavailable") {
		return timedOut(answer.reason) ? "ran-out-of-time" : undefined;
	}
	if (answer.code !== 0) {
		return undefined;
	}
	let at = 0;
	for (const id of unique) {
		const end = answer.stdout.indexOf("\n", at);
		if (end === -1) {
			return undefined;
		}
		const header = answer.stdout.slice(at, end).split(" ");
		if (header[1] === "missing") {
			read.set(id, null);
			at = end + 1;
			continue;
		}
		const size = Number(header[2]);
		if (header[1] !== "blob" || !Number.isInteger(size)) {
			return undefined;
		}
		read.set(
			id,
			size > MAX_COMPARED_BYTES
				? null
				: answer.stdout.slice(end + 1, end + 1 + size),
		);
		at = end + 1 + size + 1;
	}
	return read;
}

/**
 * The work-tree bytes of a tracked file, when they are the index's apart from
 * CRLF versus LF (or are identical, because git refused over something that
 * restoring does not lose, such as stale stat data under `core.autocrlf`) and
 * the file's type and, where git tracks it, its executable bit are the
 * index's too: the one difference it is safe to undo. `git diff` is not that
 * proof (it skips assume-unchanged and skip-worktree entries and compares
 * through clean filters, so a local edit can read as no change), so this
 * reads both sides raw. Binary content, a symlink, a changed mode, or a file
 * too large to read are never restorable.
 */
async function restorableBytes(
	root: string,
	file: string,
	entry: { mode: string },
	indexed: string | null | undefined,
	fileMode: boolean,
): Promise<Buffer | null> {
	if (indexed === null || indexed === undefined || entry.mode === "120000") {
		return null;
	}
	const absolute = path.join(root, file);
	const info = await lstat(absolute).catch(() => null);
	if (info === null || !info.isFile() || info.size > MAX_COMPARED_BYTES) {
		return null;
	}
	const executable = (info.mode & 0o111) !== 0;
	if (fileMode && executable !== (entry.mode === "100755")) {
		return null;
	}
	const local = await readFile(absolute).catch(() => null);
	if (local === null) {
		return null;
	}
	const mine = local.toString("latin1");
	if (mine.includes("\0") || indexed.includes("\0")) {
		return null;
	}
	return mine.replace(CRLF, "\n") === indexed.replace(CRLF, "\n")
		? local
		: null;
}

interface Judged {
	real: string[];
	restorable: Map<string, Buffer>;
}

/**
 * Which of `files`, the ones git refused the merge over, stand in its way for
 * a reason a person has to settle, and the work-tree bytes of those that do
 * not. `null` when git could not say, `"ran-out-of-time"` when the deadline
 * stopped the check (so nobody is told the files are theirs). A file may be
 * put back from the index only when it is tracked, in the ordinary state (not
 * assume-unchanged or skip-worktree), has no converting attribute, has no
 * staged change, git itself sees no content change in it (a file that can
 * never read as clean, such as CRLF in the index under `eol=lf`, is not one
 * to rewrite at every session), its type and executable bit are the index's,
 * and its raw bytes equal the index's apart from CRLF versus LF.
 *
 * `--literal-pathspecs` because these are names git printed, not patterns.
 */
async function realBlockers(
	root: string,
	files: readonly string[],
	deadline: GitDeadline,
): Promise<Judged | "ran-out-of-time" | null> {
	const scope = ["--literal-pathspecs", "-c", "core.quotepath=false"];
	const [staged, unstaged, flags, stages, attributes, fileModeSetting] =
		await Promise.all([
			runGit(
				root,
				[
					...scope,
					"diff",
					"--cached",
					"--name-only",
					"-z",
					"--",
					...files,
				],
				deadline,
			),
			runGit(
				root,
				[...scope, "diff", "--name-only", "-z", "--", ...files],
				deadline,
			),
			runGit(
				root,
				[...scope, "ls-files", "-v", "-z", "--", ...files],
				deadline,
			),
			runGit(
				root,
				[...scope, "ls-files", "-s", "-z", "--", ...files],
				deadline,
			),
			runGit(
				root,
				[
					...scope,
					"check-attr",
					"-z",
					...CONVERTING_ATTRIBUTES,
					"--",
					...files,
				],
				deadline,
			),
			runGit(
				root,
				["config", "--type=bool", "--get", "core.fileMode"],
				deadline,
			),
		]);
	const answers = [
		staged,
		unstaged,
		flags,
		stages,
		attributes,
		fileModeSetting,
	];
	if (answers.some((answer) => answer.kind === "unavailable")) {
		return answers.some(
			(answer) =>
				answer.kind === "unavailable" && timedOut(answer.reason),
		)
			? "ran-out-of-time"
			: null;
	}
	if (
		staged.kind !== "exited" ||
		unstaged.kind !== "exited" ||
		flags.kind !== "exited" ||
		stages.kind !== "exited" ||
		attributes.kind !== "exited" ||
		fileModeSetting.kind !== "exited" ||
		[staged, unstaged, flags, stages, attributes].some(
			(answer) => answer.kind === "exited" && answer.code !== 0,
		)
	) {
		return null;
	}
	// An unset core.fileMode is git's default, true; exit 1 says it is unset.
	const fileMode = fileModeSetting.stdout.trim() !== "false";
	const changed = new Set([
		...nulPaths(staged.stdout),
		...nulPaths(unstaged.stdout),
	]);
	const ordinary = new Set(
		nulPaths(flags.stdout)
			.filter((entry) => entry.startsWith("H "))
			.map((entry) => entry.slice(2)),
	);
	const entries = new Map<string, { mode: string; blob: string }>();
	for (const entry of nulPaths(stages.stdout)) {
		const match = /^(\d+) ([0-9a-f]{40,64}) (\d)\t([\s\S]*)$/.exec(entry);
		if (
			match?.[3] === "0" &&
			match[1] !== undefined &&
			match[2] !== undefined &&
			match[4] !== undefined
		) {
			entries.set(match[4], { mode: match[1], blob: match[2] });
		}
	}
	const converted = new Set<string>();
	const fields = nulFields(attributes.stdout);
	for (let at = 0; at + 2 < fields.length; at += 3) {
		if (fields[at + 2] !== "unspecified") {
			converted.add(fields[at] as string);
		}
	}
	const candidates = files.filter(
		(file) =>
			entries.has(file) &&
			ordinary.has(file) &&
			!converted.has(file) &&
			!changed.has(file),
	);
	const blobs = await readBlobs(
		root,
		candidates.map((file) => entries.get(file)?.blob ?? ""),
		deadline,
	);
	if (blobs === "ran-out-of-time" || blobs === undefined) {
		return blobs === undefined ? null : blobs;
	}
	const real: string[] = [];
	const restorable = new Map<string, Buffer>();
	for (const file of files) {
		const entry = entries.get(file);
		const bytes =
			entry === undefined || !candidates.includes(file)
				? null
				: await restorableBytes(
						root,
						file,
						entry,
						blobs.get(entry.blob),
						fileMode,
					);
		if (bytes === null) {
			real.push(file);
		} else {
			restorable.set(file, bytes);
		}
	}
	return { real, restorable };
}

/** How long must be left to put files back and merge once more. */
const RESTORE_AND_MERGE_FLOOR_MS = 1_500;

/** The files still hold the bytes that were judged, checked again just before they are overwritten. */
async function stillUntouched(
	root: string,
	restorable: ReadonlyMap<string, Buffer>,
): Promise<boolean> {
	for (const [file, bytes] of restorable) {
		const now = await readFile(path.join(root, file)).catch(() => null);
		if (now === null || !now.equals(bytes)) {
			return false;
		}
	}
	return true;
}

/**
 * Move the checked-out branch to `sha`, which must descend from HEAD:
 * `git merge --ff-only --no-edit --quiet <sha>`, then HEAD must BE `sha`.
 * `sha` must be a full commit name.
 *
 * git refuses that merge for a tracked file whose work-tree copy differs from
 * the index only in line endings (`core.autocrlf`, a tool that rewrites files
 * on every session) when the incoming commit touches it, although `git diff`
 * shows nothing. When every file git names is such a file, they are put back
 * from the index (`git checkout -- <files>`: their content does not change,
 * only how it is stored) and the merge is tried once more. A file that is
 * untracked, or whose content differs, is a person's: then nothing at all is
 * restored, the tree stays exactly as found, and the refusal names only
 * those files.
 */
export async function fastForwardTo(
	root: string,
	sha: string,
	deadline: GitDeadline,
): Promise<MergeResult> {
	if (!COMMIT_SHA.test(sha)) {
		return { kind: "unavailable", reason: "not a commit name" };
	}
	const first = await mergeOnce(root, sha, deadline);
	if (
		first.kind !== "failed" ||
		first.reason !== "local-changes" ||
		first.files.length === 0
	) {
		return first;
	}
	const judged = await realBlockers(root, first.files, deadline);
	if (judged === "ran-out-of-time") {
		return { kind: "timed-out" };
	}
	if (judged === null) {
		return first;
	}
	if (judged.real.length > 0) {
		return { kind: "failed", reason: "local-changes", files: judged.real };
	}
	// Close the gap between judging the bytes and overwriting them, and do not
	// start what a deadline would cut off half way.
	if (
		deadline - Date.now() < RESTORE_AND_MERGE_FLOOR_MS ||
		!(await stillUntouched(root, judged.restorable))
	) {
		return first;
	}
	const restored = await runGit(
		root,
		["--literal-pathspecs", "checkout", "--", ...first.files],
		deadline,
		{ write: true, unattended: true },
	);
	if (restored.kind !== "exited" || restored.code !== 0) {
		return first;
	}
	return mergeOnce(root, sha, deadline);
}
