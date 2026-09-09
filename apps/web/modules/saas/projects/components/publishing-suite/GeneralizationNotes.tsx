"use client";

/**
 * The generated draft's own account of what it wrote around, broken into
 * entries a reader can scan (Fizzy #1851, slice A6).
 *
 * Every generation prompt ends with the same locked clause — "say in your
 * safety note which ones shaped the draft" — so a draft written against three
 * unresolved approvals comes back describing all three. Stored as ONE string
 * (`safetyNote`, capped at 1000 characters), and rendered until now as one
 * paragraph, which made the most valuable block on the tab the hardest one to
 * read: the honest-refusal explanation was denser prose than the draft it
 * described.
 *
 * There is no structured per-approval field to render instead. The document
 * schema carries a single note, and the list of unresolved approvals lives a
 * level up in `GenerationTabs`, which the panels do not receive. So the split
 * below is a PRESENTATION heuristic over the note's own boundaries, not a
 * parse of anything the generator promised. It follows from that:
 *
 *  - Every character of the note survives it. Only the whitespace BETWEEN
 *    entries is dropped, and a note it cannot split confidently renders whole,
 *    as a paragraph. Reformatting must never become editing — this text is
 *    what the reader checks the draft's honesty against.
 *  - A single entry stays a paragraph rather than becoming a one-item bullet
 *    list, which is both a UI smell and a false promise that the note was
 *    broken down.
 */

/**
 * Said when a safety surface describes a DIFFERENT version than the draft
 * beside it.
 *
 * ONE sentence for every surface that needs it — the scaffold and
 * unconfirmed-release banners, the approval-status and claims tables, the
 * inputs-needed lists, the export caveat block, and now the generalization
 * note. It lived as a private constant in `CaseStudyPanel` and again in
 * `StakeholderEmailPanel`, saying the same thing twice; both now import this
 * one. Two spellings of the same warning are two warnings as soon as one of
 * them is edited, and these surfaces exist so a reader of the file learns what
 * a reader of the page learns.
 */
export const OTHER_VERSION_NOTE =
	"These notes describe the most recent generated version, which is not the version this text was saved from.";

/** A leading list marker, for the notes that arrive already itemised. */
const LIST_MARKER = /^\s*(?:[-*•–—]|\d+[.)])\s+/;

/**
 * A sentence boundary, conservatively: terminal punctuation, whitespace, then
 * a capital. Deliberately blind to `12.4% uplift` and `v1.2` — neither is
 * followed by whitespace-then-capital — and `e.g.` is caught by the
 * word-length guard below.
 */
const SENTENCE_BOUNDARY = /[.!?]\s+(?=[A-Z])/g;

/** The run of letters immediately before a candidate boundary. */
const WORD_BEFORE_BOUNDARY = /[A-Za-z]+$/;

/**
 * Both sides of a split must be at least this long.
 *
 * A three-word fragment on its own line is not an approval the draft wrote
 * around — it is a sentence that happened to contain a full stop. Splitting
 * there produces entries that read as truncation.
 */
const MIN_ENTRY_CHARACTERS = 25;

/**
 * The shortest word that may precede a sentence break.
 *
 * `U.S. Government` and `e.g. Naming` both leave a one-letter run before the
 * period; a real sentence ending does not. Three is the smallest bound that
 * admits ordinary words while rejecting an initialism's trailing letter.
 */
const MIN_WORD_BEFORE_BOUNDARY = 3;

/**
 * More entries than a 1000-character note can plausibly hold means the split
 * has found boundaries that are not there. The whole note renders instead —
 * never a truncated set, which would lose facts.
 */
const MAX_ENTRIES = 12;

/**
 * Break a safety note into one entry per thing it says.
 *
 * Newlines first, because a note that arrives itemised has already told us
 * where its entries are. Sentence boundaries only when the note is a single
 * line, which — the prompt asks for a note, not a list — is the common case.
 *
 * Not exported: only this file reads it, and the panel suites drive it through
 * the rendered component. That is the honest way to test it anyway, since what
 * matters is that an unsplittable note renders whole rather than that a
 * particular string produces a particular array.
 */
