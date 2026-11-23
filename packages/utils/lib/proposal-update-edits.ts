/**
 * The body edits a proposed update to an existing ticket may write: its own,
 * and never text a model merge added or changed.
 *
 * An update whose body is a whole version of the ticket's body as it is now
 * is written as it is: its edits are exactly what it changes. Any other
 * update is merged into the ticket by a model, and the merge is held to the
 * update: a model rewrite may change lines the update keeps (a figure the
 * update changed once, changed everywhere) or add text nobody proposed. The
 * update's own new detail is never lost: what the merge leaves out is
 * appended unchanged, and the merge counts as fallen back.
 *
 * Lives in `@repo/utils` behind its own subpath: the ticket page's line
 * review and the Temporal apply activity both use it, so the review and
 * "Apply all changes" write the same edits.
 */
import { diffLines, diffWords } from "diff";

type BodyEdit = { from?: string | null; to?: string | null };

/** The description and acceptance-criteria edits of one proposed update. */
export type UpdateBodyEdits = {
	description?: BodyEdit | null;
	acceptanceCriteria?: BodyEdit | null;
};

/** The description and acceptance criteria of a ticket. */
export type UpdateBodies = { description: string; acceptanceCriteria: string };

type BodyField = keyof UpdateBodies;

const BODY_FIELDS: readonly BodyField[] = ["description", "acceptanceCriteria"];

function sameBody(a: string, b: string): boolean {
	const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
	return normalize(a) === normalize(b);
}

