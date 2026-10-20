/**
 * Counting what a Proposal export left out (Fizzy #2946): each stage tallies
 * its own warnings, and the activity merges them, always reported one per
 * code in the codes' declared order.
 */

import {
	PROPOSAL_EXPORT_WARNING_CODES,
	type ProposalExportWarning,
	type ProposalExportWarningCode,
} from "./types";

export class ExportWarningTally {
	private readonly counts = new Map<ProposalExportWarningCode, number>();

	/** A count of zero or less adds nothing. */
	add(code: ProposalExportWarningCode, by = 1): void {
		if (by > 0) {
			this.counts.set(code, (this.counts.get(code) ?? 0) + by);
		}
	}

	/** One warning per code counted, in the codes' declared order. */
	warnings(): ProposalExportWarning[] {
		return PROPOSAL_EXPORT_WARNING_CODES.flatMap((code) => {
			const total = this.counts.get(code) ?? 0;
			return total > 0 ? [{ code, count: total }] : [];
		});
	}
}
