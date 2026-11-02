/**
 * The card grids and two columns of the Proposal's print page (Fizzy #2946),
 * from what `proposal-blocks` parsed out of their fences. Every piece of text
 * reaches the page escaped; a mark adds only its own fixed tag.
 */

import type {
	CardItem,
	ColumnBlock,
	InlineSegment,
} from "@repo/utils/proposal-artifact/proposal-blocks";
import { PROPOSAL_THEME_CLASSES } from "@repo/utils/proposal-artifact/proposal-theme";
import { escapeHtml } from "./print-markup";

const THEME = PROPOSAL_THEME_CLASSES;

/**
 * A run of marked text from a cards or columns block, escaped. Marks nest
 * in one fixed order: bold outside italic, italic outside code.
 */
function segmentsHtml(segments: readonly InlineSegment[]): string {
	return segments
		.map((segment) => {
			let html = escapeHtml(segment.text);
			if (segment.code) {
				html = `<code>${html}</code>`;
			}
			if (segment.italic) {
				html = `<em>${html}</em>`;
			}
			if (segment.bold) {
				html = `<strong>${html}</strong>`;
			}
			return html;
		})
		.join("");
}

/**
 * A card grid: each card's label as written, its title and its text.
 * Exactly three cards share one row.
 */
export function cardsHtml(items: readonly CardItem[]): string {
	const cards = items
		.map((item) => {
			const label = `<p class="${THEME.cardLabel}">${escapeHtml(item.label)}</p>`;
			const title = item.title
				? `<p class="${THEME.cardTitle}">${segmentsHtml(item.title)}</p>`
				: "";
			const text = item.text
				? `<p class="${THEME.cardText}">${segmentsHtml(item.text)}</p>`
				: "";
			return `<div class="${THEME.card}">${label}${title}${text}</div>`;
		})
		.join("");
	const three = items.length === 3 ? ` ${THEME.cardsThree}` : "";
	return `<div class="${THEME.cards}${three}">${cards}</div>`;
}

/**
 * Two columns. A column heading is a styled paragraph, so it never joins
 * the outline or the contents page.
 */
export function columnsHtml(
	columns: readonly [ColumnBlock[], ColumnBlock[]],
): string {
	const blockHtml = (block: ColumnBlock): string => {
		switch (block.type) {
			case "heading":
				return `<p class="${THEME.columnHeading}">${segmentsHtml(block.segments)}</p>`;
			case "list":
				return `<ul>${block.items.map((item) => `<li>${segmentsHtml(item)}</li>`).join("")}</ul>`;
			case "paragraph":
				return `<p>${segmentsHtml(block.segments)}</p>`;
		}
	};
	const column = (blocks: readonly ColumnBlock[]): string =>
		blocks.map(blockHtml).join("");
	const [left, right] = columns;
	return `<div class="${THEME.columns}"><div class="${THEME.column}">${column(left)}</div><div class="${THEME.column}">${column(right)}</div></div>`;
}
