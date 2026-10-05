import {
	AZURE_DEVOPS_API_VERSION,
	getRepositoryJson,
	isRecord,
	type RepositoryApiInput,
	type RepositoryApiTarget,
	type RepositoryFailure,
	repositoryApiTarget,
	stringField,
} from "./repository-api";
import { verifyRepositoryBranch } from "./repository-branch";

/**
 * A branch's commit history within a folder (request-path helper; Fizzy #2878
 * §10), through the PROJECT integration's stored credential (decrypted by the
 * caller; this module never touches the DB): the History tab of a
 * repository-backed project.
 *
 * One page of the branch's commits, newest first, limited to the commits that
 * touched `path` (the sync's folder; "" is the whole repository), from the
 * provider's own commits API: the sync's clone is ephemeral and shallow, so
 * it holds no history. The three providers page differently — GitHub and
 * GitLab by page number, Azure DevOps by `$skip` — and `page` (1-based) hides
 * that. A full page may be the last one, so `hasMore` only says that the next
 * page is worth asking for.
 *
 * Closed failure set, as the sibling helpers have it: `not-found` (the branch
 * or repository is gone), `unauthorized` (the stored credential was
 * rejected), `unreachable` (anything else — never an empty history). The
 * helper never throws.
 *
 * What is returned is metadata only: the commit message is capped, and no
 * file content or diff is ever read here.
 */

export const COMMITS_PAGE_SIZE = 30;

/** The longest commit message returned; a longer one is cut. */
export const COMMIT_MESSAGE_MAX_CHARS = 2000;

export type RepositoryCommit = {
	sha: string;
	authorName: string;
	committerName: string;
	/** ISO 8601 UTC, the commit's own committer date. */
	date: string;
	message: string;
	/** The provider's web page for the commit. */
	url: string;
	/** The first parent, or null for a root commit. */
	parent: string | null;
};

export type ListRepositoryCommitsInput = RepositoryApiInput & {
	branch: string;
	/** The folder, in the sync's plain spelling: no leading or trailing `/`; "" for the root. */
	path: string;
	/** 1-based. */
	page: number;
};

export type ListRepositoryCommitsResult =
	| { ok: true; commits: RepositoryCommit[]; hasMore: boolean }
	/**
	 * `missing-path`: the branch exists but `path` is not on it any more.
	 * Azure DevOps answers a history filtered by a folder that is gone with a
	 * 404 (TF401174), where GitHub lists the folder's past commits.
	 */
	| { ok: false; outcome: RepositoryFailure | "missing-path" };

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function objectId(value: unknown): string | null {
	return typeof value === "string" && OBJECT_ID.test(value)
		? value.toLowerCase()
		: null;
}

