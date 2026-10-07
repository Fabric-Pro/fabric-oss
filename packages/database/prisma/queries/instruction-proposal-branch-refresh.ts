import { db } from "../client";

/** One person may ask for a fresh provider observation of an open branch per minute. */
export const PROPOSAL_BRANCH_REFRESH_COOLDOWN_SECONDS = 60;

export type ProposalBranchRefreshResult =
	| { admitted: true; attempt: number }
	| {
			admitted: false;
			reason: "cooldown" | "provider_rate_limited";
			retryAfterSeconds: number;
	  };

/**
 * Atomically admit one explicit observation of an OPEN pull request.
 *
 * This does not move the branch or clear its provider backoff. The dedicated
 * refresh workflow performs the same fenced reconciliation as the passive
 * sweeper; the admission only coalesces repeated clicks before it starts.
 */
export async function requestProposalBranchRefresh(i: {
	branchId: string;
	projectId: string;
	organizationId: string;
	expectedAttempt: number;
}): Promise<ProposalBranchRefreshResult | null> {
	const cooldown = PROPOSAL_BRANCH_REFRESH_COOLDOWN_SECONDS;
	const admitted = await db.$queryRaw<Array<{ attempt: number }>>`
		UPDATE "project_instruction_proposal_branch"
		SET "refreshAdmittedAt" = (now() AT TIME ZONE 'UTC')
		WHERE "id" = ${i.branchId}
			AND "projectId" = ${i.projectId}
			AND "organizationId" = ${i.organizationId}
			AND "attempt" = ${i.expectedAttempt}
			AND "state" = 'OPEN'
			AND NOT "untracked"
			AND "pullRequestExternalId" IS NOT NULL
			AND ("refreshAdmittedAt" IS NULL
				OR "refreshAdmittedAt" <= (now() AT TIME ZONE 'UTC') - make_interval(secs => ${cooldown}::int))
			AND NOT COALESCE(
				("failure"->>'code') = 'PROVIDER_RATE_LIMITED'
					AND "nextAttemptAt" > (now() AT TIME ZONE 'UTC'),
				false)
		RETURNING "attempt"
	`;
	if (admitted[0]) {
		return { admitted: true, attempt: Number(admitted[0].attempt) };
	}
	const refused = await db.$queryRaw<
		Array<{
			rateLimited: boolean | null;
			backoffSeconds: number | null;
			cooldownSeconds: number | null;
		}>
	>`
		SELECT
			(("failure"->>'code') = 'PROVIDER_RATE_LIMITED'
				AND "nextAttemptAt" > (now() AT TIME ZONE 'UTC')) AS "rateLimited",
			CEIL(EXTRACT(EPOCH FROM ("nextAttemptAt" - (now() AT TIME ZONE 'UTC'))))::int AS "backoffSeconds",
			CEIL(EXTRACT(EPOCH FROM (
				"refreshAdmittedAt" + make_interval(secs => ${cooldown}::int)
					- (now() AT TIME ZONE 'UTC'))))::int AS "cooldownSeconds"
		FROM "project_instruction_proposal_branch"
		WHERE "id" = ${i.branchId}
			AND "projectId" = ${i.projectId}
			AND "organizationId" = ${i.organizationId}
			AND "attempt" = ${i.expectedAttempt}
			AND "state" = 'OPEN'
			AND NOT "untracked"
			AND "pullRequestExternalId" IS NOT NULL
	`;
	const why = refused[0];
	if (!why) {
		return null;
	}
	const cooling = Math.min(cooldown, Math.max(0, why.cooldownSeconds ?? 0));
	if (why.rateLimited === true) {
		return {
			admitted: false,
			reason: "provider_rate_limited",
			retryAfterSeconds: Math.max(1, why.backoffSeconds ?? 1, cooling),
		};
	}
	return {
		admitted: false,
		reason: "cooldown",
		retryAfterSeconds: Math.max(1, cooling),
	};
}
