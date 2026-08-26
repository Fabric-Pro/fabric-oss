import { PENDING_DECISIONS_HEADING } from "@repo/agent-prompts";
import { describe, expect, it } from "vitest";
import {
	parseStoryContent,
	resolveStoryContentForSave,
} from "../../story-content";
import { restorePendingDecisions } from "../pending-decisions-preserve";

// Fizzy #1929 regression. A product owner answers an open question while an AI
// spec draft awaits approval. The answer is written to the server immediately,
// as a bullet under the pending-integration appendix. Resolving the draft then
// saves the EDITOR — built from a snapshot taken before the answer landed — over
// the whole spec body, erasing the appendix while the Decision Log still reads
// `Resolved`. Verified on staging: after accepting, neither answer's text was in
// the spec. The appendix is the only channel a later run can learn the decision
// through, so the loss is permanent.

/**
 * A realistic pre-run spec body. The fixtures below are whole documents on
 * purpose: the placement rules this module implements (above the criteria
 * boundary, under the existing heading) only mean anything on a document that
 * has those sections.
 */
const SPEC_BODY = [
	"# Feature: Bulk export of project records",
	"",
	"## Description",
	"",
	"Product owners hand auditors a single archive of everything a project",
	"produced. Today they assemble it by hand from four screens, which takes an",
	"afternoon and misses attachments.",
	"",
	"## Use Cases",
	"",
	"-   A product owner exports a project's records for an external audit.",
	"-   A team lead re-runs an export after a correction and gets a fresh archive.",
	"",
	"## Out of Scope / Constraints",
	"",
	"-   Scheduled or recurring exports are not part of this feature.",
].join("\n");

/** The same body after the model's rewrite — what the editor holds at accept. */
const REWRITTEN_SPEC_BODY = [
	"# Feature: Bulk export of project records",
	"",
	"## Description",
	"",
	"Product owners hand auditors a single archive of everything a project",
	"produced, generated in one action rather than assembled by hand from four",
	"screens.",
	"",
	"## Use Cases",
	"",
	"-   A product owner exports a project's records for an external audit.",
	"-   A team lead re-runs an export after a correction and gets a fresh archive.",
	"-   An auditor opens the archive without access to the platform.",
	"",
	"## Out of Scope / Constraints",
	"",
	"-   Scheduled or recurring exports are not part of this feature.",
].join("\n");

const ACCEPTANCE_SECTION = [
	"## Acceptance Criteria",
	"",
	"-   Given a project with records, when the owner exports, then one archive is produced.",
	"-   Given an export in progress, when the owner leaves the page, then it continues.",
].join("\n");

const Q_ARCHIVED = "Should archived items appear in the export?";
const A_ARCHIVED = "No — archived items are excluded from every export.";
const Q_RETENTION = "How long is a generated archive retained?";
const A_RETENTION = "90 days, then it is deleted automatically.";
/** Carries punctuation Turndown escapes on the way out of the editor. */
const Q_FIELDS = "Does the export include user_id and cost_center columns?";
const A_FIELDS = "Yes, both columns are included.";

/**
 * An answer of two paragraphs. `appendPendingDecision` interpolates the answer
 * RAW and unindented, so the blank line between them lands INSIDE the entry —
 * a parser that stops at the first blank line restores only the first sentence.
 */
const Q_ARCHIVE_ACCESS = "Who can download a generated archive?";
const A_ARCHIVE_ACCESS = [
	"Only project members holding the export permission.",
	"",
	"An organization owner may grant that permission to an auditor account for a",
	"single project, without adding the auditor to the project itself.",
].join("\n");

/** An answer carrying its own list, at column 0 — every item of it looks like a
 * bullet to a parser that terminates on one. */
const Q_ARCHIVE_CONTENTS = "What does the archive contain?";
const A_ARCHIVE_CONTENTS = [
	"One CSV per record type, plus a manifest:",
	"",
	"- stories.csv",
	"- tasks.csv",
	"- attachments/",
	"- manifest.json",
].join("\n");

/** Shape (1): what `appendPendingDecision` writes to the server. */
function storedEntry(question: string, answer: string): string {
	return `- **Q:** ${question}\n  **Decided:** ${answer}`;
}

/**
 * Shape (2): Turndown of the mounted editor — one line, four-space marker, and
 * markdown punctuation escaped. Verified against the real
 * `fromMarkdown` → `getTurndownService().turndown` round trip.
 */
function editorEntry(question: string, answer: string): string {
	const escapeMd = (text: string) => text.replace(/_/g, "\\_");
	return `-   **Q:** ${escapeMd(question)} **Decided:** ${escapeMd(answer)}`;
}