function isoDate(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function cappedMessage(message: string | null): string {
	return (message ?? "").slice(0, COMMIT_MESSAGE_MAX_CHARS);
}

function firstParent(value: unknown): string | null {
	if (!Array.isArray(value) || value.length === 0) {
		return null;
	}
	const first = value[0];
	return objectId(isRecord(first) ? first.sha : first);
}

function gitHubCommit(
	target: RepositoryApiTarget,
	raw: unknown,
): RepositoryCommit | null {
	if (!isRecord(raw) || !isRecord(raw.commit)) {
		return null;
	}
	const sha = objectId(raw.sha);
	const author = isRecord(raw.commit.author) ? raw.commit.author : {};
	const committer = isRecord(raw.commit.committer)
		? raw.commit.committer
		: {};
	const date = isoDate(committer.date ?? author.date);
	if (sha === null || date === null) {
		return null;
	}
	return {
		sha,
		authorName: stringField(author, "name") ?? "",
		committerName: stringField(committer, "name") ?? "",
		date,
		message: cappedMessage(stringField(raw.commit, "message")),
		url: target.commitUrl(sha),
		parent: firstParent(raw.parents),
	};
}

function gitLabCommit(
	target: RepositoryApiTarget,
	raw: unknown,
): RepositoryCommit | null {
	if (!isRecord(raw)) {
		return null;
	}
	const sha = objectId(raw.id);
	const date = isoDate(raw.committed_date ?? raw.created_at);
	if (sha === null || date === null) {
		return null;
	}
	return {
		sha,
		authorName: stringField(raw, "author_name") ?? "",
		committerName: stringField(raw, "committer_name") ?? "",
		date,
		message: cappedMessage(stringField(raw, "message")),
		url: target.commitUrl(sha),
		parent: firstParent(raw.parent_ids),
	};
}

function azureDevOpsCommit(
	target: RepositoryApiTarget,
	raw: unknown,
): RepositoryCommit | null {
	if (!isRecord(raw)) {
		return null;
	}
	const sha = objectId(raw.commitId);
	const author = isRecord(raw.author) ? raw.author : {};
	const committer = isRecord(raw.committer) ? raw.committer : {};
	const date = isoDate(committer.date ?? author.date);
	if (sha === null || date === null) {
		return null;
	}
	return {
		sha,
		authorName: stringField(author, "name") ?? "",
		committerName: stringField(committer, "name") ?? "",
		date,
		message: cappedMessage(stringField(raw, "comment")),
		url: target.commitUrl(sha),
		parent: firstParent(raw.parents),
	};
}

function query(input: ListRepositoryCommitsInput): string {
	switch (input.provider) {
		case "GITHUB": {
			const params = new URLSearchParams({
				sha: input.branch,
				per_page: String(COMMITS_PAGE_SIZE),
				page: String(input.page),
			});
			if (input.path !== "") {
				params.set("path", input.path);
			}
			return `/commits?${params.toString()}`;
		}
		case "GITLAB": {
			const params = new URLSearchParams({
				ref_name: input.branch,
				per_page: String(COMMITS_PAGE_SIZE),
				page: String(input.page),
			});
			if (input.path !== "") {
				params.set("path", input.path);
			}
			return `/repository/commits?${params.toString()}`;
		}
		case "AZURE_DEVOPS": {
			const params = new URLSearchParams({
				"searchCriteria.itemVersion.version": input.branch,
				"searchCriteria.itemVersion.versionType": "branch",
				"searchCriteria.$top": String(COMMITS_PAGE_SIZE),
				"searchCriteria.$skip": String(
					(input.page - 1) * COMMITS_PAGE_SIZE,
				),
				"api-version": AZURE_DEVOPS_API_VERSION,
			});
			if (input.path !== "") {
				params.set("searchCriteria.itemPath", `/${input.path}`);
			}
			return `/commits?${params.toString()}`;
		}
		default: {
			const unreachable: never = input.provider;
			return unreachable;
		}
	}
}

/**
 * One page of `input.branch`'s history within `input.path`. Never throws.
 * A page that is not the expected shape, or whose entries cannot be read, is
 * `unreachable` rather than a shorter history.
 */
export async function listRepositoryCommits(
	input: ListRepositoryCommitsInput,
): Promise<ListRepositoryCommitsResult> {
	if (!Number.isInteger(input.page) || input.page < 1) {
		return { ok: false, outcome: "unreachable" };
	}
	const target = repositoryApiTarget(input);
	if (target === null) {
		return { ok: false, outcome: "unreachable" };
	}
	const answer = await getRepositoryJson(target, query(input));
	if (!answer.ok) {
		if (
			answer.outcome === "not-found" &&
			input.provider === "AZURE_DEVOPS" &&
			input.path !== "" &&
			(await verifyRepositoryBranch(input)) === "exists"
		) {
			return { ok: false, outcome: "missing-path" };
		}
		return answer;
	}
	const entries = Array.isArray(answer.data)
		? answer.data
		: isRecord(answer.data) && Array.isArray(answer.data.value)
			? answer.data.value
			: null;
	if (entries === null) {
		return { ok: false, outcome: "unreachable" };
	}
	const read =
		input.provider === "GITHUB"
			? gitHubCommit
			: input.provider === "GITLAB"
				? gitLabCommit
				: azureDevOpsCommit;
	const commits: RepositoryCommit[] = [];
	for (const entry of entries) {
		const commit = read(target, entry);
		if (commit === null) {
			return { ok: false, outcome: "unreachable" };
		}
		commits.push(commit);
	}
	return {
		ok: true,
		commits:
			input.provider === "AZURE_DEVOPS"
				? await withAzureDevOpsParents(target, commits)
				: commits,
		hasMore: entries.length >= COMMITS_PAGE_SIZE,
	};
}

/** Parent reads in flight at once: a page is at most `COMMITS_PAGE_SIZE` commits. */
const AZURE_DEVOPS_PARENT_READS = 6;

/**
 * Azure DevOps leaves `parents` out of its commit list (both `GET commits` and
 * `POST commitsbatch`); only `GET commits/{id}` carries them. Without a parent
 * the Commits view cannot offer Revert or Compare, so each commit's first
 * parent is read on its own. A read that fails leaves that commit's `parent`
 * null, which hides those two actions on its row and nothing else.
 */
async function withAzureDevOpsParents(
	target: RepositoryApiTarget,
	commits: RepositoryCommit[],
): Promise<RepositoryCommit[]> {
	const result = [...commits];
	const missing = result.flatMap((commit, index) =>
		commit.parent === null ? [index] : [],
	);
	let next = 0;
	async function readNext(): Promise<void> {
		while (next < missing.length) {
			const index = missing[next++] as number;
			const commit = result[index] as RepositoryCommit;
			const answer = await getRepositoryJson(
				target,
				`/commits/${commit.sha}?api-version=${AZURE_DEVOPS_API_VERSION}`,
			);
			if (answer.ok && isRecord(answer.data)) {
				result[index] = {
					...commit,
					parent: firstParent(answer.data.parents),
				};
			}
		}
	}
	await Promise.all(
		Array.from(
			{ length: Math.min(AZURE_DEVOPS_PARENT_READS, missing.length) },
			readNext,
		),
	);
	return result;
}
