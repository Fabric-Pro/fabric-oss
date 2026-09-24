/**
 * The two blocks every auto-drafted BUG body carries above the raw CI output:
 * the parsed assertion (when one could be recognised) and a statement of the
 * cause that never claims more than the analysis behind it did.
 *
 * Shared between {@link promoteFindingToBug} (which has an AI analysis, or
 * doesn't) and {@link openBugsForFailedCases} (the auto-open path, which never
 * has one) so the two bug builders describe "the cause is not established"
 * with the same words rather than two strings that quietly drift apart.
 */

import { parseAssertionValues } from "./assertion-values";

const KIND_LABELS: Record<string, string> = {
	PRODUCT_BUG: "Product bug",
	TEST_DEFECT: "Test defect",
	ENVIRONMENT: "Environment",
	FLAKY: "Flaky",
};

/**
 * The `Expected:` / `Actual:` lines, or none when the message didn't parse.
 *
 * A markdown list, not two plain lines: the body this feeds into is rendered
 * markdown, where two consecutive lines with no blank line between them
 * collapse into one paragraph — "Expected: 80 Actual: 90" on a single line,
 * losing the two-line shape a reader needs to tell the sides apart at a
 * glance. A `-` item forces its own line regardless of what comes before or
 * after it.
 */
export function buildAssertionLines(
	failureMessage: string | null | undefined,
): string[] {
	const parsed = parseAssertionValues(failureMessage);
	return parsed
		? [`- Expected: ${parsed.expected}`, `- Actual: ${parsed.actual}`]
		: [];
}

/** What an AI analysis found, in the terms {@link buildCauseLines} needs — a
 * subset of `FindingRow`, restated so this stays a pure function of plain
 * data rather than depending on the query layer's row shape. */
export interface FindingCauseAnalysis {
	analysedAt: Date | null;
	suspectedCause: string | null;
	suspectedKind: string | null;
	analysisModel: string | null;
}

/**
 * State the cause exactly as strongly as the analysis behind it — never more.
 *
 * An inconclusive analysis (UNKNOWN, or any verdict this code cannot name —
 * see below) says plainly that the cause is not established, then quotes the
 * hypothesis labelled as unverified — it is still worth showing, just not as
 * a fact. Any kind this code CAN name is shown as an AI hypothesis, not a
 * verified diagnosis, with the suspected kind in human words. No analysis at
 * all gets the same "not established" opening line as the inconclusive case,
 * because from the reader's chair the two are the same fact: nobody has
 * determined why this is failing.
 */
export function buildCauseLines(analysis: FindingCauseAnalysis): string[] {
	if (!analysis.analysedAt) {
		return [
			"Cause: not established — no AI analysis has run for this failure.",
		];
	}

	const modelSuffix = analysis.analysisModel
		? ` (${analysis.analysisModel})`
		: "";

	// Anything not a KEY this map actually has — UNKNOWN, or a future enum
	// value this mapping hasn't caught up with yet — is inconclusive. A verdict
	// this code cannot NAME must never be shown as a confident finding just
	// because it happens to be set.
	const isInconclusive = !(
		analysis.suspectedKind && analysis.suspectedKind in KIND_LABELS
	);
	if (isInconclusive) {
		const lines = [
			"Cause: not established — the AI analysis of this failure was inconclusive.",
		];
		if (analysis.suspectedCause) {
			lines.push(
				`Unverified AI hypothesis${modelSuffix}: ${analysis.suspectedCause}`,
			);
		}
		return lines;
	}

	const humanKind = KIND_LABELS[analysis.suspectedKind as string];
	const lines = [
		`AI hypothesis — not a verified diagnosis (suspected kind: ${humanKind}${modelSuffix}):`,
	];
	if (analysis.suspectedCause) {
		lines.push(analysis.suspectedCause);
	}
	return lines;
}
