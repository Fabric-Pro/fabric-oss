/**
 * Acceptance criteria: the single parser, and the "AC N" numbering everything
 * downstream agrees on.
 *
 * There used to be two implementations — `parseAcceptanceCriteria` for the QA
 * traceability matrix and `countAcceptanceCriteria` for the test-case drafter's
 * per-criterion cap — each carrying a comment telling the next reader to keep
 * them in lock-step. They drifted anyway: an H3-grouped prose spec read as two
 * criteria in the matrix and zero in the drafter, and the parity test that caught
 * it could only ever cover the blobs somebody thought to add.
 *
 * So there is one implementation, here, and `countAcceptanceCriteria` is its
 * length. A third consumer (the PR review lens, the pull-request review work) is the reason this
 * finally moved: a rule that needs a guard test to stay true in two places will
 * not survive three.
 *
 * Lives in `@repo/utils` behind its own subpath rather than the barrel: it is
 * pure string work with no dependencies, and it is imported by a CLIENT
 * component (the QA panel) as well as by server code, so it must not drag the
 * barrel's Node built-ins into the browser bundle.
 */

export interface ParsedCriterion {
	/** 1-based position, matching the drafter's "AC N" counting. */
	index: number;
	text: string;
}

/**
 * A line that opens a criterion by naming it — `AC1 - …`, `AC 2: …`, `AC3.` …
 *
 * Specs written this way carry the numbering in the prose instead of in list
 * markers, and consecutive lines with no bullets and no blank lines between them
 * used to fold into ONE criterion: a feature with eight criteria rendered a
 * single matrix row labelled "AC 1" whose text was all eight concatenated, and
 * every case that named AC2..AC8 fell into the unmapped bucket because there was
 * no row to attach to.
 *
 * Deliberately strict, because every loosening splits prose that only mentions a
 * criterion. It must start at column 0 — an indented line is a continuation of
 * the item above it — and must be followed by text on the same line, so a
 * sentence that wraps just before "AC 3." keeps its next line instead of the
 * marker eating it.
 */
const AC_MARKER = /^AC\s*\d+\s*[-–—:.)][^\S\r\n]+(?=\S)/i;

/**
 * Split the acceptance-criteria markdown into ordered criteria.
 *
 * Primary shape: top-level list items (bulleted or numbered), with indented or
 * bare continuation lines folded into the current item. Lines that open with an
 * `AC N` marker start a criterion the same way a list marker does. When the blob
 * has neither (e.g. blank-line-separated Given/When/Then blocks), each
 * non-heading paragraph becomes a criterion instead.
 */
export function parseAcceptanceCriteria(
	markdown: string | null | undefined,
): ParsedCriterion[] {
	if (!markdown?.trim()) {
		return [];
	}
	const lines = markdown.split(/\r?\n/);
	const items: string[] = [];
	let current: string[] | null = null;
	let sawListItem = false;
	/** Whether an `AC N` marker has opened a criterion yet — see the branch below. */
	let sawAcMarker = false;
	/**
	 * Column of the shallowest list marker seen so far — the top-level criteria
	 * column. Anything indented past it is a CommonMark sub-bullet and belongs to
	 * its parent criterion; minting one criterion per sub-clause inflated the
	 * matrix and pushed every later "AC N" ref onto the wrong row.
	 */
	let topIndent: number | null = null;

	const flush = () => {
		if (current) {
			const text = current.join(" ").trim();
			// A criterion must say something: an item that carries no letter or
			// digit (stray emphasis markers, bullet debris) is markdown noise,
			// not a testable statement.
			if (/[\p{L}\p{N}]/u.test(text)) {
				items.push(text);
			}
			current = null;
		}
	};

	for (const line of lines) {
		if (/^\s{0,3}([*_-])\s*(?:\1\s*){2,}$/.test(line)) {
			// Thematic break (`* * *`, `---`, `___`). Without this, the bullet
			// regex below reads `* * *` as marker `*` + content `* *` and mints
			// a phantom criterion — observed live as an "AC N: * *" matrix row.
			flush();
			continue;
		}
		if (/^\s{0,3}#{1,2}\s/.test(line)) {
			// Criteria END at the first H1/H2 AFTER content: the AC column
			// stores everything after the spec's "## Acceptance Criteria"
			// heading, so sibling sections ("## Release Planning") leak in and
			// would otherwise read as criteria. A LEADING H1/H2 (before any
			// content) is a heading OF the criteria and is skipped. H3+
			// headings are sub-GROUPS ("### Muting") and never terminate.
			if (items.length > 0 || current !== null || sawListItem) {
				break;
			}
			flush();
			continue;
		}
		// An `AC N` marker opens a criterion the way a list marker does. Checked
		// before the list branch because an unbulleted marker line is the shape
		// that used to collapse; a BULLETED one (`- AC1 - …`) is handled by the
		// list branch, which strips the redundant marker from its text.
		const acMatch = line.match(AC_MARKER);
		if (acMatch) {
			if (!sawAcMarker) {
				sawAcMarker = true;
				// Everything before the first marker is preamble — a sentence of
				// context under the "Acceptance Criteria" heading. Kept as a
				// criterion it would take row 1 and push AC1 to row 2, so a case
				// tagged "AC 2" would attach to the row holding AC1's text: a
				// confident wrong answer, worse than the unmapped bucket. Only
				// paragraph-mode preamble is dropped; a spec that mixes real
				// bullets with markers keeps its bullets.
				if (!sawListItem) {
					items.length = 0;
				}
			}
			flush();
			sawListItem = true;
			current = [line.slice(acMatch[0].length).trim()];
			continue;
		}

		// `\d+\\?[.)]` tolerates an escaped ordered marker (`38\\. GIVEN …`).
		// A markdown serializer escapes the period when a list item has lost
		// its list role upstream; without this the whole section silently
		// collapses into paragraph mode and every "AC N" reference shifts.
		const listMatch = line.match(/^(\s*)(?:[-*+]|\d+\\?[.)])\s+(.*)$/);
		if (listMatch) {
			const indent = listMatch[1].length;
			const text = listMatch[2];
			if (topIndent === null || indent < topIndent) {
				topIndent = indent;
			}
			if (indent > topIndent) {
				// Sub-bullet: fold into the criterion it qualifies. When a blank
				// line already closed that criterion, re-open it rather than
				// dropping the clause on the floor.
				if (current) {
					current.push(text);
				} else if (items.length > 0) {
					items[items.length - 1] =
						`${items[items.length - 1]} ${text}`.trim();
				}
				continue;
			}
			flush();
			sawListItem = true;
			// The matrix labels every row "AC N" from its position, so an item
			// repeating its own marker reads "AC 1  AC1 - …". Only at top level:
			// a sub-bullet folds into a DIFFERENT row, where the number it names
			// is not that row's position and dropping it would lose the reference.
			current = [text.replace(AC_MARKER, "")];
			continue;
		}
		if (/^\s{0,3}#{3,6}\s/.test(line)) {
			// Sub-group headings separate criteria; they are never criterion text.
			flush();
			continue;
		}
		if (!line.trim()) {
			// A blank line ends a paragraph block; inside a list it just ends the
			// current item's continuation run.
			flush();
			continue;
		}
		if (current) {
			current.push(line.trim());
		} else if (!sawListItem) {
			// Paragraph mode — only while no list has been seen, so stray prose
			// after a list doesn't mint phantom criteria.
			current = [line.trim()];
		}
	}
	flush();

	return items.map((text, i) => ({ index: i + 1, text }));
}

