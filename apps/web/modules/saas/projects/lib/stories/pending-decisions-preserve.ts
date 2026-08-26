/**
 * Keep decisions recorded DURING an AI spec run alive across the resolution of
 * that run's draft.
 *
 * ## The data loss this exists to stop
 *
 * Answering an open question writes the Q+A straight to the server, as a bullet
 * under the `## Resolved Decisions (pending integration)` appendix at the end of
 * `UserStory.description` (`appendPendingDecision`). That write lands
 * immediately — it does not wait for anything the editor is doing.
 *
 * A draft review, meanwhile, is derived from a snapshot: the baseline captured
 * when the run started, plus the model's rewrite painted over it as diff marks.
 * Resolving the review writes the EDITOR back over the whole spec body, and the
 * editor never saw the answer — so the appendix is erased. The Decision Log
 * still reads `Resolved`, and the spec carries no trace of what was decided.
 * Verified on staging: after accepting a draft, neither answer's text was in the
 * spec while both were `Resolved` in the log.
 *
 * That appendix is the ONLY channel by which a later run learns the decision.
 * The agent serving a run has no database access — it sees the spec text and
 * nothing else — and the prompt clause that teaches it to fold these bullets in
 * is conditional on that exact heading string. A lost appendix strands the
 * answer permanently, so this is not a cosmetic loss.
 *
 * ## Why a baseline difference, not "re-add everything on the server"
 *
 * At resolution time the server appendix holds both the entries the run already
 * integrated (the model was given them, dissolved them into the body, and
 * deleted the heading — the appendix on the server is only pruned when that
 * result is saved) and any entry answered after the run started. Re-adding all
 * of them would resurrect decisions the run just integrated, so the spec would
 * carry each decision twice. Entries present on the server but absent from the
 * pre-run baseline are exactly the ones the model never saw; only those come
 * back. Same extract-then-splice shape as the "Do Not Modify" verbatim guard.
 *
 * ## Why the key is the question text, never the raw bullet
 *
 * The two sides of that comparison come from different serializers and are never
 * byte-equal for a bulleted document (see `lastSavedMarkdownRef`'s declaration
 * comment in `StoryWorkspace.tsx`). Three shapes reach this function:
 *
 *   1. stored — what `appendPendingDecision` writes, two lines:
 *      `- **Q:** …` / `  **Decided:** …`
 *   2. editor — Turndown of the mounted document, one line, four-space marker:
 *      `-   **Q:** … **Decided:** …`
 *   3. initial-content — `buildInitialContent()`, used as the baseline when no
 *      run started during this mount; markdown descriptions pass through as (1),
 *      an HTML-stored description turns into a hard-broken variant of (2):
 *      `-   **Q:** …␠␠` / `    **Decided:** …`
 *
 * A raw set difference would report every server entry as new and duplicate
 * every decision on every accept. The key is therefore the bullet's question
 * text with decoration stripped, escapes dropped and whitespace collapsed —
 * identical across all three shapes.
 *
 * Matching is by multiset, not by set: credits for a key are the LARGER of its
 * count in the baseline and its count in the saved content, so answering the
 * same question twice mid-run still restores the second answer, while an entry
 * the model kept in place is not restored on top of itself.
 *
 * ## Why an entry does not end at the first blank line
 *
 * An answer is free-form text the product owner typed, and
 * `appendPendingDecision` interpolates it into the bullet RAW and unindented —
 * so an answer of two paragraphs is stored with a blank line inside the entry,
 * and one carrying its own list is stored with bullet lines inside it. Ending an
 * entry at the first blank or bullet line restores a FRAGMENT of what the user
 * wrote: the same silent content loss this module exists to stop, one layer
 * down. An entry therefore runs to the next `**Q:**` bullet, the next heading,
 * or the end of the appendix.
 *
 * The stored format is deliberately not changed to fence answers off (indented
 * continuations, a terminator line): rows already in the database carry the
 * unindented shape, and the parser has to read what is already there.
 *
 * That relaxed rule applies only INSIDE the appendix section, which is bounded
 * by a heading on both sides. Elsewhere in the document a blank line or any
 * further bullet still closes an entry, so a `**Q:**`-shaped bullet sitting in
 * the body can never swallow the prose that follows it.
 *
 * ## Why the splice goes above the acceptance-criteria heading
 *
 * The content being saved is the COMBINED document; the save splits it on the
 * first `Acceptance Criteria` heading and stores the tail in a separate column
 * (`resolveStoryContentForSave`). Appending at the end of the document would
 * file decision bullets AS acceptance criteria: it corrupts the column the QA
 * matrix and the criteria parser read, leaves the "X New Decisions" count
 * reading zero because that count scans `description`, and hides the entries
 * from every later run. Entries go immediately above the first acceptance
 * heading; end-of-document is the fallback for a document that has none.
 *
 * ## Why the heading is re-created
 *
 * The model is instructed to delete the appendix heading once it integrates, so
 * "saved content has no heading, and there are entries to restore" is the COMMON
 * case, not an edge one. Bullets restored without the heading would survive as
 * text and be invisible to every future run — the same stranding, one step later.
 * The heading is the shared `PENDING_DECISIONS_HEADING` constant, because the
 * prompt clause matches that exact string.
 *
 * Pure: no React, no DOM, no editor. The component around it is not directly
 * testable; this is, and the next timing window in this family has somewhere to
 * land other than a 7000-line component.
 */