/** The non-blank lines of `text`, each with its surrounding spaces trimmed. */
function bodyLines(text: string): string[] {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Whether `proposed` is a whole version of the body `current`, not new
 * detail to merge into it: it keeps more than half of the body's lines as
 * they are.
 */
function wholeVersionOf(proposed: string, current: string): boolean {
	const currentLines = bodyLines(current);
	const proposedLines = new Set(bodyLines(proposed));
	const kept = currentLines.filter((line) => proposedLines.has(line));
	return kept.length * 2 > currentLines.length;
}

/** The bodies the update changes: a `to` other than its `from`. */
function changedFields(update: UpdateBodyEdits): BodyField[] {
	return BODY_FIELDS.filter((field) => {
		const edit = update[field];
		return !!edit?.to && edit.to !== (edit.from ?? "");
	});
}

/**
 * The bodies the update writes by itself, with no merge: when every body it
 * changes is a whole version of the ticket's body as it is now (it has no
 * `from`, or its `from` is the ticket's text). Null when it changes no body,
 * or when a body must be merged into the ticket first.
 */
export function ownEditBodies(
	update: UpdateBodyEdits,
	current: UpdateBodies,
): UpdateBodies | null {
	const changed = changedFields(update);
	const own = (field: BodyField) => {
		const edit = update[field];
		return (
			sameBody(edit?.from ?? current[field], current[field]) &&
			wholeVersionOf(edit?.to ?? "", current[field])
		);
	};
	if (changed.length === 0 || !changed.every(own)) {
		return null;
	}
	const body = (field: BodyField) =>
		changed.includes(field)
			? (update[field]?.to ?? current[field])
			: current[field];
	return {
		description: body("description"),
		acceptanceCriteria: body("acceptanceCriteria"),
	};
}

/**
 * `text` with a line break at its end, so every line diffs as one. An empty
 * body stays empty: it has no line, not one blank line.
 */
function withFinalLineBreak(text: string): string {
	const body = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
	return body ? `${body}\n` : "";
}

const SENTENCE_BREAK = /(?<=[.!?])\s+/;

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** `text` trimmed, without the punctuation that ends it. */
function withoutEndPunctuation(text: string): string {
	return text
		.trim()
		.replace(/[.!?;:,]+$/, "")
		.trimEnd();
}

/**
 * The spans of the update a merge may place inside a longer line: each of
 * its lines and each of their sentences, without end punctuation. A span of
 * fewer than three words says too little to show a line came from the
 * update.
 */
function updateSpans(update: ReadonlySet<string>): string[] {
	const spans = new Set<string>();
	for (const line of update) {
		for (const text of [line, ...line.split(SENTENCE_BREAK)]) {
			const span = withoutEndPunctuation(text);
			if ((span.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3) {
				spans.add(span);
			}
		}
	}
	return [...spans];
}

/** Where `span` stands in `text` as whole words. */
function spanPositions(
	text: string,
	span: string,
): Array<{ span: string; start: number; end: number }> {
	const positions: Array<{ span: string; start: number; end: number }> = [];
	for (
		let start = text.indexOf(span);
		start !== -1;
		start = text.indexOf(span, start + 1)
	) {
		const end = start + span.length;
		if (
			!WORD_CHARACTER.test(text.charAt(start - 1)) &&
			!WORD_CHARACTER.test(text.charAt(end))
		) {
			positions.push({ span, start, end });
		}
	}
	return positions;
}

/**
 * The update spans within which `replacement` holds every word it changes
 * from `gone`: a line the merge rewrote only inside the update's own
 * sentences, as when new detail changes one sentence of a paragraph. Null
 * when a changed word lies outside every span.
 */
function spansReplacedWithin(
	gone: string,
	replacement: string,
	spans: readonly string[],
): string[] | null {
	const text = replacement.trim();
	const positions = spans.flatMap((span) => spanPositions(text, span));
	if (positions.length === 0) {
		return null;
	}
	const placed = new Set<string>();
	let offset = 0;
	for (const part of diffWords(gone.trim(), text)) {
		if (!part.added && !part.removed) {
			offset += part.value.length;
			continue;
		}
		const start =
			offset + part.value.length - part.value.trimStart().length;
		const end = offset + part.value.trimEnd().length;
		// An added word lies inside a span; a removed one is taken out
		// strictly inside it.
		const holder = positions.find((position) =>
			part.added
				? position.start <= start && end <= position.end
				: position.start < offset && offset < position.end,
		);
		if (!holder) {
			return null;
		}
		placed.add(holder.span);
		if (part.added) {
			offset += part.value.length;
		}
	}
	return offset === text.length && placed.size > 0 ? [...placed] : null;
}

/**
 * `merged`, a merge of `current` and an update, with only the edits the
 * update holds. A line the merge adds stays only when the update has it. A
 * line the merge removes goes only when the update does not keep it, and,
 * unless the update is a whole version of the body (`wholeVersion`), when
 * the line the merge put in its place came from the update: new detail
 * does not say which lines it replaces. A replacement comes from the update
 * when it is an update line, or when every word it changes lies inside one
 * of the update's lines or sentences (`placed` lists those). Removed blank
 * lines stay; added ones stay with added text.
 */
function linesWithinUpdate(
	current: string,
	merged: string,
	update: ReadonlySet<string>,
	wholeVersion: boolean,
): { text: string; placed: ReadonlySet<string> } {
	const held = (line: string) => !line.trim() || update.has(line.trim());
	const blocks = changeBlocks(current, merged);
	// A line the update keeps is not rewritten from inside it.
	const spansOf = (
		gone: string | undefined,
		put: string,
		spans: readonly string[],
	) =>
		gone?.trim() && !update.has(gone.trim())
			? spansReplacedWithin(gone, put, spans)
			: null;
	// A span says where it goes only when the merge places it in one line:
	// a sentence that fits many lines (a figure they share) rewrites none.
	const uses = new Map<string, number>();
	const candidates = updateSpans(update);
	for (const block of blocks) {
		if ("kept" in block) {
			continue;
		}
		block.added.forEach((put, index) => {
			if (!put.trim() || held(put)) {
				return;
			}
			for (const span of spansOf(block.removed[index], put, candidates) ??
				[]) {
				uses.set(span, (uses.get(span) ?? 0) + 1);
			}
		});
	}
	const spans = candidates.filter((span) => uses.get(span) === 1);
	const placed = new Set<string>();
	const out: string[] = [];
	let removed: string[] = [];
	let added: string[] = [];
	const flush = () => {
		// A change lists its removed lines, then its added ones: walked side
		// by side, a replaced line is weighed against its replacement and
		// keeps its place.
		const fromUpdate = added.map((put, index) => {
			if (!put.trim()) {
				return false;
			}
			if (held(put)) {
				return true;
			}
			const within = spansOf(removed[index], put, spans);
			for (const span of within ?? []) {
				placed.add(span);
			}
			return within !== null;
		});
		const addsText = fromUpdate.some(Boolean);
		const replacedFromUpdate = (index: number) =>
			index < added.length
				? fromUpdate[index]
				: added.length > 0 && added.every(held);
		const count = Math.max(removed.length, added.length);
		for (let index = 0; index < count; index++) {
			const gone = removed[index];
			if (
				gone !== undefined &&
				(!gone.trim() ||
					update.has(gone.trim()) ||
					!(wholeVersion || replacedFromUpdate(index)))
			) {
				out.push(gone);
			}
			const put = added[index];
			if (
				put !== undefined &&
				addsText &&
				(held(put) || fromUpdate[index])
			) {
				out.push(put);
			}
		}
		removed = [];
		added = [];
	};
	for (const block of blocks) {
		if ("kept" in block) {
			out.push(...block.kept);
		} else {
			removed = block.removed;
			added = block.added;
			flush();
		}
	}
	return { text: out.join("\n"), placed };
}

/**
 * The line diff of `current` and `merged` as runs of kept lines and changes,
 * each change with its removed lines and the added ones that follow them.
 */
function changeBlocks(
	current: string,
	merged: string,
): Array<{ kept: string[] } | { removed: string[]; added: string[] }> {
	const blocks: Array<
		{ kept: string[] } | { removed: string[]; added: string[] }
	> = [];
	let change: { removed: string[]; added: string[] } | null = null;
	for (const part of diffLines(
		withFinalLineBreak(current),
		withFinalLineBreak(merged),
	)) {
		const lines = part.value.replace(/\n$/, "").split("\n");
		if (part.added || part.removed) {
			change ??= { removed: [], added: [] };
			(part.added ? change.added : change.removed).push(...lines);
		} else {
			if (change) {
				blocks.push(change);
				change = null;
			}
			blocks.push({ kept: lines });
		}
	}
	if (change) {
		blocks.push(change);
	}
	return blocks;
}

/**
 * The update's new detail for one body: its own lines that neither the
 * ticket nor the text it was written against (`from`) holds, in its order
 * and unchanged.
 */
function newDetail(edit: BodyEdit | null | undefined, current: string): string {
	const known = new Set([
		...bodyLines(current),
		...bodyLines(edit?.from ?? ""),
	]);
	return (edit?.to ?? "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.filter((line) => !line.trim() || !known.has(line.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * `body` with the lines of `detail` it lacks appended, unchanged, after a
 * blank line: the update's new detail the merge left out. A line the merge
 * placed inside a longer line (`placed`: the line, or each of its
 * sentences) is not lacking.
 */
function withDetailKept(
	body: string,
	detail: string,
	placed: ReadonlySet<string>,
): { text: string; appended: boolean } {
	const present = new Set(bodyLines(body));
	const inPlace = (line: string) =>
		placed.has(withoutEndPunctuation(line)) ||
		line
			.trim()
			.split(SENTENCE_BREAK)
			.every((sentence) => placed.has(withoutEndPunctuation(sentence)));
	const missing = detail
		.split("\n")
		.filter(
			(line) =>
				!line.trim() || !(present.has(line.trim()) || inPlace(line)),
		)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!missing) {
		return { text: body, appended: false };
	}
	return {
		text: body.trim() ? `${body.trimEnd()}\n\n${missing}` : missing,
		appended: true,
	};
}

/** A model merge held to the update (`mergeWithinUpdate`). */
type MergeWithinUpdate = {
	bodies: UpdateBodies;
	/**
	 * The merge left out some of the update's new detail, so it was appended
	 * to the body unchanged: the merge fell back.
	 */
	detailAppended: boolean;
};

/**
 * The bodies a model merge of the update into the ticket may write, held
 * to the update's own text (`linesWithinUpdate`). The update's new detail is
 * never lost: any of it the merge left out, reworded or not at all, is
 * appended to its body unchanged. A body the update does not change stays
 * as it is. Null when the update changes nothing the ticket lacks, so the
 * body is kept.
 */
export function mergeWithinUpdate(
	update: UpdateBodyEdits,
	current: UpdateBodies,
	merged: UpdateBodies,
): MergeWithinUpdate | null {
	const changed = changedFields(update);
	const lines = new Set(
		BODY_FIELDS.flatMap((field) => bodyLines(update[field]?.to ?? "")),
	);
	let detailAppended = false;
	const body = (field: BodyField) => {
		const proposed = update[field]?.to;
		if (!changed.includes(field) || !proposed) {
			return current[field];
		}
		const within = linesWithinUpdate(
			current[field],
			merged[field],
			lines,
			wholeVersionOf(proposed, current[field]),
		);
		const kept = withDetailKept(
			within.text,
			newDetail(update[field], current[field]),
			within.placed,
		);
		detailAppended ||= kept.appended;
		return kept.text;
	};
	const bodies = {
		description: body("description"),
		acceptanceCriteria: body("acceptanceCriteria"),
	};
	return BODY_FIELDS.some((field) => !sameBody(bodies[field], current[field]))
		? { bodies, detailAppended }
		: null;
}

/**
 * The update's body edits read against the ticket as it is now: a body with
 * no `from` becomes the ticket's text and what the update writes into it,
 * its own edits (`ownEditBodies`) or, for new detail, the ticket with that
 * detail appended (`mergeWithinUpdate` with nothing merged). A body with a
 * `from` is kept as it is. A summary of an update without `from` then counts
 * what it changes, not its whole body as added.
 */
export function bodyEditsAgainst(
	update: UpdateBodyEdits,
	current: UpdateBodies,
): UpdateBodyEdits {
	const bodies =
		ownEditBodies(update, current) ??
		mergeWithinUpdate(update, current, current)?.bodies ??
		current;
	const edit = (field: BodyField) => {
		const proposed = update[field];
		return proposed?.to && typeof proposed.from !== "string"
			? { from: current[field], to: bodies[field] }
			: proposed;
	};
	return {
		description: edit("description"),
		acceptanceCriteria: edit("acceptanceCriteria"),
	};
}
