"use client";

/**
 * TipTap nodes for a Proposal's card grids and two columns (Fizzy #2946).
 *
 * The markdown forms are fenced blocks owned by
 * `@repo/utils/proposal-artifact/proposal-blocks`:
 *
 *   ```cards
 *   01
 *   **Route planning**
 *   Plans each day's stops before the first truck leaves.
 *   ```
 *
 *   ```columns
 *   ### Today
 *   - Paper route sheets
 *   ---
 *   ### With the platform
 *   One schedule every depot reads.
 *   ```
 *
 * Both are the shared content fence shell in `tiptap-fenced-block-view.tsx`,
 * as the stat tiles node is, which keeps the round trip byte for byte and
 * claims each fence ahead of the mermaid sniff; this module draws the forms.
 *
 * ## Opt-in
 *
 * Both nodes ride the stat tiles opt-in (`statTiles: true` on the shared
 * extension builders): only the project document editor of a client
 * Proposal and the Proposal live pane register them. Every other editor
 * keeps the fence as an ordinary code block of its language, through the
 * code block's guard rule, so saving never rewrites it as a diagram. The
 * guard matches the language in any case and these nodes only in lower case.
 * The markdown load lowercases a fence's language, so this concerns HTML
 * whose `<code>` class kept its case, such as an AI edit under review that
 * adds a ```` ```Cards ```` or ```` ```Columns ```` fence: that stays a code
 * block of its own language in every editor.
 *
 * ## Inline marks
 *
 * Titles, text, headings, bullets and paragraphs arrive as segments of plain
 * text with their marks. They render as React text inside `<strong>`, `<em>`
 * and `<code>`, so markup typed into a card stays text.
 */

import {
	CARDS_LANGUAGE,
	type CardItem,
	COLUMNS_LANGUAGE,
	type ColumnBlock,
	type InlineSegment,
	parseCards,
	parseColumns,
} from "@repo/utils/proposal-artifact/proposal-blocks";
import { PROPOSAL_THEME_CLASSES } from "@repo/utils/proposal-artifact/proposal-theme";
import type { ReactNodeViewProps } from "@tiptap/react";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { type ReactNode, useMemo } from "react";
import {
	type FencedBlockReading,
	FencedBlockView,
	fencedBlockNode,
} from "./tiptap-fenced-block-view";

export const CARDS_NODE_NAME = "cardsBlock";

export const COLUMNS_NODE_NAME = "columnsBlock";

/** The number of cards that share one row instead of two per row. */
const CARDS_IN_ONE_ROW = 3;

/** One segment's text, wrapped in an element per mark it carries. */
function Segment({ segment }: { segment: InlineSegment }) {
	let content: ReactNode = segment.text;
	if (segment.code) {
		content = <code>{content}</code>;
	}
	if (segment.italic) {
		content = <em>{content}</em>;
	}
	if (segment.bold) {
		content = <strong>{content}</strong>;
	}
	return content;
}

/** A run of inline segments as React text and mark elements. */
function InlineSegments({ segments }: { segments: readonly InlineSegment[] }) {
	return segments.map((segment, index) => (
		// A segment has no identity beyond its place in the run.
		<Segment key={index} segment={segment} />
	));
}

/** A card grid: two cards a row, three when there are exactly three. */
function CardsGrid({
	items,
	visualId,
}: {
	items: readonly CardItem[];
	visualId: string | null;
}) {
	const oneRow = items.length === CARDS_IN_ONE_ROW;
	return (
		<div
			contentEditable={false}
			className={cn(
				PROPOSAL_THEME_CLASSES.cards,
				oneRow && PROPOSAL_THEME_CLASSES.cardsThree,
				"not-prose my-4 grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3",
			)}
			data-count={items.length}
			data-visual-id={visualId ?? undefined}
		>
			{items.map((item, index) => (
				<div
					// A card has no identity beyond its place in the block.
					key={index}
					className={cn(
						PROPOSAL_THEME_CLASSES.card,
						"flex flex-col gap-1 rounded-lg border p-4",
					)}
				>
					<p
						className={cn(
							PROPOSAL_THEME_CLASSES.cardLabel,
							"m-0 font-mono text-muted-foreground text-xs uppercase tracking-wider",
						)}
					>
						{item.label}
					</p>
					{item.title && (
						<p
							className={cn(
								PROPOSAL_THEME_CLASSES.cardTitle,
								"m-0 font-semibold",
							)}
						>
							<InlineSegments segments={item.title} />
						</p>
					)}
					{item.text && (
						<p
							className={cn(
								PROPOSAL_THEME_CLASSES.cardText,
								"m-0 text-sm",
							)}
						>
							<InlineSegments segments={item.text} />
						</p>
					)}
				</div>
			))}
		</div>
	);
}

