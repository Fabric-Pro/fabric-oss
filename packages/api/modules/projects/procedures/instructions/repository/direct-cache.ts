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
import { TtlCache } from "../../../../../lib/ttl-cache";
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

/**
 * A `TtlCache` whose every key starts with the source's repository identity,
 * so no answer can be read through another repository's source.
 */
export class SourceScopedCache<V> {
	constructor(private readonly cache: TtlCache<V>) {}

	private key(
		source: DirectRepositorySource,
		parts: readonly (string | number)[],
	): string {
		return [identity(source), ...parts].join("\0");
	}

	get(
		source: DirectRepositorySource,
		parts: readonly (string | number)[],
	): V | undefined {
		return this.cache.get(this.key(source, parts));
	}

	set(
		source: DirectRepositorySource,
		parts: readonly (string | number)[],
		value: V,
	): void {
		this.cache.set(this.key(source, parts), value);
	}

	clear(): void {
		this.cache.clear();
	}
}

/** Parts: the branch ref and the commit. */
export const directBranchMembershipCache = new SourceScopedCache<true>(
	new TtlCache({ ttlMs: BRANCH_MEMBERSHIP_TTL_MS, maxEntries: 1_000 }),
);

/** Parts: the commit. */
export const directTreeCache = new SourceScopedCache<TreeAnswer>(
	new TtlCache({
		ttlMs: IMMUTABLE_TTL_MS,
		maxEntries: 20,
		weigh: (answer) => answer.entries.length + 1,
		maxWeight: MAX_CACHED_TREE_ENTRIES,
	}),
);

/** Parts: the commit, the byte limit and the path. */
export const directFileCache = new SourceScopedCache<FileAnswer>(
	new TtlCache({
		ttlMs: IMMUTABLE_TTL_MS,
		maxEntries: 500,
		weigh: (answer) =>
			(answer.state === "found" ? answer.bytes.length : 0) + 1,
		maxWeight: MAX_CACHED_FILE_BYTES,
	}),
);

/** Parts: the commit. */
export const directParentCache = new SourceScopedCache<string | null>(
	new TtlCache({ ttlMs: IMMUTABLE_TTL_MS, maxEntries: 2_000 }),
);

export function resetDirectRepositoryCaches(): void {
	directBranchMembershipCache.clear();
	directTreeCache.clear();
	directFileCache.clear();
	directParentCache.clear();
}
