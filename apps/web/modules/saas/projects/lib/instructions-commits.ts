/**
 * The Commits view of a repository-backed project (Fizzy #2878 §10): the synced
 * branch's own history, with Fabric's view of each commit laid over it, as pure
 * functions the dialog and its tests share.
 *
 * A commit row is what `repositorySync.listCommits` answers. Fabric holds a
 * published copy of only the commits a sync took, so most rows say nothing about
 * Fabric at all: that is not "not synced", it is the ordinary state of a commit
 * that was never the tip of a sync. Only a commit NEWER than the published one,
 * which the next sync will take or refuse, is "not synced yet".
 */

/** One row of `listCommits`. */
export type CommitRow = {
	sha: string;
	author: { name: string };
	date: string | Date;
	/** The whole commit message; null when it matched the secret scan and is withheld. */
	message: string | null;
	messageWithheld?: boolean;
	url: string;
	parent: string | null;
	/** The version number of Fabric's READY copy of this commit, or null when it holds none. */
	published: number | null;
	/** A sync evaluated this commit and the secret scan refused its tree. */
	refused: boolean;
	isFabric: boolean;
};

export type CommitBadge = "published" | "refused" | "notSynced";

/**
 * The badge each row carries, in order.
 *
 * `published` is the commit Fabric's copy is of NOW (the published row's
 * `sourceCommitSha`, or failing that the row whose copy is the published
 * version). `refused` is a commit the scan refused. `notSynced` is a commit
 * with neither, above the published one in the list (newer than it), or any
 * commit at all when the published one is not among those loaded (it is older
 * than all of them, or nothing is published yet). A commit below the published
 * one that Fabric holds no copy of was passed over by a sync that took a later
 * tip, and carries no badge.
 */
export function commitBadges(
	rows: ReadonlyArray<CommitRow>,
	published: { sha: string | null; version: number | null },
): Array<CommitBadge | null> {
	const isCurrent = (row: CommitRow) =>
		(published.sha !== null && row.sha === published.sha) ||
		(published.sha === null &&
			published.version !== null &&
			row.published === published.version);
	const currentIndex = rows.findIndex(isCurrent);
	return rows.map((row, index) => {
		if (index === currentIndex) {
			return "published";
		}
		if (row.refused) {
			return "refused";
		}
		if (row.published !== null) {
			return null;
		}
		return currentIndex === -1 || index < currentIndex ? "notSynced" : null;
	});
}

/** A commit's subject: the first line of its message, or null when it is withheld. */
export function rowSubject(row: CommitRow): string | null {
	if (row.messageWithheld === true || row.message === null) {
		return null;
	}
	return row.message.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** How a revert refused, under `projects.codingInstructions.commits.revertFailures`. */
export type RevertFailureKey =
	| "conflict"
	| "protected"
	| "busy"
	| "queued"
	| "rejected"
	| "tooLarge"
	| "empty"
	| "unsupported"
	| "notFound";

const REVERT_FAILURE_BY_CODE: ReadonlyMap<string, RevertFailureKey> = new Map<
	string,
	RevertFailureKey
>([
	["REVERT_CONFLICT", "conflict"],
	["BRANCH_PROTECTED", "protected"],
	["BRANCH_BUSY", "busy"],
	["REVERT_BUSY", "queued"],
	["REVERT_REJECTED", "rejected"],
	["REVERT_TOO_LARGE", "tooLarge"],
	["REVERT_EMPTY", "empty"],
	["REVERT_UNSUPPORTED", "unsupported"],
	["COMMIT_NOT_FOUND", "notFound"],
]);

/**
 * The refusal a revert carries in `data.code`, or null when it is not one of
 * those (the shared error map then words it, Read-only mode included). The
 * server's own text is never used: it is not translated.
 */
export function revertFailureKey(error: unknown): RevertFailureKey | null {
	if (!error || typeof error !== "object" || !("data" in error)) {
		return null;
	}
	const data = (error as { data?: unknown }).data;
	if (!data || typeof data !== "object" || !("code" in data)) {
		return null;
	}
	const code = (data as { code?: unknown }).code;
	return typeof code === "string"
		? (REVERT_FAILURE_BY_CODE.get(code) ?? null)
		: null;
}

/** The provider's name as a person says it. */
export function providerName(provider: string): string | null {
	switch (provider) {
		case "GITHUB":
			return "GitHub";
		case "GITLAB":
			return "GitLab";
		case "AZURE_DEVOPS":
			return "Azure DevOps";
		default:
			return null;
	}
}