import { PENDING_DECISIONS_HEADING } from "@repo/agent-prompts";
import {
	findHeadingLineEnd,
	stripInlineDecoration,
} from "@repo/utils/markdown-heading";
import { ACCEPTANCE_HEADING_RE } from "../story-content";

/** A bullet is anything the three serializers use as a list marker. */
const BULLET_LINE_RE = /^\s*[-*+]\s/;

/**
 * The list marker as it survives normalization. `stripInlineDecoration` deletes
 * `*` wherever it appears, so a `*`-marked bullet arrives here with no marker at
 * all — hence the optional group rather than a required one.
 */
const NORMALIZED_MARKER_RE = /^[-*+]\s+/;

/** Where the answer half of a bullet begins. Both sides truncate at the same
 * point, so a question that itself contains the word is still matched
 * symmetrically. */
const DECIDED_RE = /\bDecided:/;

/** A heading line, tested RAW — see `findSectionEndIdx` for why normalizing
 * here could only lose the match and over-read the section to EOF. */
const HEADING_LINE_RE = /^#{1,6}\s/;

/** One `**Q:** … **Decided:** …` bullet, however it was serialized. */
interface PendingDecisionEntry {
	/**
	 * Normalized question text. `""` when the bullet carries no question, which
	 * makes it unmatchable — those are never restored (there is nothing to
	 * lose, and restoring blind would duplicate on every accept).
	 */
	key: string;
	/**
	 * The entry's ORIGINAL lines, joined. Sliced from the source document and
	 * never from the normalized copy: `stripInlineDecoration` is match-only and
	 * lossy, and its output would corrupt the stored document.
	 */
	text: string;
}

export interface RestorePendingDecisionsInput {
	/**
	 * The editor content captured before the AI run started — what the model was
	 * given. Shape (2) after a run began during this mount, shape (3) otherwise.
	 */
	baseline: string | null | undefined;
	/**
	 * `UserStory.description` as the server holds it AT CLICK TIME, in shape (1).
	 * Must be read through a latest-value ref: the confirmation renderer's
	 * closure does not list the story among its dependencies, so a value it
	 * captured predates the answer's query invalidation.
	 */
	serverDescription: string | null | undefined;
	/** The combined document about to be written. */
	content: string;
}

/**
 * The question half of a normalized bullet's first line, or `null` when the line
 * is not a `**Q:**` bullet at all.
 */
function questionSegment(normalizedLine: string): string | null {
	const withoutMarker = normalizedLine.replace(NORMALIZED_MARKER_RE, "");
	if (!withoutMarker.startsWith("Q:")) {
		return null;
	}
	return withoutMarker.slice("Q:".length);
}

/**
 * Collapse a question into its comparison key.
 *
 * Backslashes go first because Turndown escapes markdown punctuation on the way
 * out of the editor (`a_b` → `a\_b`), and `stripInlineDecoration` removes the
 * `_` but not the backslash that was introduced with it — so the escape, not the
 * question, would decide whether two shapes of the same decision match.
 */