/**
 * A criterion as a reader should SEE it, rather than as it is stored.
 *
 * `ParsedCriterion.text` is deliberately raw: the drafter and the review lens
 * put it straight into prompts, where `**Given**` costs nothing. The
 * traceability matrix renders it as text, so the same string arrived on screen
 * with its asterisks showing — every Given/When/Then criterion read as
 * `**Given** a feature ticket has… **When** the AI agent…`.
 *
 * Worse, criteria synced from a PM tool can carry a trailing backlink, so one
 * row ended in a literal `<p><a href="…">View in Fabric</a></p>`.
 *
 * Only emphasis pairs are unwrapped. A lone `*` is left alone: it is as likely
 * to be a footnote marker or a literal in a spec as it is to be markdown, and
 * eating it would silently change what a criterion says.
 */
export function criterionDisplayText(text: string): string {
	return text
		.replace(/<[^>]+>/g, " ")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/__(.+?)__/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Resolve a free-text criterion ref ("AC 3", "Covers AC 3", "criterion 2") to
 * its 1-based index — the first integer in the string. `null` when the ref is
 * empty or carries no number (→ unmapped bucket).
 */
export function criterionIndexFromRef(
	ref: string | null | undefined,
): number | null {
	const match = ref?.match(/\d+/);
	if (!match) {
		return null;
	}
	const index = Number.parseInt(match[0], 10);
	return index >= 1 ? index : null;
}

/**
 * Trim an acceptance-criteria blob at the first H1/H2 that follows content.
 *
 * The AC column stores EVERYTHING after the spec's "## Acceptance Criteria"
 * heading, so operational sections drafted below it ("## Release Planning",
 * "## Release Notes", …) leak in and read as criteria. Criteria genuinely end at
 * the first H1/H2 inside the blob; H3+ headings are sub-groups OF the criteria
 * ("### Muting", "### Digest Emails") and must not terminate it. A LEADING H1/H2
 * — before any content — is a heading OF the criteria and does not bound.
 *
 * {@link parseAcceptanceCriteria} applies the same rule inline while walking, so
 * it does not call this. Exported because the drafter also needs the bounded TEXT
 * to put in a prompt, not just the parsed list.
 */
export function boundAcceptanceCriteria(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	let sawContent = false;
	let boundary = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s{0,3}#{1,2}\s/.test(line)) {
			if (sawContent) {
				boundary = i;
				break;
			}
			continue;
		}
		if (line.trim() && !/^\s{0,3}#{3,6}\s/.test(line)) {
			sawContent = true;
		}
	}
	return boundary === -1
		? markdown
		: lines.slice(0, boundary).join("\n").trimEnd();
}

/**
 * How many criteria the blob carries — the drafter sizes `maxTestCases` from
 * this so per-criterion coverage stays satisfiable.
 *
 * Defined as the parser's length rather than as its own scan. That is the whole
 * point of this module: the count and the numbering cannot disagree if there is
 * only one thing computing them.
 */
export function countAcceptanceCriteria(markdown: string): number {
	return parseAcceptanceCriteria(markdown).length;
}
