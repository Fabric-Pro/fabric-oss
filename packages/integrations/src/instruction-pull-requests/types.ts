/**
 * The provider adapter contract for Coding Instructions proposal pull
 * requests (Fizzy #2563 spec §10). One adapter per provider, each with its own
 * transport; the existing GitHub and GitLab tool handlers are not used or
 * changed (plan R6).
 *
 * SECURITY (spec §13.1): the token reaches an adapter only as an argument and
 * a request header. No error built here carries a URL, a header, a response
 * body or the underlying exception: `InstructionPullRequestError` has a fixed
 * message, a code, a cause and a retry hint, nothing else.
 */
import type { InstructionPullRequestFailureCode } from "@repo/database";

/** The frozen repository identity (`PullRequestContext["repository"]` in `@repo/instructions`). */
export type RepositoryIdentity =
	| { provider: "GITHUB"; owner: string; repo: string }
	/** Subgroups kept: `group/subgroup/project`. */
	| { provider: "GITLAB"; projectPath: string }
	| {
			provider: "AZURE_DEVOPS";
			/** `https://dev.azure.com` or `https://<org>.visualstudio.com`. */
			apiOrigin: string;
			organization: string;
			project: string;
			repository: string;
	  };

export type RepositoryProviderName = RepositoryIdentity["provider"];

export type Target = {
	auth: { token: string; authMethod: "OAUTH" | "PAT" };
	repository: RepositoryIdentity;
	/** The activity's cancellation; every request also carries its own timeout. */
	signal: AbortSignal;
};

export type Cause =
	| "auth"
	| "permission"
	| "rate_limit"
	| "not_found"
	| "conflict"
	| "transient"
	| "unknown";

/**
 * A sanitized provider failure. The message is fixed per code. Of what the
 * provider said, only a refused `open` keeps anything: the status, the
 * provider's own error message parsed out of its JSON body (scrubbed of the
 * token and credential-shaped text, one line, about 300 characters), and
 * GitHub's `X-Accepted-GitHub-Permissions` header. Never the raw body, a
 * response or request header beyond that one, a URL or the transport error, so
 * logging, serialising or inspecting it cannot print a token.
 */
export class InstructionPullRequestError extends Error {
	readonly code: InstructionPullRequestFailureCode;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;
	/** Why, in the adapter's vocabulary. Deliberately not the underlying error. */
	override readonly cause: Cause;
	/** The provider refused `open` because a pull request for this branch exists (plan Decision 6). */
	readonly duplicate?: true;
	/** A refused `open` only: the HTTP status the provider answered with. */
	readonly providerStatus?: number;
	/** A refused `open` only: the provider's own error message, sanitized (see the class comment). */
	readonly providerMessage?: string;
	/** A refused GitHub `open` (403/404): the permissions the endpoint accepts, e.g. `pull_requests=write`. */
	readonly requiredPermissions?: string;

	constructor(input: {
		code: InstructionPullRequestFailureCode;
		retryable: boolean;
		cause: Cause;
		retryAfterSeconds?: number;
		duplicate?: true;
		providerStatus?: number;
		providerMessage?: string;
		requiredPermissions?: string;
	}) {
		super(`Pull request provider call failed (${input.code})`);
		this.name = "InstructionPullRequestError";
		this.code = input.code;
		this.retryable = input.retryable;
		this.cause = input.cause;
		if (input.retryAfterSeconds !== undefined) {
			this.retryAfterSeconds = input.retryAfterSeconds;
		}
		if (input.duplicate) {
			this.duplicate = true;
		}
		if (input.providerStatus !== undefined) {
			this.providerStatus = input.providerStatus;
		}
		if (input.providerMessage !== undefined) {
			this.providerMessage = input.providerMessage;
		}
		if (input.requiredPermissions !== undefined) {
			this.requiredPermissions = input.requiredPermissions;
		}
	}
}

export type PullRequestObservation = {
	/** GitHub number, GitLab iid, Azure DevOps pullRequestId. */
	externalId: string;
	/** The pull request's web page. */
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	/** Branch names, without `refs/heads/`. */
	sourceRef: string;
	targetRef: string;
	sourceRepository: RepositoryIdentity;
	headSha: string;
	mergedAt?: string;
	closedAt?: string;
	mergeCommitSha?: string;
};

export type FindOperationResult =
	| { kind: "FOUND"; value: PullRequestObservation }
	| { kind: "ABSENT" }
	| { kind: "INCONCLUSIVE"; cause: Cause; retryAfterSeconds?: number };

/**
 * Why a provider refused to merge, in the adapter's vocabulary. Nothing the
 * provider said is kept except `acceptedPermissions`, GitHub's
 * `X-Accepted-GitHub-Permissions` header (permission names, never a secret).
 */
export type MergeRefusalReason =
	/** Checks, reviews, conflicts, or a merge method the repository forbids. */
	| "not_mergeable"
	/** The source branch moved past the head Fabric expected. */
	| "head_moved"
	/** The credential may not merge here. */
	| "permission"
	| "auth"
	| "not_found"
	| "rate_limit"
	| "transient"
	/** This provider's adapter does not merge pull requests. */
	| "unsupported"
	| "unknown";

export type MergeResult =
	| { kind: "MERGED"; mergeCommitSha?: string }
	| {
			kind: "REFUSED";
			reason: MergeRefusalReason;
			/** GitHub's `X-Accepted-GitHub-Permissions`, e.g. `contents=write; pull_requests=write`. */
			acceptedPermissions?: string;
			retryAfterSeconds?: number;
	  };

export interface InstructionPullRequestAdapter {
	/**
	 * Every pull request whose source is `sourceRef` in the frozen repository,
	 * across all targets and states, paged to the last page. Exactly one
	 * candidate is FOUND; none is ABSENT; several, more than 10 pages or any
	 * failure is INCONCLUSIVE. A fork's pull request on the same branch name is
	 * never a candidate. The caller compares `targetRef` with the frozen one.
	 */
	findOperation(
		i: Target & { sourceRef: string },
	): Promise<FindOperationResult>;
	/** Called once, never retried here: a lost response is the caller's reconciliation. */
	open(
		i: Target & {
			sourceRef: string;
			targetRef: string;
			title: string;
			body: string;
		},
	): Promise<PullRequestObservation>;
	get(i: Target & { externalId: string }): Promise<PullRequestObservation>;
	close(i: Target & { externalId: string }): Promise<PullRequestObservation>;
	/**
	 * Merges the pull request only while its source head is still
	 * `expectedHeadSha`. Called once, never retried here. A provider refusal
	 * is a REFUSED result, not an error; only cancellation throws.
	 */
	merge(
		i: Target & {
			externalId: string;
			expectedHeadSha: string;
			method: "merge" | "squash";
			/** The merge commit's title; the provider's default when omitted. */
			commitTitle?: string;
		},
	): Promise<MergeResult>;
	/**
	 * The provider ref that carries the pull request's source head commit,
	 * fetchable from the source repository (spec §7 "Adapters"). `null` when
	 * the provider has no such ref (Azure DevOps: its build ref is a merge
	 * ref, not a source head) or when `externalId` is not a positive decimal
	 * integer — never interpolated into a ref in that case.
	 */
	pullRequestHeadRef(externalId: string): string | null;
}
