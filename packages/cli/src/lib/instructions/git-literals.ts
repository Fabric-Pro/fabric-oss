/**
 * What a branch name, a remote name, a commit name and a clone URL may look
 * like before this CLI will hand one to git or print it as a command. Pure:
 * nothing here runs git or touches the disk.
 */

/** A full, lowercase object name. Anything else is never passed to git. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The branch names this module will pass to git or print as a command: a
 * conservative literal on top of `git check-ref-format --branch`, which alone
 * would accept (and expand) `@{-1}` and friends.
 */
const BRANCH_LITERAL = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Remote names as `git remote` lists them; never one that reads as an option. */
const REMOTE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** Whether `value` is a remote name this module would pass to git. */
export function isRemoteName(value: string): boolean {
	return REMOTE_NAME.test(value);
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

/**
 * The credential-free HTTPS form of a repository URL — scheme, host and path
 * only — or `null` when it is not one. The one thing `cloneInto` will take:
 * no other transport, and no userinfo, port, query or fragment to carry a
 * secret or a surprise into a process that talks to a remote.
 */
export function cloneableUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return null;
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.port !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.pathname.length <= 1
	) {
		return null;
	}
	return `${parsed.origin}${parsed.pathname}`;
}
