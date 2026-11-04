/** A source opening and its scored passages, in final result order. */
export interface PassageBlock {
	header: string;
	passages: Array<{ content: string; score: number }>;
	matched: boolean;
	references?: string;
}

const REFERENCE_CUT_NOTE =
	"\n[Summary reference list was cut; citation markers may not be resolvable from this result.]";

/** Share openings, then extend by result order or passage relevance within the budget. */
export function packPassageBlocks<T>(
	input: PassageBlock[],
	options: {
		maxChars: number;
		/** Spend by result order first, then passage score within each result. */
		prioritizeResultOrder?: boolean;
		omittedNote: string;
		render: (blocks: string[], omittedBlocks: number) => T;
		measure: (output: T) => number;
		metadataOverflow: T;
	},
): T {
	const budgetChars = options.maxChars;
	if (
		!Number.isSafeInteger(budgetChars) ||
		budgetChars < options.measure(options.metadataOverflow)
	) {
		throw new RangeError(
			"Passage budget must be a safe integer large enough for the metadata warning",
		);
	}
	const blocks = input.map((b) => ({
		...b,
		passages: b.passages.map((p) => ({
			...p,
			characters: Array.from(p.content),
		})),
		shown: b.passages.map(() => 0),
		tail: b.references ? `\n\n${REFERENCE_CUT_NOTE}` : "",
	}));
	let omittedBlocks = 0;
	const render = () =>
		options.render(
			blocks.map((b) => {
				const text = b.passages
					.map((p, i) => p.characters.slice(0, b.shown[i]).join(""))
					.filter(Boolean)
					.join("\n\n");
				const cut = b.passages.some(
					(p, i) => b.shown[i] < p.characters.length,
				);
				return (
					b.header + text + (cut ? options.omittedNote : "") + b.tail
				);
			}),
			omittedBlocks,
		);
	const size = () => options.measure(render());
	// Exceptional metadata can itself exceed the budget. Name dropped blocks.
	while (blocks.length && size() > budgetChars) {
		blocks.pop();
		omittedBlocks++;
	}
	if (size() > budgetChars) {
		return options.metadataOverflow;
	}
	const extend = (
		index: number,
		passage: number,
		cap: number,
		budget = budgetChars,
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
	// Remaining headers and omission markers are reserved. Share the opening
	// budget equally, before either ranked or fallback bodies can extend.
	const openingBudget = Math.max(
		0,
		Math.floor((budgetChars - size()) / Math.max(1, blocks.length) / 2),
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
		if (size() > budgetChars) {
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
		.sort(
			(a, b) =>
				(options.prioritizeResultOrder ? a.index - b.index : 0) ||
				b.score - a.score,
		);
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
			if (size() <= budgetChars) {
				continue;
			}
			const chars = Array.from(block.references);
			let low = 0;
			let high = chars.length;
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				block.tail = `\n\n${chars.slice(0, mid).join("")}${REFERENCE_CUT_NOTE}`;
				if (size() <= budgetChars) {
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
