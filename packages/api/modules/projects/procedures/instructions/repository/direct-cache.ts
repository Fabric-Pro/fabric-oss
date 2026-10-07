/**
 * Answers about a pinned commit that a direct repository read would otherwise
 * ask the provider for again on every view.
 *
 * A commit's tree and file bytes cannot change, so they are kept for a few
 * minutes; "this commit is on the configured branch" is kept for one minute,
 * since a force-push can end it. Only successes are kept: a failure, a
 * negative branch answer and a missing file are asked again.
 *
 * Every key starts with the repository identity of the source the caller was
 * already authorized for (organization, integration and repository address),
 * so one project's answer is never another's, and a cache hit is only ever
 * consulted after `loadDirectRepositorySource` has passed the caller's
 * visibility and permission checks. Per process; a miss is only a provider
 * request.
 */
import type {
	ListRepositoryTreeResult,
	readRepositoryFileAtCommit,
} from "@repo/connectors";
import { TtlCache } from "../repository-sync/ttl-cache";
import type { DirectRepositorySource } from "./direct-source";

const IMMUTABLE_TTL_MS = 5 * 60_000;
const BRANCH_MEMBERSHIP_TTL_MS = 60_000;

/** Entries held across all cached trees; one tree is at most 20,000. */
const MAX_CACHED_TREE_ENTRIES = 60_000;
const MAX_CACHED_FILE_BYTES = 8 * 1024 * 1024;

type TreeAnswer = Extract<ListRepositoryTreeResult, { ok: true }>;
type FileAnswer = Extract<
	Awaited<ReturnType<typeof readRepositoryFileAtCommit>>,
	{ ok: true }
>;

const onBranch = new TtlCache<true>({
	ttlMs: BRANCH_MEMBERSHIP_TTL_MS,
	maxEntries: 1_000,
});
const trees = new TtlCache<TreeAnswer>({
	ttlMs: IMMUTABLE_TTL_MS,
	maxEntries: 20,
	weigh: (answer) => answer.entries.length + 1,
	maxWeight: MAX_CACHED_TREE_ENTRIES,
});
const files = new TtlCache<FileAnswer>({
	ttlMs: IMMUTABLE_TTL_MS,
	maxEntries: 500,
	weigh: (answer) => (answer.state === "found" ? answer.bytes.length : 0) + 1,
	maxWeight: MAX_CACHED_FILE_BYTES,
});
const parents = new TtlCache<string | null>({
	ttlMs: IMMUTABLE_TTL_MS,
	maxEntries: 2_000,
});

export function resetDirectRepositoryCaches(): void {
	onBranch.clear();
	trees.clear();
	files.clear();
	parents.clear();
}

/** What makes two sources the same repository for the purpose of sharing an answer. */
function identity(source: DirectRepositorySource): string {
	const { repository } = source;
	return [
		source.organizationId,
		source.integrationId,
		repository.provider,
		repository.repositoryUrl,
		repository.owner,
		repository.repo,
		repository.azureOrganization ?? "",
	].join("\0");
}

export const directBranchMembershipCache = {
	has(source: DirectRepositorySource, sha: string): boolean {
		return (
			onBranch.get(`${identity(source)}\0${source.ref}\0${sha}`) === true
		);
	},
	remember(source: DirectRepositorySource, sha: string): void {
		onBranch.set(`${identity(source)}\0${source.ref}\0${sha}`, true);
	},
};

export const directTreeCache = {
	get(source: DirectRepositorySource, sha: string): TreeAnswer | undefined {
		return trees.get(`${identity(source)}\0${sha}`);
	},
	set(source: DirectRepositorySource, sha: string, answer: TreeAnswer): void {
		trees.set(`${identity(source)}\0${sha}`, answer);
	},
};

export const directFileCache = {
	get(
		source: DirectRepositorySource,
		sha: string,
		path: string,
		maxBytes: number,
	): FileAnswer | undefined {
		return files.get(`${identity(source)}\0${sha}\0${maxBytes}\0${path}`);
	},
	set(
		source: DirectRepositorySource,
		sha: string,
		path: string,
		maxBytes: number,
		answer: FileAnswer,
	): void {
		files.set(`${identity(source)}\0${sha}\0${maxBytes}\0${path}`, answer);
	},
};

export const directParentCache = {
	get(
		source: DirectRepositorySource,
		sha: string,
	): string | null | undefined {
		return parents.get(`${identity(source)}\0${sha}`);
	},
	set(source: DirectRepositorySource, sha: string, parent: string | null) {
		parents.set(`${identity(source)}\0${sha}`, parent);
	},
};
