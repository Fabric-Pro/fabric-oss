"use client";

/**
 * TipTap node for a Proposal's stat tiles (Fizzy #2946): a big number with a
 * short label, one to four across.
 *
 * The markdown form is a fenced block owned by
 * `@repo/utils/proposal-artifact/stat-tiles`:
 *
 *   ```stat-tiles
 *   %% fabric-visual: a1b2c3d4e5f6
 *   Faster onboarding: 40%
 *   Pilot sites: 3
 *   ```
 *
 * The node and its view are the shared content fence shell in
 * `tiptap-fenced-block-view.tsx`, which keeps the round trip byte for byte
 * and claims the fence ahead of the mermaid sniff; this module draws the
 * tiles.
 *
 * ## Opt-in
 *
 * Only the project document editor (both modes) and the Proposal live pane
 * register the node, through `statTiles: true` on the shared extension
 * builders. Every other editor keeps the fence as an ordinary code block of
 * language `stat-tiles`: the code block carries a guard rule at priority 60
 * that claims the fence ahead of the mermaid sniff, so saving never rewrites
 * it as a diagram. The guard matches the language in any case and this node
 * only in lower case. The markdown load lowercases a fence's language, so
 * this concerns HTML whose `<code>` class kept its case, such as an AI edit
 * under review that adds a ```` ```Stat-Tiles ```` fence: that stays a code
 * block of its own language in every editor.
 */

import { PROPOSAL_THEME_CLASSES } from "@repo/utils/proposal-artifact/proposal-theme";
import {
	parseStatTiles,
	STAT_TILES_LANGUAGE,
	type StatTilesParseResult,
} from "@repo/utils/proposal-artifact/stat-tiles";
import type { ReactNodeViewProps } from "@tiptap/react";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
	type FencedBlockReading,
	FencedBlockView,
	fencedBlockNode,
} from "./tiptap-fenced-block-view";

export const STAT_TILES_NODE_NAME = "statTilesBlock";

type StatTilesItems = Extract<StatTilesParseResult, { ok: true }>["items"];

function StatTilesList({
	items,
	visualId,
}: {
	items: StatTilesItems;
	visualId: string | null;
}) {
	return (
		<dl
			contentEditable={false}
			className={cn(
				PROPOSAL_THEME_CLASSES.statTiles,
				"not-prose my-4 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3",
			)}
			data-count={items.length}
			data-visual-id={visualId ?? undefined}
		>
			{items.map((item, index) => (
				<div
					// A tile has no identity beyond its line in the block.
					key={index}
					className={cn(
						PROPOSAL_THEME_CLASSES.statTile,
						"flex flex-col-reverse gap-1 rounded-lg border p-4",
					)}
				>
					<dt
						className={cn(
							PROPOSAL_THEME_CLASSES.statLabel,
							"text-muted-foreground text-sm",
						)}
					>
						{item.label}
					</dt>
					<dd
						className={cn(
							PROPOSAL_THEME_CLASSES.statValue,
							"m-0 break-words font-semibold text-2xl tabular-nums",
						)}
					>
						{item.value}
					</dd>
				</div>
			))}
		</dl>
	);
}

function readStatTiles(body: string): FencedBlockReading {
	const parsed = parseStatTiles(body);
	if (!parsed.ok) {
		return parsed;
	}
	return {
		ok: true,
		drawing: (
			<StatTilesList items={parsed.items} visualId={parsed.visualId} />
		),
	};
}

function StatTilesNodeView(props: ReactNodeViewProps) {
	const tEditorTooltips = useTranslations("tooltips.editor");
	const body = props.node.textContent;
	const reading = useMemo(() => readStatTiles(body), [body]);
	return (
		<FencedBlockView
			{...props}
			reading={reading}
			toggleLabel={tEditorTooltips("editStatTilesSource")}
			wrapperAttributes={{ "data-stat-tiles": "" }}
		/>
	);
}

export const StatTilesBlock = fencedBlockNode({
	name: STAT_TILES_NODE_NAME,
	language: STAT_TILES_LANGUAGE,
	view: StatTilesNodeView,
});
