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
 * ## Round trip
 *
 * The node holds the fence body as its text, exactly as a code block does,
 * and `renderHTML` writes the same `<pre><code class="language-stat-tiles">`
 * that `fromMarkdown` produced. The save rule (`fencedCodeBlocks` in
 * `editor-markdown-save.ts`) turns that back into the fence, so a block comes
 * back byte for byte, valid or not: validity only decides what the view
 * draws, never what the document holds.
 *
 * ## Claiming the fence
 *
 * `MermaidBlock` sniffs the first line of every `<pre>` for a diagram
 * keyword, so a block whose first label is "Timeline savings" or "Pie
 * share" would otherwise become a diagram, and the code block claims any
 * other `<pre>`. ProseMirror tries parse rules in descending `priority`
 * (50 when unset, which both of those use), so the rule here sets a higher
 * one and claims only a `<pre>` whose `<code>` carries the stat tiles
 * language class. A bare `<code>` rule is left out on purpose: a block rule
 * on `<code>` could swallow inline code.
 *
 * ## Opt-in
 *
 * Only the project document editor (both modes) and the Proposal live pane
 * register the node, through `statTiles: true` on the shared extension
 * builders. Every other editor keeps the fence as an ordinary code block of
 * language `stat-tiles`: the code block carries a guard rule at priority 60
 * that claims the fence ahead of the mermaid sniff, so saving never rewrites
 * it as a diagram.
 */

import { PROPOSAL_THEME_CLASSES } from "@repo/utils/proposal-artifact/proposal-theme";
import {
	parseStatTiles,
	STAT_TILES_LANGUAGE,
	type StatTilesParseResult,
} from "@repo/utils/proposal-artifact/stat-tiles";
import { Node } from "@tiptap/core";
import {
	NodeViewContent,
	NodeViewWrapper,
	type ReactNodeViewProps,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";

export const STAT_TILES_NODE_NAME = "statTilesBlock";

/** The class `fromMarkdown` gives the `<code>` of a stat tiles fence. */
const STAT_TILES_CODE_CLASS = `language-${STAT_TILES_LANGUAGE}`;

/**
 * Above the default 50 that `MermaidBlock` and the code block leave their
 * general `<pre>` rules at, and above the code block's stat tiles guard (60),
 * so where this node is registered its rule is tried first.
 */
const STAT_TILES_PARSE_PRIORITY = 70;

/** The diff marks a pending AI edit carries; see `marks` below. */
const DIFF_MARK_NAMES = new Set(["diffInsert", "diffDelete"]);

/**
 * Whether a `<pre>` holds a stat tiles fence. Shared with the code block's
 * guard rule in `tiptap-extensions-advanced.ts`, so both claim the same
 * elements.
 */
export function isStatTilesPre(element: HTMLElement): boolean {
	const code = element.querySelector("code");
	return code?.classList.contains(STAT_TILES_CODE_CLASS) ?? false;
}

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

/**
 * Draws a valid block as tiles and keeps its source one toggle away; an
 * invalid one as its source, with the rule beside it in an editable editor.
 *
 * The source is the node's own content DOM, edited in place like any code
 * block. It stays mounted while the tiles show (ProseMirror needs it to map
 * positions), clipped and hidden from assistive tech so the block is not read
 * twice. It opens whenever the selection is inside the block, so a person who
 * arrows into it never types into text they cannot see, and while a pending
 * AI edit marks it, so the change under review stays visible.
 */
function StatTilesNodeView({
	node,
	editor,
	getPos,
	selectionInside,
}: ReactNodeViewProps) {
	const tEditorTooltips = useTranslations("tooltips.editor");
	const sourceId = useId();
	const [sourceToggled, setSourceToggled] = useState(false);
	const body = node.textContent;
	const parsed = useMemo(() => parseStatTiles(body), [body]);

	let hasPendingDiff = false;
	node.forEach((child) => {
		if (child.marks.some((mark) => DIFF_MARK_NAMES.has(mark.type.name))) {
			hasPendingDiff = true;
		}
	});

	const editable = editor.isEditable;
	const showTiles = parsed.ok && !hasPendingDiff;
	const sourceOpen =
		!showTiles || (editable && (sourceToggled || selectionInside === true));

	const toggleSource = () => {
		if (sourceOpen && selectionInside) {
			// The source stays open while the selection is in it, so closing
			// it selects the block as a whole instead.
			const pos = getPos();
			if (typeof pos === "number") {
				editor.commands.setNodeSelection(pos);
			}
		}
		setSourceToggled(!sourceOpen);
	};

	return (
		<NodeViewWrapper
			className="relative my-4"
			data-stat-tiles=""
			data-valid={parsed.ok ? "true" : "false"}
		>
			{showTiles && (
				<StatTilesList
					items={parsed.items}
					visualId={parsed.visualId}
				/>
			)}
			{/* While an AI change is pending the body holds both its deleted and
			   its inserted text, so a reason read from it would be about neither. */}
			{editable && !parsed.ok && !hasPendingDiff && (
				<output
					contentEditable={false}
					className="mb-1 block text-muted-foreground text-xs"
				>
					{parsed.reason}
				</output>
			)}
			{editable && showTiles && (
				<button
					type="button"
					contentEditable={false}
					aria-expanded={sourceOpen}
					aria-controls={sourceId}
					onClick={toggleSource}
					className="rounded-sm text-muted-foreground text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					{tEditorTooltips("editStatTilesSource")}
				</button>
			)}
			<NodeViewContent<"pre">
				as="pre"
				id={sourceId}
				aria-hidden={sourceOpen ? undefined : true}
				// Clipped rather than removed, so ProseMirror can still map
				// positions into it.
				className={cn(!sourceOpen && "sr-only")}
			/>
		</NodeViewWrapper>
	);
}

export const StatTilesBlock = Node.create({
	name: STAT_TILES_NODE_NAME,

	group: "block",

	content: "text*",

	// The two diff markers only, as the code block and `MermaidBlock` admit:
	// under `marks: ""` a `<del class="diff-del">` inside the fence is dropped
	// on parse while its text survives, so accepting an AI edit of `3` to `7`
	// would save `37`.
	marks: "diffInsert diffDelete",

	code: true,

	defining: true,

	parseHTML() {
		return [
			{
				tag: "pre",
				priority: STAT_TILES_PARSE_PRIORITY,
				preserveWhitespace: "full",
				getAttrs: (node) =>
					isStatTilesPre(node as HTMLElement) ? {} : false,
			},
		];
	},

	renderHTML() {
		return [
			"pre",
			{ "data-language": STAT_TILES_LANGUAGE },
			["code", { class: STAT_TILES_CODE_CLASS }, 0],
		];
	},

	addNodeView() {
		return ReactNodeViewRenderer(StatTilesNodeView, {
			contentDOMElementTag: "code",
		});
	},
});
