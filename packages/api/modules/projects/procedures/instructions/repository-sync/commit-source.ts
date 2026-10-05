/**
 * The synced branch a project's commit-level reads go through (Fizzy #2878
 * §10): History (`listCommits`), the commit diff (`compareCommits`) and one
 * file at a commit (`readCommitFile`). The three share what they must refuse
 * and what they must spend:
 *
 *  - the project must be repository-backed with a sync row, or the answer is
 *    `NOT_REPOSITORY_SOURCED`: an uploaded project has no branch;
 *  - the integration is the sync's own, loaded bound to the project and ACTIVE
 *    (`loadInstructionSyncIntegration`), with its credential resolved fresh
 *    (`resolveInstructionSyncCredential`) in the hosting organization, never
 *    one from the request;
 *  - a commit is only ever read when it is part of the synced branch's
 *    history (`assertCommitOnBranch`): the provider would compare or read any
 *    commit of the repository, including the head of a member's pull request
 *    branch, whose content is the review gate's to release, not a reader's.
 *    An answer for "on the branch" is immutable short of a force-push, so a
 *    positive one is remembered for a minute, per repository address as well
 *    as integration; a negative one never is. An unknown commit and one on
 *    another branch are both `COMMIT_NOT_FOUND`.
 *
 * Reached only after the procedure's visibility gate and its permission:
 * `INSTRUCTION_READ` for the history list, `INSTRUCTION_CREATE` for the two
 * reads that return repository content (`compareCommits`, `readCommitFile`).
 * No error carries the token.
 */
import { ORPCError } from "@orpc/client";
import { isCommitOnBranch, type RepositoryApiInput } from "@repo/connectors";
import {
	getInstructionRepositorySync,
	getProjectInstructionSettings,
	getPublishedInstructionSnapshot,
} from "@repo/database";
import { requireHostingOrganizationId } from "../hosting-organization";
import {
	loadInstructionSyncIntegration,
	repositoryReadError,
	resolveInstructionSyncCredential,
} from "./repository";
import { TtlCache } from "./ttl-cache";

const NOT_REPOSITORY_SOURCED_ERROR = {
	code: "PRECONDITION_FAILED",
	message:
		"This project's coding instructions are uploaded, not synced from a repository, so there is no branch to read.",
	data: { reason: "NOT_REPOSITORY_SOURCED" },
} as const;

type RefreshFault = Awaited<
	ReturnType<typeof resolveInstructionSyncCredential>
>["refreshFault"];

export type CommitSource = {
	organizationId: string;
	integrationId: string;
	ref: string;
	rootPath: string;
	/** The published snapshot's source commit: what Fabric's copy was made from. */
	publishedCommitSha: string | null;
	/** The published snapshot's frozen ignore settings: what its copy leaves out. */
	settingsFrozen: unknown;
	/** What `@repo/connectors` needs to address the repository, minus the branch. */
	repository: RepositoryApiInput;
	refreshFault: RefreshFault;
};

export async function loadCommitSource(input: {
	projectId: string;
	userId: string;
}): Promise<CommitSource> {
	const organizationId = await requireHostingOrganizationId(
		input.projectId,
		input.userId,
	);
	const [settings, sync, published] = await Promise.all([
		getProjectInstructionSettings(input.projectId, organizationId),
		getInstructionRepositorySync(input.projectId, organizationId),
		getPublishedInstructionSnapshot(input.projectId),
	]);
	if (settings.sourceOfTruth !== "REPOSITORY" || !sync) {
		throw new ORPCError(NOT_REPOSITORY_SOURCED_ERROR.code, {
			message: NOT_REPOSITORY_SOURCED_ERROR.message,
			data: NOT_REPOSITORY_SOURCED_ERROR.data,
		});
	}
	const integration = await loadInstructionSyncIntegration({
		repositoryIntegrationId: sync.repositoryIntegrationId,
		projectId: input.projectId,
	});
	const { token, refreshFault } = await resolveInstructionSyncCredential(
		integration,
		{ userId: input.userId, organizationId },
	);
	return {
		organizationId,
		integrationId: integration.id,
		ref: sync.ref,
		rootPath: sync.rootPath,
		publishedCommitSha:
			published?.organizationId === organizationId
				? (published.sourceCommitSha ?? null)
				: null,
		settingsFrozen:
			published?.organizationId === organizationId
				? published.settingsFrozen
				: null,
		repository: {
			provider: integration.provider,
			token,
			repositoryUrl: integration.repositoryUrl,
			owner: integration.repositoryOwner,
			repo: integration.repositoryName,
			azureOrganization: integration.azureOrganization,
			...(integration.provider === "GITLAB" &&
			integration.authMethod === "PAT"
				? { gitlabAuth: "private-token" as const }
				: {}),
		},
		refreshFault,
	};
}

/**
 * Positive branch-membership answers, kept for a minute: `<integration>\0
 * <repository url>\0<ref>\0<sha>`. The repository address is part of the key
 * because an integration can be re-pointed at another repository without its
 * id changing, and a commit that was on one repository's branch says nothing
 * about the next one's. A minute, not longer: an answer is immutable short of a
 * force-push, but the credential that asked can lose its access and a cached
 * yes outlives that.
 */
const onBranchCache = new TtlCache<true>({
	ttlMs: 60_000,
	maxEntries: 500,
});

export function resetCommitSourceCaches(): void {
	onBranchCache.clear();
}

/** A commit that is not part of the synced branch's history, an unknown one included. */
function commitNotFound(): ORPCError<"NOT_FOUND", { code: string }> {
	return new ORPCError("NOT_FOUND", {
		message: "That commit is not on the synced branch",
		data: { code: "COMMIT_NOT_FOUND" },
	});
}

/**
 * Refuses (404 `COMMIT_NOT_FOUND`) a commit that is not part of the synced
 * branch's history: one that is on another branch and one the repository does
 * not have at all answer alike, because the provider's own 404 for an unknown
 * commit says nothing about the branch. Any other provider failure is the read
 * error the configure dialog already words, never "not on the branch".
 */
export async function assertCommitOnBranch(
	source: CommitSource,
	sha: string,
): Promise<void> {
	const key = [
		source.integrationId,
		source.repository.repositoryUrl,
		source.ref,
		sha,
	].join("\u0000");
	if (onBranchCache.get(key)) {
		return;
	}
	const answer = await isCommitOnBranch({
		...source.repository,
		branch: source.ref,
		sha,
	});
	if (!answer.ok) {
		if (answer.outcome === "not-found") {
			throw commitNotFound();
		}
		throw readError(source, answer.outcome);
	}
	if (!answer.onBranch) {
		throw commitNotFound();
	}
	onBranchCache.set(key, true);
}

export function readError(
	source: Pick<CommitSource, "ref" | "refreshFault"> &
		Partial<Pick<CommitSource, "rootPath">>,
	outcome: "not-found" | "unauthorized" | "unreachable" | "missing-path",
): ORPCError<string, unknown> {
	return repositoryReadError(outcome, {
		ref: source.ref,
		path: source.rootPath,
		refreshFault: source.refreshFault,
		unreachableMessage:
			"Couldn't reach the repository to read its history. Try again.",
	});
}