/**
 * One block of a column. A heading is a styled paragraph, not a heading
 * element, so it never joins the document outline.
 */
function ColumnBlockView({ block }: { block: ColumnBlock }) {
	if (block.type === "heading") {
		return (
			<p
				className={cn(
					PROPOSAL_THEME_CLASSES.columnHeading,
					"m-0 font-semibold",
				)}
			>
				<InlineSegments segments={block.segments} />
			</p>
		);
	}
	if (block.type === "list") {
		return (
			<ul className="m-0 list-disc pl-5">
				{block.items.map((item, index) => (
					// A bullet has no identity beyond its place in the list.
					<li key={index}>
						<InlineSegments segments={item} />
					</li>
				))}
			</ul>
		);
	}
	return (
		<p className="m-0">
			<InlineSegments segments={block.segments} />
		</p>
	);
}

/** Two columns side by side, the side before the `---` line first. */
function ColumnsPair({
	columns,
	visualId,
}: {
	columns: readonly [ColumnBlock[], ColumnBlock[]];
	visualId: string | null;
}) {
	return (
		<div
			contentEditable={false}
			className={cn(
				PROPOSAL_THEME_CLASSES.columns,
				"not-prose my-4 grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-6",
			)}
			data-visual-id={visualId ?? undefined}
		>
			{columns.map((blocks, index) => (
				<div
					// The left column, then the right one.
					key={index}
					className={cn(
						PROPOSAL_THEME_CLASSES.column,
						"flex flex-col gap-2",
					)}
				>
					{blocks.map((block, blockIndex) => (
						// A block has no identity beyond its place in the
						// column.
						<ColumnBlockView key={blockIndex} block={block} />
					))}
				</div>
			))}
		</div>
	);
}

function readCards(body: string): FencedBlockReading {
	const parsed = parseCards(body);
	if (!parsed.ok) {
		return parsed;
	}
	return {
		ok: true,
		drawing: <CardsGrid items={parsed.items} visualId={parsed.visualId} />,
	};
}

function readColumns(body: string): FencedBlockReading {
	const parsed = parseColumns(body);
	if (!parsed.ok) {
		return parsed;
	}
	return {
		ok: true,
		drawing: (
			<ColumnsPair columns={parsed.columns} visualId={parsed.visualId} />
		),
	};
}

/** A form's view: its own reading of the body in the shared shell. */
function ProposalBlockNodeView({
	form,
	read,
	...props
}: ReactNodeViewProps & {
	form: typeof CARDS_LANGUAGE | typeof COLUMNS_LANGUAGE;
	read: (body: string) => FencedBlockReading;
}) {
	const tEditorTooltips = useTranslations("tooltips.editor");
	const body = props.node.textContent;
	const reading = useMemo(() => read(body), [read, body]);
	return (
		<FencedBlockView
			{...props}
			reading={reading}
			toggleLabel={tEditorTooltips("editBlockSource")}
			wrapperAttributes={{ "data-proposal-block": form }}
		/>
	);
}

function CardsNodeView(props: ReactNodeViewProps) {
	return (
		<ProposalBlockNodeView
			{...props}
			form={CARDS_LANGUAGE}
			read={readCards}
		/>
	);
}

function ColumnsNodeView(props: ReactNodeViewProps) {
	return (
		<ProposalBlockNodeView
			{...props}
			form={COLUMNS_LANGUAGE}
			read={readColumns}
		/>
	);
}

export const CardsBlock = fencedBlockNode({
	name: CARDS_NODE_NAME,
	language: CARDS_LANGUAGE,
	view: CardsNodeView,
});

export const ColumnsBlock = fencedBlockNode({
	name: COLUMNS_NODE_NAME,
	language: COLUMNS_LANGUAGE,
	view: ColumnsNodeView,
});
