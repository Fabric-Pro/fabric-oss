/**
 * Deterministic repair for markdown structure broken by AI editing.
 *
 * When the document AI edits a large spec under heavy context, it sometimes
 * emits markdown whose *structure* is broken even though the prose is intact —
 * most visibly it splits an inline token across a bullet boundary. Two of these
 * breakages don't just look wrong, they defeat a parser:
 *
 *   - a bold marker split across two bullets (`**Dependency*` + `*: …`), which
 *     renders as literal asterisks instead of bold, and
 *   - an Open Question split across two bullets (`- Q: What` + `- icon…?`),
 *     which breaks the Summary & Questions parser (it expects one `- Q:` per
 *     question).
 *
 * This pass repairs ONLY those two mechanical breakages. It is deliberately
 * narrow: each rule fires only on markdown that is genuinely malformed — a
 * shape clean content cannot produce — and it hardcodes no document vocabulary,
 * so it is safe to run on the output of every document type. Everything else is
 * copied through verbatim; clean markdown round-trips unchanged (covered by
 * tests). Purely cosmetic degradations (e.g. a nested label flattened to the
 * top level) are intentionally left to the prompt layer rather than guessed at
 * here, where a wrong guess would corrupt a legitimately-different document.
 */

interface ParsedBullet {
	indent: string;
	marker: string;
	gap: string;
	content: string;
}

const BULLET_RE = /^(\s*)([-*])(\s+)(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;

function parseBullet(line: string): ParsedBullet | null {
	const m = line.match(BULLET_RE);
	if (!m) {
		return null;
	}
	return { indent: m[1], marker: m[2], gap: m[3], content: m[4] };
}

function renderBullet(b: ParsedBullet): string {
	return `${b.indent}${b.marker}${b.gap}${b.content}`;
}

type MergeKind = "concat" | "space" | null;

/**
 * Decide whether `cur` is the broken-off tail of `prev` and, if so, how to
 * rejoin them. Returns null (the default) unless `prev`+`cur` form one of the
 * two malformed shapes above — so any well-formed pair of bullets is left alone.
 */
function decide(prev: ParsedBullet, cur: ParsedBullet): MergeKind {
	// Bold marker split across a bullet boundary: `**X*` + `*: Y` → `**X**: Y`.
	// `**X*` (an opened bold closed by a single stray `*`) is malformed on its
	// own, and the following bullet starting with `*` supplies the other half.
	if (/\*\*[^*]+\*$/.test(prev.content) && cur.content.startsWith("*")) {
		return "concat";
	}
	// Open Question split across two bullets. A `- Q:` question that does not end
	// in `?` is malformed per the parser's contract; rejoin it ONLY when `cur`
	// clearly completes it — a lowercase fragment, at the SAME indent level, that
	// itself ends in `?` and is not a new `- Q:`. These guards keep two genuinely
	// separate items (an uppercase or non-question next bullet, or a differently
	// nested one) from ever being merged.
	if (
		/^Q:\s/.test(prev.content) &&
		!prev.content.trimEnd().endsWith("?") &&
		cur.indent.length === prev.indent.length &&
		/^[a-z]/.test(cur.content) &&
		cur.content.trimEnd().endsWith("?") &&
		!/^Q:\s/.test(cur.content)
	) {
		return "space";
	}
	return null;
}

export function repairDegradedMarkdown(markdown: string): string {
	if (!markdown.trim()) {
		return markdown;
	}

	const lines = markdown.split("\n");
	const out: string[] = [];
	let inFence = false;
	let lastBulletIdx = -1;

	for (const raw of lines) {
		if (FENCE_RE.test(raw)) {
			inFence = !inFence;
			out.push(raw);
			lastBulletIdx = -1;
			continue;
		}
		if (inFence) {
			out.push(raw);
			continue;
		}

		const parsed = parseBullet(raw);
		if (!parsed) {
			out.push(raw);
			// A blank line keeps the current list context (loose lists); any
			// other prose/heading ends it.
			if (raw.trim() !== "") {
				lastBulletIdx = -1;
			}
			continue;
		}

		if (lastBulletIdx >= 0) {
			const prev = parseBullet(out[lastBulletIdx]);
			const kind = prev ? decide(prev, parsed) : null;
			if (prev && kind) {
				// Drop the blank separator(s) between the two bullets, then fold
				// this bullet's content into the previous one.
				while (
					out.length - 1 > lastBulletIdx &&
					out[out.length - 1].trim() === ""
				) {
					out.pop();
				}
				const sep = kind === "concat" ? "" : " ";
				prev.content = `${prev.content}${sep}${parsed.content}`;
				out[lastBulletIdx] = renderBullet(prev);
				continue;
			}
		}

		out.push(renderBullet(parsed));
		lastBulletIdx = out.length - 1;
	}

	return out.join("\n");
}
