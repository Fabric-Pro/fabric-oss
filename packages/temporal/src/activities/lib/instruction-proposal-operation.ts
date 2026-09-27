/**
 * What the proposal activities share (Fizzy #2563 spec §6, §11): reading a
 * row's attempt records, turning a provider or git failure into its typed
 * code, and the `pull_request_reconciled` audit row. The member proposal
 * branch steps call `providerCall` and `gitCall` too.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import type {
	ProposalOperationRow,
	PullRequestAttemptRecord,
	PullRequestPhase,
	RecordAuditInput,
} from "@repo/database";
import { InstructionPullRequestError } from "@repo/integrations/instruction-pull-requests";
import {
	assertMayContinue,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import { isCredentialFailure } from "./instruction-proposal-credential";
import { classifyGitFailure, GitCommandError } from "./instruction-sync-git";

/** What a step call needs of its credential: the attempt's signal. */
type StepSignal = { signal: AbortSignal };

/** A row's attempt records (spec §4.1); none when the column holds none. */
export function recordsOf(
	row: Pick<ProposalOperationRow, "pullRequestAttempts">,
): PullRequestAttemptRecord[] {
	return Array.isArray(row.pullRequestAttempts)
		? (row.pullRequestAttempts as unknown as PullRequestAttemptRecord[])
		: [];
}

/**
 * A provider failure as its typed code. An authentication failure is
 * rethrown as it is, for the credential helper's one re-exchange;
 * anything thrown after cancellation is rethrown for the boundary.
 */
function providerFailure(
	error: unknown,
	phase: PullRequestPhase,
	signal: AbortSignal,
): unknown {
	if (signal.aborted || isCredentialFailure(error)) {
		return error;
	}
	if (error instanceof InstructionPullRequestError) {
		return new ProposalStepFailure({
			code: error.code,
			phase,
			retryable: error.retryable,
			retryAfterSeconds: error.retryAfterSeconds,
		});
	}
	return error;
}

/**
 * One provider call under the attempt's signal. Nothing starts once the
 * attempt is cancelled or past its deadline; one in flight is aborted
 * through `target.signal`.
 */
export async function providerCall<T>(
	phase: PullRequestPhase,
	credential: StepSignal,
	call: () => Promise<T>,
): Promise<T> {
	assertMayContinue(credential.signal);
	try {
		return await call();
	} catch (error) {
		throw providerFailure(error, phase, credential.signal);
	}
}

/**
 * A git failure as its typed code (spec §7 step 1, §11). Authentication and
 * cancellation are rethrown as they are; so is anything that is not a git
 * failure, which the boundary reports as `UNEXPECTED`.
 */
function gitFailure(
	error: unknown,
	phase: PullRequestPhase,
	signal: AbortSignal,
): unknown {
	if (
		signal.aborted ||
		isCredentialFailure(error) ||
		!(error instanceof GitCommandError)
	) {
		return error;
	}
	if (error.kind === "disk_limit") {
		return new ProposalStepFailure({
			code: "LIMITS_EXCEEDED",
			phase,
			retryable: phase === "recover" || phase === "close",
		});
	}
	if (error.kind === "exit") {
		const kind = classifyGitFailure(error.stderrTail);
		if (phase === "prepare" && kind === "ref_missing") {
			return new ProposalStepFailure({
				code: "TARGET_BRANCH_MISSING",
				phase,
				retryable: false,
			});
		}
		if (phase === "prepare" && kind === "commit_missing") {
			return new ProposalStepFailure({
				code: "BASE_COMMIT_UNAVAILABLE",
				phase,
				retryable: false,
			});
		}
		if (kind === "repo_not_found") {
			return new ProposalStepFailure({
				code: "REPOSITORY_UNAVAILABLE",
				phase,
				retryable: true,
			});
		}
	}
	return new ProposalStepFailure({
		code: "GIT_FAILED",
		phase,
		retryable: true,
	});
}

/** One git call under the attempt's signal; as `providerCall`. */
export async function gitCall<T>(
	phase: PullRequestPhase,
	credential: StepSignal,
	call: () => Promise<T>,
): Promise<T> {
	assertMayContinue(credential.signal);
	try {
		return await call();
	} catch (error) {
		throw gitFailure(error, phase, credential.signal);
	}
}

function resourceOf(row: Pick<ProposalOperationRow, "id" | "version">) {
	return {
		type: "project_instruction_snapshot",
		id: row.id,
		name: `v${row.version}`,
	};
}

type AuditRow = Pick<
	ProposalOperationRow,
	"id" | "version" | "organizationId" | "projectId" | "userId"
> & { pullRequestOperationId: string | null };

/** `pull_request_reconciled` (spec §13.4): the system observed a terminal outcome. */
export function reconciledAudit(
	row: AuditRow,
	outcome: "merged" | "closed" | "canceled",
	targetMismatch: boolean,
	code?: string,
): RecordAuditInput {
	return {
		action: "project.instructions.pull_request_reconciled",
		category: "project",
		actor: { type: "system" },
		organizationId: row.organizationId,
		projectId: row.projectId,
		resource: resourceOf(row),
		metadata: {
			outcome,
			operationId: row.pullRequestOperationId,
			...(code === undefined ? {} : { code }),
			targetMismatch,
		},
	};
}