function normalizeQuestionKey(question: string): string {
	return question
		.replace(/\\/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * The question a line opens a pending-decision bullet with, or `null` when the
 * line is not such a bullet.
 *
 * One predicate for two jobs — finding an entry, and recognising the line that
 * ENDS the previous one — so the two can never disagree about what a decision
 * bullet is.
 */
function decisionBulletQuestion(line: string): string | null {
	if (!BULLET_LINE_RE.test(line)) {
		return null;
	}
	return questionSegment(stripInlineDecoration(line));
}

/**
 * The `[from, to)` LINE range of the appendix's body — every line after its
 * heading, up to the next heading or the end of the document. `null` when the
 * document has no appendix, or carries one with nothing under it.
 *
 * Derived from the two offset scanners already in play rather than from a third
 * heading scan of its own: `findHeadingLineEnd` is the one place that still sees
 * a heading the editor decorated, and `findSectionEndOffset` terminates on the
 * same raw heading test the splice below uses. A private copy of either would be
 * a second answer to "where is this section", which is exactly the drift this
 * file's shared imports exist to prevent.
 */
function findAppendixLineRange(
	text: string,
	lines: string[],
): { from: number; to: number } | null {
	const headingEnd = findHeadingLineEnd(text, PENDING_DECISIONS_HEADING);
	if (headingEnd === -1) {
		return null;
	}
	const sectionEnd = findSectionEndOffset(text, headingEnd);

	let from = lines.length;
	let to = lines.length;
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		// A line belongs to the section when it STARTS past the heading line's
		// last character and before the offset the section ends at.
		if (from === lines.length && offset > headingEnd) {
			from = i;
		}
		if (to === lines.length && offset >= sectionEnd) {
			to = i;
		}
		// + 1 for the "\n" that `split` consumed.
		offset += (lines[i] ?? "").length + 1;
	}

	return from < to ? { from, to } : null;
}

/**
 * Every pending-decision bullet in a document, in document order.
 *
 * Bullets are looked for across the WHOLE document rather than only under the
 * appendix heading: a run that kept a decision but moved it — or that deleted
 * the heading it was told to delete and left the bullets behind — has still
 * integrated it, and matching it wherever it sits is what keeps the splice from
 * re-adding it.
 *
 * Where an entry ENDS depends on where it sits. See "Why an entry does not end
 * at the first blank line" in the module docstring: inside the appendix an
 * answer may hold blank lines and its own bullet list, so only the next `**Q:**`
 * bullet, a heading, or the section's end closes the entry; outside it there is
 * no section boundary to lean on, so the conservative terminator stays.
 */
function parsePendingDecisionEntries(
	text: string | null | undefined,
): PendingDecisionEntry[] {
	if (!text) {
		return [];
	}

	const lines = text.split("\n");
	const appendix = findAppendixLineRange(text, lines);
	const inAppendix = (index: number) =>
		appendix !== null && index >= appendix.from && index < appendix.to;

	const entries: PendingDecisionEntry[] = [];

	for (let i = 0; i < lines.length; i++) {
		const question = decisionBulletQuestion(lines[i] ?? "");
		if (question === null) {
			continue;
		}

		// The bullet's continuation lines: the `**Decided:**` half lives on one in
		// shapes (1) and (3), and the rest of a multi-paragraph answer follows it.
		const answerMaySpanLines = inAppendix(i);
		let end = i + 1;
		while (end < lines.length) {
			const next = lines[end] ?? "";
			if (HEADING_LINE_RE.test(next)) {
				break;
			}
			if (answerMaySpanLines) {
				if (!inAppendix(end) || decisionBulletQuestion(next) !== null) {
					break;
				}
			} else if (!next.trim() || BULLET_LINE_RE.test(next)) {
				break;
			}
			end++;
		}

		// Blank lines trailing the entry separate it from what comes next; they
		// are not part of the answer and must not reach the restored text.
		while (end - 1 > i && !(lines[end - 1] ?? "").trim()) {
			end--;
		}

		const normalizedTail = lines
			.slice(i + 1, end)
			.map((line) => stripInlineDecoration(line));
		const flattened = [question, ...normalizedTail].join(" ");
		const decidedAt = flattened.search(DECIDED_RE);

		entries.push({
			key: normalizeQuestionKey(
				decidedAt === -1 ? flattened : flattened.slice(0, decidedAt),
			),
			text: lines.slice(i, end).join("\n"),
		});

		i = end - 1;
	}

	return entries;
}

/** How many times each key occurs. */
function countByKey(entries: PendingDecisionEntry[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
	}
	return counts;
}

/**
 * Character offset of the first acceptance-criteria heading LINE, or `-1`.
 *
 * The regex is imported from `story-content.ts` rather than copied: that file's
 * doc comment records what happened the last time this pattern existed in two
 * places (the editor broadened to `#{1,6}` while the backend stayed at `#{1,2}`,
 * and the two split the same document differently). The split this insert has to
 * respect is the one that regex performs.
 */
function findAcceptanceHeadingStart(text: string): number {
	let offset = 0;
	for (const line of text.split("\n")) {
		if (ACCEPTANCE_HEADING_RE.test(stripInlineDecoration(line))) {
			return offset;
		}
		// + 1 for the "\n" that `split` consumed.
		offset += line.length + 1;
	}
	return -1;
}

/**
 * Character offset where the appendix section opened at `headingEnd` stops — the
 * next heading line, or the end of the document. The acceptance heading is a
 * heading like any other, so this never runs past the criteria boundary.
 */
function findSectionEndOffset(text: string, headingEnd: number): number {
	let offset = 0;
	for (const line of text.split("\n")) {
		if (offset > headingEnd && HEADING_LINE_RE.test(line)) {
			return offset;
		}
		offset += line.length + 1;
	}
	return text.length;
}

/**
 * Return `content` with every appendix entry the server holds but the pre-run
 * baseline did not, spliced back in.
 *
 * Returns `content` untouched when there is nothing to restore — the common
 * case — so a resolution that races nothing produces a byte-identical save.
 */
export function restorePendingDecisions({
	baseline,
	serverDescription,
	content,
}: RestorePendingDecisionsInput): string {
	const serverEntries = parsePendingDecisionEntries(serverDescription);
	if (serverEntries.length === 0) {
		return content;
	}

	const baselineCounts = countByKey(parsePendingDecisionEntries(baseline));
	const contentCounts = countByKey(parsePendingDecisionEntries(content));

	// Credits are the LARGER of the two counts, not their sum: an entry the run
	// left in place is in both documents and is still only one decision.
	const credits = new Map<string, number>();
	for (const key of [...baselineCounts.keys(), ...contentCounts.keys()]) {
		credits.set(
			key,
			Math.max(baselineCounts.get(key) ?? 0, contentCounts.get(key) ?? 0),
		);
	}

	const missing: PendingDecisionEntry[] = [];
	for (const entry of serverEntries) {
		if (!entry.key) {
			continue;
		}
		const remaining = credits.get(entry.key) ?? 0;
		if (remaining > 0) {
			credits.set(entry.key, remaining - 1);
			continue;
		}
		missing.push(entry);
	}

	if (missing.length === 0) {
		return content;
	}

	// Server order, and adjacent lines — the shape `appendPendingDecision`
	// produces, so a document that round-trips through here reads like one the
	// answer path wrote.
	const insertion = missing.map((entry) => entry.text).join("\n");

	const acceptanceStart = findAcceptanceHeadingStart(content);
	const headingEnd = findHeadingLineEnd(content, PENDING_DECISIONS_HEADING);

	// An appendix heading BELOW the acceptance boundary is not an appendix — it
	// is text inside the criteria column. Merging under it would write decisions
	// into that column, which is the corruption this placement exists to avoid,
	// so a fresh heading is created above the boundary instead.
	const canMergeUnderHeading =
		headingEnd !== -1 &&
		(acceptanceStart === -1 || headingEnd < acceptanceStart);

	if (canMergeUnderHeading) {
		const sectionEnd = findSectionEndOffset(content, headingEnd);
		const head = content.slice(0, sectionEnd).trimEnd();
		const tail = content.slice(sectionEnd);
		return tail
			? `${head}\n${insertion}\n\n${tail}`
			: `${head}\n${insertion}`;
	}

	const block = `${PENDING_DECISIONS_HEADING}\n\n${insertion}`;

	if (acceptanceStart === -1) {
		const head = content.trimEnd();
		return head ? `${head}\n\n${block}` : block;
	}

	const head = content.slice(0, acceptanceStart).trimEnd();
	const tail = content.slice(acceptanceStart);
	return head ? `${head}\n\n${block}\n\n${tail}` : `${block}\n\n${tail}`;
}