/**
 * Shape (3): `buildInitialContent()` over an HTML-stored description — the
 * baseline when no run started during this mount. Turndown renders the `<br>`
 * as a two-space hard break with an indented continuation.
 */
function initialContentEntry(question: string, answer: string): string {
	return `-   **Q:** ${question}  \n    **Decided:** ${answer}`;
}

function withAppendix(body: string, entries: string[]): string {
	return `${body}\n\n${PENDING_DECISIONS_HEADING}\n\n${entries.join("\n")}`;
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

describe("restorePendingDecisions", () => {
	it("restores an entry the server holds but the pre-run baseline never had", () => {
		// The run started before the question was answered, so the model was
		// given a spec with no appendix at all.
		const baseline = `${SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVED, A_ARCHIVED),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(result).toContain(Q_ARCHIVED);
		expect(result).toContain(A_ARCHIVED);
		// The model's rewrite is still what gets saved.
		expect(result).toContain(
			"An auditor opens the archive without access to the platform.",
		);
	});

	it("does not restore an entry present in BOTH the baseline and the server", () => {
		// The run WAS given this decision and integrated it — the bullet is gone
		// from the rewrite on purpose. Re-adding it would put the decision in the
		// spec twice.
		const baseline = withAppendix(SPEC_BODY, [
			editorEntry(Q_ARCHIVED, A_ARCHIVED),
		]);
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVED, A_ARCHIVED),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(result).toBe(content);
		expect(result).not.toContain(PENDING_DECISIONS_HEADING);
		expect(result).not.toContain(Q_ARCHIVED);
	});

	it("matches across serializers: an editor-shaped baseline entry and its stored-shaped twin are one decision", () => {
		// KTD2a. The two sides are never byte-equal for a bulleted document — the
		// baseline is Turndown output (`-   `, escaped `\_`, one line), the server
		// is markdown the answer path wrote (`- `, two lines). A raw set
		// difference reports this as new and duplicates it on every accept.
		const baseline = withAppendix(SPEC_BODY, [
			editorEntry(Q_FIELDS, A_FIELDS),
		]);
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_FIELDS, A_FIELDS),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		// The two shapes really are different text, so the match cannot be an
		// accident of the fixtures.
		expect(editorEntry(Q_FIELDS, A_FIELDS)).not.toBe(
			storedEntry(Q_FIELDS, A_FIELDS),
		);

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(result).toBe(content);
		expect(countOccurrences(result, "cost_center")).toBe(0);
	});

	it("matches a baseline built by the initial-content helper (no run started this mount)", () => {
		const baseline = withAppendix(SPEC_BODY, [
			initialContentEntry(Q_RETENTION, A_RETENTION),
		]);
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_RETENTION, A_RETENTION),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(result).toBe(content);
		expect(result).not.toContain(Q_RETENTION);
	});

	it("splices ABOVE the acceptance-criteria heading and leaves the criteria column byte-identical", () => {
		// KTD2b. The saved content is the combined document; the save splits it on
		// the first acceptance heading and stores the tail in its own column.
		// Appending at end-of-document would file decision bullets AS acceptance
		// criteria.
		const baseline = `${SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVED, A_ARCHIVED),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const existingCriteria = resolveStoryContentForSave(
			content,
			null,
		).acceptanceCriteria;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(result.indexOf(Q_ARCHIVED)).toBeGreaterThan(-1);
		expect(result.indexOf(Q_ARCHIVED)).toBeLessThan(
			result.indexOf("## Acceptance Criteria"),
		);

		// The save round trip: the criteria column is untouched, and the restored
		// decision lands in `description`, which is what the pending-decision
		// count and every later run read.
		const saved = resolveStoryContentForSave(result, existingCriteria);
		expect(saved.acceptanceCriteria).toBe(existingCriteria);
		expect(saved.acceptanceCriteriaPreserved).toBe(false);
		expect(saved.description).toContain(PENDING_DECISIONS_HEADING);
		expect(saved.description).toContain(Q_ARCHIVED);
		expect(saved.acceptanceCriteria).not.toContain(Q_ARCHIVED);
	});

	it("re-creates the appendix heading with the exact constant when the saved content has none", () => {
		// KTD2c. The model is told to DELETE the heading once it integrates, so
		// this is the common case. Bullets restored without the heading survive as
		// text and are invisible to every later run — the prompt clause that folds
		// them in is conditional on this exact string.
		const baseline = `${SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVED, A_ARCHIVED),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		expect(content).not.toContain(PENDING_DECISIONS_HEADING);

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(result).toContain(
			"## Resolved Decisions (pending integration)\n\n- **Q:**",
		);
		expect(countOccurrences(result, PENDING_DECISIONS_HEADING)).toBe(1);
	});

	it("merges under an appendix heading the saved content already carries, without a second heading", () => {
		// The rewrite kept the appendix (the model echoed the heading back). The
		// new entry joins the existing section instead of starting a rival one.
		const baseline = withAppendix(SPEC_BODY, [
			editorEntry(Q_ARCHIVED, A_ARCHIVED),
		]);
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVED, A_ARCHIVED),
			storedEntry(Q_RETENTION, A_RETENTION),
		]);
		const content = `${withAppendix(REWRITTEN_SPEC_BODY, [
			editorEntry(Q_ARCHIVED, A_ARCHIVED),
		])}\n\n${ACCEPTANCE_SECTION}`;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(countOccurrences(result, PENDING_DECISIONS_HEADING)).toBe(1);
		expect(countOccurrences(result, Q_RETENTION)).toBe(1);
		// The already-integrated entry is not duplicated by the merge.
		expect(countOccurrences(result, Q_ARCHIVED)).toBe(1);
		// The new bullet sits inside the appendix, above the criteria boundary.
		expect(result.indexOf(Q_RETENTION)).toBeGreaterThan(
			result.indexOf(PENDING_DECISIONS_HEADING),
		);
		expect(result.indexOf(Q_RETENTION)).toBeLessThan(
			result.indexOf("## Acceptance Criteria"),
		);
	});

	it("restores every mid-run entry, in the order the server holds them", () => {
		const baseline = `${SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVED, A_ARCHIVED),
			storedEntry(Q_RETENTION, A_RETENTION),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(result).toContain(A_ARCHIVED);
		expect(result).toContain(A_RETENTION);
		expect(result.indexOf(Q_ARCHIVED)).toBeLessThan(
			result.indexOf(Q_RETENTION),
		);
		expect(countOccurrences(result, PENDING_DECISIONS_HEADING)).toBe(1);
	});

	it("restores the answer on the reject path too, so the next autosave cannot write over it", () => {
		// Reject puts the pre-run baseline back into the editor and marks it
		// dirty, so the next autosave writes that pre-answer text over the server
		// — the same erasure as accept, one debounce later. The restore content is
		// the baseline, so baseline and content are the same document here.
		const baseline = `${SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVED, A_ARCHIVED),
		]);

		const restored = restorePendingDecisions({
			baseline,
			serverDescription,
			content: baseline,
		});

		// …and the save that follows the reject keeps it.
		const saved = parseStoryContent(restored);
		expect(saved.description).toContain(PENDING_DECISIONS_HEADING);
		expect(saved.description).toContain(A_ARCHIVED);
		expect(saved.acceptanceCriteria).toBe(
			parseStoryContent(baseline).acceptanceCriteria,
		);
	});

	it("restores the second answer when the same question was answered twice mid-run", () => {
		// Multiset, not set: one occurrence in the baseline covers one occurrence
		// on the server, not both.
		const baseline = withAppendix(SPEC_BODY, [
			editorEntry(Q_ARCHIVED, A_ARCHIVED),
		]);
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVED, A_ARCHIVED),
			storedEntry(Q_ARCHIVED, "Reversed — archived items are included."),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(countOccurrences(result, Q_ARCHIVED)).toBe(1);
		expect(result).toContain("Reversed — archived items are included.");
		expect(result).not.toContain(A_ARCHIVED);
	});

	it("restores a multi-paragraph answer whole, not just its first paragraph", () => {
		// The answer half of a bullet is free-form text the product owner typed.
		// Terminating the entry at the first blank line brings back one sentence of
		// it and silently drops the rest — the same class of loss this module
		// exists to stop, one layer down.
		const baseline = `${SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVE_ACCESS, A_ARCHIVE_ACCESS),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		// Byte-for-byte what the server holds — both paragraphs, the blank line
		// between them, and no re-indentation of the continuation.
		expect(result).toContain(
			storedEntry(Q_ARCHIVE_ACCESS, A_ARCHIVE_ACCESS),
		);
		expect(result).toContain(
			"Only project members holding the export permission.",
		);
		expect(result).toContain(
			"single project, without adding the auditor to the project itself.",
		);
		// One decision, not two: the second paragraph did not become its own entry.
		expect(countOccurrences(result, "**Q:**")).toBe(1);
		// Still filed inside the appendix, above the criteria boundary.
		expect(result.indexOf(Q_ARCHIVE_ACCESS)).toBeGreaterThan(
			result.indexOf(PENDING_DECISIONS_HEADING),
		);
		expect(result.indexOf(Q_ARCHIVE_ACCESS)).toBeLessThan(
			result.indexOf("## Acceptance Criteria"),
		);
	});

	it("restores every item of an answer that carries its own bullet list", () => {
		const baseline = `${SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVE_CONTENTS, A_ARCHIVE_CONTENTS),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(result).toContain(
			storedEntry(Q_ARCHIVE_CONTENTS, A_ARCHIVE_CONTENTS),
		);
		for (const item of [
			"- stories.csv",
			"- tasks.csv",
			"- attachments/",
			"- manifest.json",
		]) {
			expect(result).toContain(item);
		}
		// The four list items did not read as four further decisions.
		expect(countOccurrences(result, "**Q:**")).toBe(1);
	});

	it("recognises a multi-paragraph entry the baseline already carries, and does not duplicate it", () => {
		// The run WAS given this decision in full and integrated it. Both sides of
		// the comparison have to read the same entry: a parser that truncates only
		// one of them would restore a decision the spec already states.
		const baseline = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVE_ACCESS, A_ARCHIVE_ACCESS),
		]);
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_ARCHIVE_ACCESS, A_ARCHIVE_ACCESS),
		]);
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(result).toBe(content);
		expect(result).not.toContain(Q_ARCHIVE_ACCESS);
		expect(result).not.toContain(
			"Only project members holding the export permission.",
		);
	});

	it("keeps body prose out of an entry, before and after the appendix section", () => {
		// The multi-line rule is scoped to the appendix, which a heading bounds on
		// both sides. A `**Q:**`-shaped bullet sitting in the BODY keeps the
		// conservative terminator, and the section following the appendix is
		// ordinary prose — neither may be carried into a restored entry.
		const serverDescription = [
			SPEC_BODY,
			"",
			"## Decision History",
			"",
			"- **Q:** May a viewer trigger an export?",
			"  **Decided:** No — exporting requires the export permission.",
			"",
			"Recorded during discovery and not revisited since.",
			"",
			PENDING_DECISIONS_HEADING,
			"",
			storedEntry(Q_ARCHIVED, A_ARCHIVED),
			"",
			"## Notes",
			"",
			"The archive is produced by a background worker, not in the request.",
		].join("\n");
		const baseline = `${SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		// Both decisions come back…
		expect(result).toContain("May a viewer trigger an export?");
		expect(result).toContain(
			"**Decided:** No — exporting requires the export permission.",
		);
		expect(result).toContain(storedEntry(Q_ARCHIVED, A_ARCHIVED));
		// …carrying none of the prose that merely sits near them.
		expect(result).not.toContain("## Decision History");
		expect(result).not.toContain("Recorded during discovery");
		expect(result).not.toContain("## Notes");
		expect(result).not.toContain(
			"The archive is produced by a background worker",
		);
	});

	it("returns the saved content untouched when the server holds no appendix", () => {
		const baseline = `${SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const content = `${REWRITTEN_SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;

		expect(
			restorePendingDecisions({
				baseline,
				serverDescription: SPEC_BODY,
				content,
			}),
		).toBe(content);
		expect(
			restorePendingDecisions({
				baseline,
				serverDescription: null,
				content,
			}),
		).toBe(content);
	});

	it("still finds a decorated appendix heading in the saved content", () => {
		// Highlighting the heading in the editor stores
		// `## <mark data-color="…">Resolved Decisions (pending integration)</mark>`.
		// A whole-document `indexOf` stops matching there, and the appendix would
		// gain a second heading on every accept.
		const baseline = `${SPEC_BODY}\n\n${ACCEPTANCE_SECTION}`;
		const serverDescription = withAppendix(SPEC_BODY, [
			storedEntry(Q_RETENTION, A_RETENTION),
		]);
		const decoratedHeading =
			'## <mark data-color="#fef08a">Resolved Decisions (pending integration)</mark>';
		const content = [
			REWRITTEN_SPEC_BODY,
			"",
			decoratedHeading,
			"",
			editorEntry(Q_ARCHIVED, A_ARCHIVED),
			"",
			ACCEPTANCE_SECTION,
		].join("\n");

		const result = restorePendingDecisions({
			baseline,
			serverDescription,
			content,
		});

		expect(result).toContain(decoratedHeading);
		expect(countOccurrences(result, Q_RETENTION)).toBe(1);
		// No plain-text second heading was stamped next to the decorated one.
		expect(countOccurrences(result, `\n${PENDING_DECISIONS_HEADING}`)).toBe(
			0,
		);
		expect(result.indexOf(Q_RETENTION)).toBeGreaterThan(
			result.indexOf(decoratedHeading),
		);
		expect(result.indexOf(Q_RETENTION)).toBeLessThan(
			result.indexOf("## Acceptance Criteria"),
		);
	});
});
