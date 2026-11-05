"use client";

import { Badge } from "@ui/components/badge";
import { useTranslations } from "next-intl";

/**
 * A pending upload-mode proposal's approvals against the project's review
 * policy. Absent on the default policy (one approval publishes), where
 * "0 of 1" would say nothing the Approve button does not.
 */
export type ProposalApprovals = { count: number; required: number };

function needsSeveralApprovals(
	approvals: ProposalApprovals | undefined,
): approvals is ProposalApprovals {
	return approvals !== undefined && approvals.required > 1;
}

/**
 * What the Approve button offers the viewer. A viewer who already approved
 * cannot add a second approval, so it reads "You approved" and is disabled,
 * except once the counted approvals meet the requirement (the policy was
 * lowered under the proposal): the server publishes on a repeated approval,
 * so it is the plain Approve again rather than a dead end for every approver.
 */
export function approveButtonState(
	approvals: ProposalApprovals | undefined,
	viewerApproved: boolean,
): "approve" | "approveCounted" | "youApproved" {
	if (
		!needsSeveralApprovals(approvals) ||
		approvals.count >= approvals.required
	) {
		return "approve";
	}
	return viewerApproved ? "youApproved" : "approveCounted";
}

export function ProposalApprovalBadge({
	approvals,
}: {
	approvals: ProposalApprovals | undefined;
}) {
	const t = useTranslations("projects.codingInstructions.proposalReview");
	if (!needsSeveralApprovals(approvals)) {
		return null;
	}
	return (
		<Badge variant="outline" data-testid="proposal-approval-progress">
			{t("approvalProgress", {
				count: approvals.count,
				required: approvals.required,
			})}
		</Badge>
	);
}
