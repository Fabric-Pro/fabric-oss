/**
 * Typed failures of the Proposal export (Fizzy #2946). The failure's type is
 * its code, so the workflow's retry policy and the status read both see the
 * code and nothing else: the message is fixed text, never content.
 */

import { ApplicationFailure } from "@temporalio/common";
import {
	PROPOSAL_EXPORT_NON_RETRYABLE_CODES,
	type ProposalExportFailureCode,
} from "./types";

const MESSAGES: Readonly<Record<ProposalExportFailureCode, string>> = {
	EXPORT_ACCESS_DENIED:
		"The export's starter can no longer export this document.",
	DOCUMENT_TOO_LARGE: "The document is larger than one export reads.",
	TOO_MANY_PAGES: "The document prints to more pages than one export allows.",
	EXPORT_TIMED_OUT: "The export did not finish within its time budget.",
	EXPORT_FAILED: "The export failed.",
};

/** A failure with `code` as its type, non-retryable when no retry can help. */
export function exportFailure(
	code: ProposalExportFailureCode,
): ApplicationFailure {
	return PROPOSAL_EXPORT_NON_RETRYABLE_CODES.includes(code)
		? ApplicationFailure.nonRetryable(MESSAGES[code], code)
		: ApplicationFailure.retryable(MESSAGES[code], code);
}
