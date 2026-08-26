/**
 * QA tab traceability helpers.
 *
 * Acceptance criteria live as ONE markdown blob (`UserStory.acceptanceCriteria`)
 * — there is no addressable AC entity. The AI test-case drafter tags each case
 * with a free-text ref like "AC 3", counting the criteria in the order they
 * appear. These helpers reproduce that counting deterministically so the
 * traceability matrix can join real TestCase rows (and analysis warnings) back
 * to the criterion each one covers. Nothing is ever dropped: a case with no ref
 * lands in "unmapped", and a case whose ref cannot be placed lands in
 * "unresolved" — a different fact, and a different fix.
 */

/**
 * The acceptance-criteria parser and the "AC N" ref resolver now live in
 * `@repo/utils/acceptance-criteria` — ONE implementation, shared with the
 * test-case drafter in `@repo/ai`.
 *
 * They used to be two: this file parsed criteria for the matrix and
 * `countAcceptanceCriteria` counted them for the drafter's cap, each carrying a
 * comment telling the next reader to keep them in lock-step. A differential run
 * over 11,154 generated blobs found them disagreeing on 2,098 of them — the
 * parity test could only ever cover the blobs somebody thought to add.
 *
 * Re-exported rather than repointing every caller: this module is the stories
 * lib's traceability facade and the matrix builders below consume
 * `ParsedCriterion` directly.
 */
import {
	criterionIndexFromRef,
	type ParsedCriterion,
	parseAcceptanceCriteria,
} from "@repo/utils/acceptance-criteria";

// Imported, not bare-re-exported: the matrix builders below call both functions,
// and `export … from` binds nothing locally. The type is re-exported in its own
// statement — a mixed value+type `export { a, type B, c }` was erased wholesale by
// the test transform, leaving every caller with a ReferenceError at runtime.
export type { ParsedCriterion };
export { criterionIndexFromRef, parseAcceptanceCriteria };

export interface TraceabilityCase {
	id: string;
	/** Every criterion this case claims to cover. Empty means it names none. */
	acceptanceCriterionRefs: string[];
}

interface TraceabilityRow<C extends TraceabilityCase> {
	criterion: ParsedCriterion;
	cases: C[];
}

export interface TraceabilityMatrix<C extends TraceabilityCase> {
	rows: TraceabilityRow<C>[];
	/** Cases carrying no criterion reference at all — genuinely unmapped. */
	unmapped: C[];
	/**
	 * Cases that DO name a criterion Fabric could not place: a free-text
	 * reference, or a number past the end of the parsed criteria because the
	 * specification shrank after the case was written.
	 *
	 * Separated from `unmapped` because telling somebody a case is unmapped when
	 * they explicitly mapped it invites them to map it again, and the second
	 * attempt fails the same way. "You mapped this and I cannot place it" is a
	 * different problem with a different fix — usually the criterion text, not
	 * the case.
	 */
	unresolved: C[];
}

/** The extra fields the exported matrix prints for each case. */
export interface ExportableTraceabilityCase extends TraceabilityCase {
	identifier: string;
	title: string;
	currentResult: string;
}

/** Escape a cell so a pipe or newline in free text can't break the table. */
function cell(text: string): string {
	return text
		.replace(/\r?\n+/g, " ")
		.replace(/\|/g, "\\|")
		.trim();
}

/**
 * Render a traceability matrix as markdown for compliance/audit export:
 * every acceptance criterion, the cases covering it, and each
 * case's latest result.
 *
 * Two things this deliberately does NOT hide, because the export is evidence:
 *  - Uncovered criteria are listed with an explicit gap marker rather than
 *    omitted, so the document proves coverage AND its absence.
 *  - When the caller only loaded part of the case list, the header says so.
 *    An audit document that silently describes one page as the whole set is
 *    worse than no document.
 */
export function traceabilityMatrixToMarkdown<
	C extends ExportableTraceabilityCase,
