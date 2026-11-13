import type { CSSProperties } from "react";

/**
 * Text in a stage's or status's own colour (Fizzy #1444).
 *
 * The stage colours (`DRAFTING_STAGE_META`, `MATURATION_STATUS_META`) are
 * mid-tone fills — amber `#F59E0B`, emerald `#10B981` — chosen for dots and
 * progress segments, and they measured 2.2-3.8:1 when the same value was used
 * as the label's text colour. The `stage-ink` utility in globals.css derives a
 * readable ink from the colour instead: mixed toward black in light mode and
 * toward white in dark mode, in OKLab so the hue stays recognisable. Pair the
 * class with this style; fills keep using the raw colour.
 *
 * Guarded by `stage-ink-contrast.test.ts`, which measures every stage colour's
 * ink on every surface in both themes.
 */
export function stageInkStyle(color: string): CSSProperties {
	return { "--stage-color": color } as CSSProperties;
}

/** The mix ratios `stage-ink` uses; the contrast test reads them from here. */
export const STAGE_INK_MIX = { light: 0.6, dark: 0.6 } as const;
