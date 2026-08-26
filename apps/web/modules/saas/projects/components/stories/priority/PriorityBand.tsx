"use client";

import { cn } from "@ui/lib";
import type { StoryPriority } from "../../../lib/stories/types";

/**
 * The visual language for a priority band.
 *
 * A band is the most scannable thing on a Priority row — it is what someone
 * reads first when they open the list to decide what to do next. Rendering it
 * as plain grey label text (the first cut of this view) made every row look
 * identical and the whole surface read as empty; the severity has to be visible
 * without reading the words.
 *
 * Colour: P0 reads red (danger), P1 amber (warning), P2/P3 neutral so raising
 * something actually stands out — a list where every band shouts has no
 * priorities.
 *
 * The classes deliberately mirror the shared `Badge` component's status
 * variants (`warning`/`error`/`info`): a theme-split scale — darker text in
 * light mode, lighter in dark, over a 10%/20% tint of the same hue. The
 * single-value semantic tokens (`--destructive`, `--highlight`) can't clear
 * WCAG AA (4.5:1) for 10px text on their own tints — same-hue text on same-hue
 * fill is too low-contrast — whereas this two-shade pattern does, and it keeps
 * the chip visually consistent with every other status pill in the app.
 *
 * The chip renders over bg-card (rows) AND bg-background (history/digest
 * dialogs), so AA must hold over BOTH. P1 light uses amber-800, one step
 * darker than the Badge scale — amber-700 on the amber tint composited over
 * --background measured ~4.33:1, under the bar. Measured over both surfaces:
 * all eight states ≥ 4.5:1.
 */
const BAND_STYLES: Record<StoryPriority, string> = {
	P0_CRITICAL:
		"border-red-500/30 bg-red-500/10 text-red-700 dark:bg-red-500/20 dark:text-red-400",
	P1_HIGH:
		"border-amber-500/35 bg-amber-500/10 text-amber-800 dark:bg-amber-500/20 dark:text-amber-400",
	P2_MEDIUM: "border-border bg-muted text-muted-foreground",
	P3_LOW: "border-border/60 bg-muted/60 text-muted-foreground",
};

/** Short form for the chip; the full label lives in the accessible name. */
const BAND_SHORT: Record<StoryPriority, string> = {
	P0_CRITICAL: "P0",
	P1_HIGH: "P1",
	P2_MEDIUM: "P2",
	P3_LOW: "P3",
};

const BAND_WORD: Record<StoryPriority, string> = {
	P0_CRITICAL: "Critical",
	P1_HIGH: "High",
	P2_MEDIUM: "Medium",
	P3_LOW: "Low",
};

export function priorityBandLabel(priority: StoryPriority): string {
	return `${BAND_SHORT[priority]} · ${BAND_WORD[priority]}`;
}

/**
 * A priority band chip.
 *
 * `interactive` renders it as a button (the row's "change this" affordance)
 * rather than a static span — same visual, so the band never moves or resizes
 * between a member who can edit and one who cannot.
 */
export function PriorityBand({
	priority,
	/** Hide the word on very narrow viewports, keeping "P0" always visible. */
	responsive = true,
	className,
}: {
	priority: StoryPriority;
	responsive?: boolean;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 font-semibold text-[10px] uppercase tracking-wider tabular-nums",
				BAND_STYLES[priority],
				className,
			)}
		>
			{/* The visible pieces collapse to just "P0" below `sm`, so the full
			    label is REAL sr-only text — not an aria-label, which on a
			    role-less span is "naming prohibited" and skipped by screen
			    readers in browse mode. Real text is announced everywhere the
			    chip appears (trail hops, digest rows, read-only rows) and still
			    feeds name-from-contents when a button wraps the chip. The two
			    visible spans stay aria-hidden so the abbreviation is never read
			    on top of it. */}
			<span aria-hidden>{BAND_SHORT[priority]}</span>
			<span aria-hidden className={cn(responsive && "hidden sm:inline")}>
				{BAND_WORD[priority]}
			</span>
			<span className="sr-only">{priorityBandLabel(priority)}</span>
		</span>
	);
}
