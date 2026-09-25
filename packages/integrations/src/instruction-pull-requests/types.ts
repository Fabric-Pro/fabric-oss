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
 * A sanitized provider failure. The message is fixed per code, and nothing
 * the provider or the transport said is kept, so logging, serialising or
 * inspecting it cannot print a token, a URL or a response body.
 */
export class InstructionPullRequestError extends Error {
	readonly code: InstructionPullRequestFailureCode;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;
	/** Why, in the adapter's vocabulary. Deliberately not the underlying error. */
	override readonly cause: Cause;
	/** The provider refused `open` because a pull request for this branch exists (plan Decision 6). */
	readonly duplicate?: true;

	constructor(input: {
		code: InstructionPullRequestFailureCode;
		retryable: boolean;
		cause: Cause;
		retryAfterSeconds?: number;
		duplicate?: true;
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
}
