/** The page of proposals the dialog opens on, which the header's count reads too. */
export const PROPOSALS_PAGE_SIZE = 25;

type ProposalListRow = {
	proposalStatus: string | null;
	status: string;
	destination?: string | null;
};

/**
 * Whether a reviewer can still decide this proposal: it is pending, it goes to
 * Fabric (a suggestion that opens a pull request is decided on that pull
 * request), and its checks are not still running. One rule for the dialog's
 * Approve and Reject and for the count the header shows, so they cannot
 * disagree about what is waiting.
 */
export function awaitsDecision(row: ProposalListRow): boolean {
	return (
		row.proposalStatus === "PENDING" &&
		row.destination !== "REPOSITORY" &&
		row.status !== "RECEIVING" &&
		row.status !== "VALIDATING"
	);
}

export function countAwaitingDecision(
	rows: readonly ProposalListRow[] | undefined,
): number {
	return (rows ?? []).filter(awaitsDecision).length;
}