function splitGeneralizationNote(note: string): string[] {
	const trimmed = note.trim();
	if (!trimmed) {
		return [];
	}

	const lines = trimmed
		.split(/\r?\n+/)
		.map((line) => line.replace(LIST_MARKER, "").trim())
		.filter((line) => line.length > 0);
	if (lines.length > 1) {
		return lines.length > MAX_ENTRIES ? [trimmed] : lines;
	}

	const single = lines[0] ?? trimmed;
	const entries: string[] = [];
	let start = 0;
	SENTENCE_BOUNDARY.lastIndex = 0;
	let match = SENTENCE_BOUNDARY.exec(single);
	while (match !== null) {
		// The index just past the terminal punctuation, so the entry keeps it.
		const end = match.index + 1;
		const head = single.slice(start, end).trim();
		const tail = single.slice(end).trim();
		const word = single
			.slice(start, match.index)
			.match(WORD_BEFORE_BOUNDARY);
		if (
			head.length >= MIN_ENTRY_CHARACTERS &&
			tail.length >= MIN_ENTRY_CHARACTERS &&
			(word?.[0].length ?? 0) >= MIN_WORD_BEFORE_BOUNDARY
		) {
			entries.push(head);
			start = end;
		}
		match = SENTENCE_BOUNDARY.exec(single);
	}

	const rest = single.slice(start).trim();
	if (rest.length > 0) {
		entries.push(rest);
	}
	return entries.length > MAX_ENTRIES ? [trimmed] : entries;
}

/**
 * The safety note as its own section.
 *
 * `heading` rather than a fixed string: three of the four panels call this
 * "How this was generalized", and the stakeholder email calls it "What the
 * draft wrote around" — the email's note describes what it declined to claim
 * about a release rather than a customer detail it blurred, and the two panels
 * have always said so differently.
 */
export function GeneralizationNotes({
	heading,
	note,
	describesAnotherVersion = false,
}: {
	heading: string;
	note: string;
	/**
	 * Whether the note describes a version the saved draft did not come from.
	 *
	 * The note is read off the LATEST READY generation; the editor beside it
	 * holds the WORKING draft. Those are the same document until a
	 * regeneration nobody adopted, and a different one after — at which point
	 * "Generalized the customer reference" sits beside saved text that still
	 * names them, with nothing saying the sentence is about the other version.
	 *
	 * Its three sibling safety surfaces have been qualified since 2C; this one
	 * never was, against the panels' own header comments claiming every
	 * surface is. The side-by-side is what made it urgent: the vertical order
	 * used to put the note directly under the generated draft it describes,
	 * which was an unstated but correct cue, and a two-column layout leaves
	 * the note equally adjacent to both — while inviting exactly the
	 * comparison that makes attributing it matter.
	 *
	 * Defaulted rather than required so a caller with no versioning to
	 * describe — the short post, whose candidates are never a working draft —
	 * does not have to pass a constant false.
	 */
	describesAnotherVersion?: boolean;
}) {
	const entries = splitGeneralizationNote(note);
	if (entries.length === 0) {
		return null;
	}

	return (
		<section className="space-y-2">
			<h3 className="editorial-label">{heading}</h3>
			{/* ABOVE the entries it qualifies, matching every sibling
			    surface: a reader must learn whose text this describes
			    before reading it, not after. */}
			{describesAnotherVersion ? (
				<p className="text-muted-foreground text-sm leading-relaxed">
					{OTHER_VERSION_NOTE}
				</p>
			) : null}
			{entries.length === 1 ? (
				<p className="text-muted-foreground text-sm leading-relaxed">
					{entries[0]}
				</p>
			) : (
				<ul className="space-y-2">
					{entries.map((entry, index) => (
						<li
							// Position, not text. Two entries can repeat a
							// sentence, and the list is rebuilt wholesale from
							// one string rather than reordered.
							key={`${index}:${entry}`}
							className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm leading-relaxed"
						>
							{entry}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
