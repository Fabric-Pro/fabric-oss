"use client";

import { Badge } from "@ui/components/badge";
import { useTranslations } from "next-intl";

/**
 * A pending upload-mode proposal's approvals against the project's review
 * policy. Absent on the default policy (one approval publishes), where
 * "0 of 1" would say nothing the Approve button does not.
 */
export type ProposalApprovals = { count: number; required: number };

export function needsSeveralApprovals(
	approvals: ProposalApprovals | undefined,
): approvals is ProposalApprovals {
	return approvals !== undefined && approvals.required > 1;
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
