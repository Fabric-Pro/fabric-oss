/**
 * The review policy for upload-mode Coding Instructions proposals, and the
 * per-reviewer approval rows it counts.
 *
 * The policy lives on `Project.instructionSettings.reviewPolicy` and is read
 * from the project row the review transaction has locked, every time an
 * approval lands, so a policy change applies to the next approval of every
 * open proposal rather than being frozen when the proposal was opened.
 *
 * The default (`requiredApprovals: 1`, no approver list) is today's
 * behaviour exactly: the first approval publishes, and a proposer who may
 * review may approve their own proposal. Above one, the proposer's own
 * approval never counts and is refused, so an approver list must name at
 * least one more member than the approvals it requires: otherwise a listed
 * approver's own proposal could never collect enough.
 *
 * An approval counts only while its approver still holds the publish
 * permission (`INSTRUCTION_UPDATE`), checked when it is counted: someone who
 * left the project, or lost the role, no longer moves a proposal toward
 * publishing, and the "2 of 3" a proposal shows agrees with the count the
 * approval transaction uses.
 *
 * A repository-mode project ignores the policy: its proposals are pull
 * requests, decided by the provider's own review rules.
 */
import { db, type Prisma } from "../client";
import { canUpdateProjectInstructions } from "./projects/projects";

export const MAX_REQUIRED_INSTRUCTION_APPROVALS = 10;
export const MAX_INSTRUCTION_APPROVERS = 50;

export type InstructionReviewPolicy = {
	requiredApprovals: number;
	/** When set, only these members' approvals are accepted and counted. */
	approverUserIds: string[] | null;
};

export const DEFAULT_INSTRUCTION_REVIEW_POLICY: InstructionReviewPolicy = {
	requiredApprovals: 1,
	approverUserIds: null,
};

/**
 * The stored policy, read leniently: anything malformed falls back to the
 * default field by field, so a bad value can never block a review that
 * today's behaviour would allow.
 */
export function reviewPolicyOfSettings(
	settings: unknown,
): InstructionReviewPolicy {
	if (settings === null || typeof settings !== "object") {
		return DEFAULT_INSTRUCTION_REVIEW_POLICY;
	}
	const stored = (settings as { reviewPolicy?: unknown }).reviewPolicy;
	if (stored === null || typeof stored !== "object") {
		return DEFAULT_INSTRUCTION_REVIEW_POLICY;
	}
	const { requiredApprovals, approverUserIds } = stored as {
		requiredApprovals?: unknown;
		approverUserIds?: unknown;
	};
	const required =
		typeof requiredApprovals === "number" &&
		Number.isInteger(requiredApprovals) &&
		requiredApprovals >= 1 &&
		requiredApprovals <= MAX_REQUIRED_INSTRUCTION_APPROVALS
			? requiredApprovals
			: DEFAULT_INSTRUCTION_REVIEW_POLICY.requiredApprovals;
	const approvers =
		Array.isArray(approverUserIds) &&
		approverUserIds.length > 0 &&
		approverUserIds.every(
			(id: unknown): id is string => typeof id === "string" && id !== "",
		)
			? [...new Set(approverUserIds)]
			: null;
	return { requiredApprovals: required, approverUserIds: approvers };
}

/** Why a reviewer's approval is refused before it is recorded, or null. */
export function approvalRefusal(input: {
	policy: InstructionReviewPolicy;
	reviewerUserId: string;
	proposerUserId: string;
}): "not_an_approver" | "own_proposal" | null {
	if (
		input.policy.approverUserIds !== null &&
		!input.policy.approverUserIds.includes(input.reviewerUserId)
	) {
		return "not_an_approver";
	}
	if (
		input.policy.requiredApprovals > 1 &&
		input.reviewerUserId === input.proposerUserId
	) {
		return "own_proposal";
	}
	return null;
}

/**
 * The fewest approvers a list may name for `requiredApprovals`: one more
 * than required above one, because a listed approver cannot approve their
 * own proposal and the rest must still be enough.
 */
export function minimumInstructionApprovers(requiredApprovals: number): number {
	return requiredApprovals > 1 ? requiredApprovals + 1 : requiredApprovals;
}

/**
 * How many of a proposal's approvals count toward the policy: only those of
 * approvers in `permittedUserIds` (who still hold the publish permission),
 * the listed approvers' only when a list is set, and never the proposer's
 * own above one required approval.
 */
export function countedApprovals(input: {
	approverUserIds: readonly string[];
	permittedUserIds: ReadonlySet<string>;
	proposerUserId: string;
	policy: InstructionReviewPolicy;
}): number {
	return new Set(
		input.approverUserIds.filter(
			(userId) =>
				input.permittedUserIds.has(userId) &&
				(input.policy.requiredApprovals === 1 ||
					userId !== input.proposerUserId) &&
				(input.policy.approverUserIds === null ||
					input.policy.approverUserIds.includes(userId)),
		),
	).size;
}

/**
 * Of `userIds`, the ones who may publish the project's instructions right
 * now (`INSTRUCTION_UPDATE`, the permission a review requires). Each distinct
 * id is checked once, one after another so `client` may be the review
 * transaction's, which then reads the same moment as the decision.
 */
export async function approversStillPermitted(
	projectId: string,
	userIds: Iterable<string>,
	client: Prisma.TransactionClient = db,
): Promise<Set<string>> {
	const permitted = new Set<string>();
	for (const userId of new Set(userIds)) {
		if (await canUpdateProjectInstructions(projectId, userId, client)) {
			permitted.add(userId);
		}
	}
	return permitted;
}

type ApprovalScope = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
};

/**
 * Records one reviewer's approval. Idempotent through the
 * `(snapshotId, userId)` unique: true only when this call wrote the row.
 */
export async function recordProposalApprovalTx(
	tx: Prisma.TransactionClient,
	input: ApprovalScope & { userId: string },
): Promise<boolean> {
	const { count } = await tx.projectInstructionProposalApproval.createMany({
		data: [
			{
				snapshotId: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
			},
		],
		skipDuplicates: true,
	});
	return count === 1;
}

/** Who has approved one proposal, oldest first. */
export async function listProposalApproverIds(
	input: ApprovalScope,
	client: Prisma.TransactionClient = db,
): Promise<string[]> {
	const rows = await client.projectInstructionProposalApproval.findMany({
		where: {
			snapshotId: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
		},
		orderBy: { createdAt: "asc" },
		select: { userId: true },
	});
	return rows.map((row) => row.userId);
}

export type ProposalApprovalProgress = {
	count: number;
	required: number;
	/** Everyone who approved, counted or not, so a caller can say "you approved". */
	approverUserIds: string[];
};

/**
 * The approval progress a proposal row shows ("2 of 3"). `permittedUserIds`
 * is `approversStillPermitted` over its approvers, so the count matches the
 * one an approval would act on; `approverUserIds` stays everyone who
 * approved.
 */
export function approvalProgressOf(input: {
	approverUserIds: readonly string[];
	permittedUserIds: ReadonlySet<string>;
	proposerUserId: string;
	settings: unknown;
}): ProposalApprovalProgress {
	const policy = reviewPolicyOfSettings(input.settings);
	return {
		count: countedApprovals({
			approverUserIds: input.approverUserIds,
			permittedUserIds: input.permittedUserIds,
			proposerUserId: input.proposerUserId,
			policy,
		}),
		required: policy.requiredApprovals,
		approverUserIds: [...input.approverUserIds],
	};
}
