import type { RetrievedContext } from "@repo/rag";

// Measured on the serialized activity result, leaving room below the 12k
// summarizer threshold for the engine's tool-result envelope.
const RESULT_CHARS = 10_000;
const SEPARATOR = "\n\n---\n\n";
const REFERENCE_CUT_NOTE =
	"\n[Summary reference list was cut; citation markers may not be resolvable from this result.]";

/** Reserve every source opening, then spend spare room by passage relevance. */
export function compactProjectContextPassages(
	results: RetrievedContext[],
	header: string,
	contextMetaHeader: (context: RetrievedContext) => string,
): { context: string; chunkCount: number } {
	const blocks = results.map((r, i) => {
		const source =
			r.sourcePath ||
			r.filename ||
			r.sourceTitle ||
			r.sourceUrl ||
			(r.metadata?.filename as string | undefined) ||
			`Context ${i + 1}`;
		const summary =
			r.type === "PROJECT_SUMMARY" || r.metadata?.isSummary === true;
		const matched = Boolean(r.matchedPassages?.length);
		const parent = r.metadata?.parentContextId;
		const readableId =
			typeof parent === "string" && parent.trim()
				? parent
				: !summary &&
						!r.metadata?.pageUrl &&
						!r.metadata?.conversationBundleId
					? r.id
					: undefined;
		const extent = matched
			? "Matched passages only."
			: summary
				? "Showing the start of the summary."
				: "Showing the start of the document.";
		const note = readableId
			? `${extent} Read the full source with fabric_get_project_source({"source":${JSON.stringify(readableId)}}).`
			: `${extent} This result id cannot be read by the project source tool.`;
		const referencesAt = summary
			? r.content.indexOf("SOURCE REFERENCES")
			: -1;
		const dividerAt =
			referencesAt >= 0 ? r.content.lastIndexOf("---", referencesAt) : -1;
		const splitAt = dividerAt >= 0 ? dividerAt : referencesAt;
		const body =
			splitAt >= 0 ? r.content.slice(0, splitAt).trimEnd() : r.content;
		const references = splitAt >= 0 ? r.content.slice(splitAt) : "";

		const passages = (
			r.matchedPassages?.length
				? r.matchedPassages
				: [{ content: body, score: r.score }]
		).map((p) => ({ ...p, characters: Array.from(p.content) }));
		return {
			header: `### From: ${source}\nResult id: ${r.id}\n${contextMetaHeader(r)}${note}\n`,
			passages,
			matched,
			// Code points avoid cutting an astral character. The budget itself is
			// measured in serialized UTF-16 units, including JSON escaping.
			shown: passages.map(() => 0),
			references,
			tail: references ? `\n\n${REFERENCE_CUT_NOTE}` : "",
		};
	});
	const omittedNote =
		"\n[Content omitted to fit the result budget; use the full-source route above where available.]";
	let omittedBlocks = 0;
	const render = () => ({
		context: `${header}\n\n${blocks
			.map((b) => {
				const text = b.passages
					.map((p, i) => p.characters.slice(0, b.shown[i]).join(""))
					.filter(Boolean)
					.join("\n\n");
				const cut = b.passages.some(
					(p, i) => b.shown[i] < p.characters.length,
				);
				return b.header + text + (cut ? omittedNote : "") + b.tail;
			})
			.join(
				SEPARATOR,
			)}${omittedBlocks ? `\n[${omittedBlocks} source blocks omitted because their headers exceed the result budget; narrow the search to retrieve them.]` : ""}`,
		chunkCount: blocks.length,
	});
	const size = () => JSON.stringify(render()).length;
	// Exceptional metadata can itself exceed the budget. Name dropped blocks.
	while (blocks.length && size() > RESULT_CHARS) {
		blocks.pop();
		omittedBlocks++;
	}
	if (size() > RESULT_CHARS) {
		return {
			context:
				"[Search metadata exceeds the result budget; narrow the search.]",
			chunkCount: 0,
		};
	}
	const extend = (
		index: number,
		passage: number,
		cap: number,
		budget = RESULT_CHARS,
	) => {
		const block = blocks[index];
		let low = block.shown[passage];
		const full = block.passages[passage].characters.length;
		let high = Math.min(full, cap);
		// Completing a block removes its omission note. Check that discontinuity
		// first; all remaining prefix sizes are monotone.
		block.shown[passage] = high;
		if (size() <= budget) {
			return;
		}
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			block.shown[passage] = mid;
			if (size() <= budget) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		block.shown[passage] = low;
	};
	// Every header and omission marker is already reserved. Share the opening
	// budget equally, before either ranked or fallback bodies can extend.
	const openingBudget = Math.max(
		0,
		Math.floor((RESULT_CHARS - size()) / Math.max(1, blocks.length) / 2),
	);
	for (let i = 0; i < blocks.length; i++) {
		extend(i, 0, 800, size() + openingBudget);
	}
	// A trailer is atomic: reserve the complete legend when it fits alongside
	// all openings, otherwise keep the explicit reference-cut warning.
	for (const block of blocks) {
		if (!block.references) {
			continue;
		}
		block.tail = `\n\n${block.references}`;
		if (size() > RESULT_CHARS) {
			block.tail = `\n\n${REFERENCE_CUT_NOTE}`;
		}
	}
	const ranked = blocks
		.flatMap((b, index) =>
			b.matched
				? b.passages.map((p, passage) => ({
						index,
						passage,
						score: p.score,
					}))
				: [],
		)
		.sort((a, b) => b.score - a.score);
	const progress = () => JSON.stringify(blocks.map((b) => [b.shown, b.tail]));
	let before: string;
	do {
		before = progress();
		for (const p of ranked) {
			extend(p.index, p.passage, Number.MAX_SAFE_INTEGER);
		}
		for (let i = 0; i < blocks.length; i++) {
			if (!blocks[i].matched) {
				extend(i, 0, Number.MAX_SAFE_INTEGER);
			}
		}
		// A cut trailer can use otherwise idle room after all bodies. Keep its
		// warning until the entire trailer fits, and count that warning too.
		for (const block of blocks) {
			if (!block.references || block.tail === `\n\n${block.references}`) {
				continue;
			}
			block.tail = `\n\n${block.references}`;
			if (size() <= RESULT_CHARS) {
				continue;
			}
			const chars = Array.from(block.references);
			let low = 0;
			let high = chars.length;
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				block.tail = `\n\n${chars.slice(0, mid).join("")}${REFERENCE_CUT_NOTE}`;
				if (size() <= RESULT_CHARS) {
					low = mid;
				} else {
					high = mid - 1;
				}
			}
			block.tail = `\n\n${chars.slice(0, low).join("")}${REFERENCE_CUT_NOTE}`;
		}
		// Finishing a block removes its omission marker and may free room for
		// an earlier block. Revisit priorities until no content can grow.
	} while (progress() !== before);

	return render();
}
