/**
 * The two writes a repository-sourced project's session hook may make to an
 * existing checkout: fetch one branch, and fast-forward to a commit. Both run
 * unattended, so they use `hookWriteEnvironment` (askpass programs stripped,
 * git's terminal prompt and Git Credential Manager off, ssh in batch mode
 * unless the developer chose a program) and `-c credential.interactive=never`.
 *
 * Neither ever rewrites history. The fetch's refspec is NOT forced, so a
 * branch whose upstream was rewritten is refused as `diverged` instead of
 * silently reset, and the merge is `--ff-only`. Nothing here pulls, rebases,
 * stashes or checks out. git's own words are never returned: stderr is
 * classified by shape only.
 */
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
	| "other";

export type FetchResult =
	| { kind: "fetched"; tip: string }
	| { kind: "failed"; reason: FetchFailure }
	/** The caller's deadline killed git: nothing is known about the remote. */
	| { kind: "timed-out" }
	| { kind: "unavailable"; reason: string };

export type MergeFailure = "diverged" | "busy" | "local-changes" | "other";

export type MergeResult =
	| { kind: "merged"; head: string }
	| { kind: "failed"; reason: MergeFailure; files?: string[] }
	| { kind: "timed-out" }
	| { kind: "unavailable"; reason: string };

/** git's refusal to fetch, as a class. Only the SHAPE of stderr is read. */
export function fetchFailureOf(stderr: string): FetchFailure {
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
export function mergeFailureOf(stderr: string): MergeFailure {
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
 * by the caller; none is ever run.
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
 * Fetch `ref` of `remote` into its remote-tracking ref and answer the tip.
 *
 * `git fetch --no-recurse-submodules -- <remote>
 * refs/heads/<ref>:refs/remotes/<remote>/<ref>`, then `rev-parse --verify`
 * of that ref. Tags follow git's own rules (the remote's `tagOpt`, otherwise
 * the tags that point into what was fetched), as they do for `git pull`. The
 * remote must pass `isRemoteName` and the branch `isBranchLiteral`; anything
 * else is never passed to git.
 *
 * Not `--quiet`: a fetch that refuses a non-fast-forward update says nothing
 * at all under it, and the shape of that refusal is how `diverged` is told
 * from every other failure. stderr is captured and never printed.
 */
export async function fetchRef(
	root: string,
	remote: string,
	ref: string,
	deadline: GitDeadline,
): Promise<FetchResult> {
	if (!isRemoteName(remote) || !isBranchLiteral(ref)) {
		return { kind: "unavailable", reason: "not a branch this will fetch" };
	}
	const tracking = `refs/remotes/${remote}/${ref}`;
	const fetched = await runGit(
		root,
		[
			"-c",
			"gc.auto=0",
			"-c",
			"maintenance.auto=false",
			"fetch",
			"--no-recurse-submodules",
			"--",
			remote,
			`refs/heads/${ref}:${tracking}`,
		],
		deadline,
		{ write: true, unattended: true },
	);
	if (fetched.kind === "unavailable") {
		return fetched.reason === "git timed out"
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
		return tip.reason === "git timed out"
			? { kind: "timed-out" }
			: { kind: "unavailable", reason: tip.reason };
	}
	const [sha] = lines(tip.stdout);
	if (tip.code !== 0 || !sha || !COMMIT_SHA.test(sha)) {
		return { kind: "failed", reason: "missing-ref" };
	}
	return { kind: "fetched", tip: sha };
}

/**
 * Fetch through Fabric's authenticated Git gateway into the existing remote
 * tracking ref. The configured provider remote is never rewritten.
 */
export async function fetchRefFromUrl(
	root: string,
	url: string,
	remote: string,
	ref: string,
	deadline: GitDeadline,
	httpAuthorization: GitHttpAuthorization,
): Promise<FetchResult> {
	if (!isRemoteName(remote) || !isBranchLiteral(ref)) {
		return { kind: "unavailable", reason: "not a branch this will fetch" };
	}
	const tracking = `refs/remotes/${remote}/${ref}`;
	const fetched = await runGit(
		root,
		[
			"-c",
			"gc.auto=0",
			"-c",
			"maintenance.auto=false",
			"fetch",
			"--no-recurse-submodules",
			"--",
			url,
			`refs/heads/${ref}:${tracking}`,
		],
		deadline,
		{ write: true, unattended: true, httpAuthorization },
	);
	if (fetched.kind === "unavailable") {
		return fetched.reason === "git timed out"
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
		return tip.reason === "git timed out"
			? { kind: "timed-out" }
			: { kind: "unavailable", reason: tip.reason };
	}
	const [sha] = lines(tip.stdout);
	if (tip.code !== 0 || !sha || !COMMIT_SHA.test(sha)) {
		return { kind: "failed", reason: "missing-ref" };
	}
	return { kind: "fetched", tip: sha };
}

/**
 * Move the checked-out branch to `sha`, which must descend from HEAD:
 * `git merge --ff-only --no-edit --quiet <sha>`, then HEAD must BE `sha`.
 * `sha` must be a full commit name.
 */
export async function fastForwardTo(
	root: string,
	sha: string,
	deadline: GitDeadline,
): Promise<MergeResult> {
	if (!COMMIT_SHA.test(sha)) {
		return { kind: "unavailable", reason: "not a commit name" };
	}
	const merged = await runGit(
		root,
		["merge", "--ff-only", "--no-edit", "--quiet", sha],
		deadline,
		{ write: true, unattended: true },
	);
	if (merged.kind === "unavailable") {
		return merged.reason === "git timed out"
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
		return head.reason === "git timed out"
			? { kind: "timed-out" }
			: { kind: "unavailable", reason: head.reason };
	}
	const [now] = lines(head.stdout);
	return head.code === 0 && now === sha
		? { kind: "merged", head: now }
		: { kind: "failed", reason: "other" };
}