>(input: {
	storyIdentifier?: string | null;
	storyTitle?: string | null;
	matrix: TraceabilityMatrix<C>;
	/** Total linked cases on the server; flags a partial export when > loaded. */
	totalCases?: number;
	/** True when more case pages exist than were loaded into the matrix. */
	truncated?: boolean;
	/** Injected so the export is deterministic and testable. */
	generatedAt?: Date;
}): string {
	const { matrix, storyIdentifier, storyTitle, totalCases, truncated } =
		input;
	const loaded =
		matrix.rows.reduce((n, r) => n + r.cases.length, 0) +
		matrix.unmapped.length +
		matrix.unresolved.length;

	const heading = [storyIdentifier, storyTitle].filter(Boolean).join(" · ");
	const lines: string[] = [
		`# Traceability matrix${heading ? ` — ${heading}` : ""}`,
		"",
	];
	if (input.generatedAt) {
		lines.push(`Generated ${input.generatedAt.toISOString()}`, "");
	}

	const covered = matrix.rows.filter((r) => r.cases.length > 0).length;
	lines.push(
		`Acceptance criteria: ${matrix.rows.length} · covered: ${covered} · gaps: ${matrix.rows.length - covered}`,
		"",
	);
	if (truncated) {
		lines.push(
			`> **Partial export.** ${loaded} of ${totalCases ?? "?"} linked cases were loaded, so coverage below is incomplete. Load all cases before using this for audit.`,
			"",
		);
	}

	lines.push(
		"| AC | Acceptance criterion | Test case | Result |",
		"| --- | --- | --- | --- |",
	);
	for (const row of matrix.rows) {
		if (row.cases.length === 0) {
			lines.push(
				`| ${row.criterion.index} | ${cell(row.criterion.text)} | _(no test case — coverage gap)_ | — |`,
			);
			continue;
		}
		row.cases.forEach((c, i) => {
			// Repeat the criterion only on its first row so the table reads as
			// grouped without needing rowspan (which markdown has no notion of).
			lines.push(
				`| ${i === 0 ? row.criterion.index : ""} | ${i === 0 ? cell(row.criterion.text) : ""} | ${cell(c.identifier)} ${cell(c.title)} | ${cell(c.currentResult)} |`,
			);
		});
	}

	if (matrix.unresolved.length > 0) {
		lines.push(
			"",
			"## Cases naming a criterion that could not be placed",
			"",
			"Each of these carries a criterion reference Fabric could not resolve —",
			"free text, or a number past the end of the current criteria. The case is",
			"mapped; the reference is the thing to fix.",
			"",
			"| Test case | Reference | Result |",
			"| --- | --- | --- |",
			...matrix.unresolved.map(
				(c) =>
					`| ${cell(c.identifier)} ${cell(c.title)} | ${cell(c.acceptanceCriterionRefs.join(", "))} | ${cell(c.currentResult)} |`,
			),
		);
	}

	if (matrix.unmapped.length > 0) {
		lines.push(
			"",
			"## Cases not mapped to a criterion",
			"",
			"| Test case | Result |",
			"| --- | --- |",
			...matrix.unmapped.map(
				(c) =>
					`| ${cell(c.identifier)} ${cell(c.title)} | ${cell(c.currentResult)} |`,
			),
		);
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Join cases to criteria by ref index.
 *
 * Refs pointing past the parsed list (the specification shrank after the case
 * was written) are reported as UNRESOLVED rather than unmapped, and never
 * silently clamped onto a neighbouring criterion.
 */
export function buildTraceabilityMatrix<C extends TraceabilityCase>(
	criteria: ParsedCriterion[],
	cases: C[],
): TraceabilityMatrix<C> {
	const rows: TraceabilityRow<C>[] = criteria.map((criterion) => ({
		criterion,
		cases: [],
	}));
	const unmapped: C[] = [];
	const unresolved: C[] = [];
	for (const testCase of cases) {
		// A case appears under EVERY criterion it names. One case proving AC 1
		// and AC 3 covers two criteria, and counting it once under whichever
		// reference came first is what made the coverage figure understate the
		// suite.
		//
		// Whitespace counts as no reference — an empty box is not an attempt to
		// map something — so it is filtered before anything is resolved.
		const refs = testCase.acceptanceCriterionRefs.filter(
			(ref) => ref.trim().length > 0,
		);
		let placedAnywhere = false;
		const seenRows = new Set<number>();
		for (const ref of refs) {
			const index = criterionIndexFromRef(ref);
			const row = index === null ? undefined : rows[index - 1];
			if (!row) {
				continue;
			}
			// Guarded against a case naming the same criterion twice ("AC 3",
			// "3"), which resolves to one row and must not list the case twice.
			if (seenRows.has(index as number)) {
				placedAnywhere = true;
				continue;
			}
			seenRows.add(index as number);
			row.cases.push(testCase);
			placedAnywhere = true;
		}
		if (placedAnywhere) {
			continue;
		}
		// Nothing could be placed. A case that named SOMETHING is a different
		// fact from one that named nothing: the first was mapped by a person and
		// the reference is what needs fixing, and telling them it is "not
		// mapped" sends them round the same loop.
		//
		// Note this is reached only when NO reference resolved — one good
		// reference alongside a bad one leaves the case mapped, not unresolved.
		(refs.length > 0 ? unresolved : unmapped).push(testCase);
	}
	return { rows, unmapped, unresolved };
}
