"use client";

import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@ui/lib";
import * as React from "react";

/**
 * Contrast notes (WCAG 2.1 1.4.11 — every pair ≥3:1 in BOTH themes, enforced by
 * `apps/web/__tests__/theme-token-contrast.test.ts`; ratios measured at time of
 * writing, for the DEFAULT tokens):
 *
 * - Filled (Range, `--primary`) vs unfilled (Track, `--muted`): ~6.3:1 light,
 *   ~3.8:1 dark. The old pairing (`bg-secondary`, the emerald success colour)
 *   measured 1.34:1 / 2.25:1 — position was carried by hue alone.
 * - Thumb is a solid `--primary` disc with a `--background` border. Over the
 *   unfilled track the disc itself contrasts; over the filled range it would
 *   disappear into it, so the border carries that case instead (~6.8:1 /
 *   ~4.4:1 vs `--primary`). Wherever the thumb sits, one of the two edges
 *   clears the bar — position never rests on hue alone.
 * - Scope: these are the default tokens. OrganizationThemeProvider overrides
 *   `--primary` per org brand, which this test cannot see; brand fills are
 *   measured separately in `org-brand-palette-contrast.test.ts`.
 *
 * The name/aria props go on the THUMB, not the Root: Radix renders
 * role="slider" on the thumb element, so an id or aria-label passed to Root
 * names nothing a screen reader (or getByLabel) can find.
 */
const Slider = React.forwardRef<
	React.ElementRef<typeof SliderPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, id, "aria-label": ariaLabel, ...props }, ref) => (
	<SliderPrimitive.Root
		ref={ref}
		className={cn(
			"relative flex w-full touch-none select-none items-center",
			className,
		)}
		{...props}
	>
		<SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-muted">
			<SliderPrimitive.Range className="absolute h-full bg-primary" />
		</SliderPrimitive.Track>
		<SliderPrimitive.Thumb
			id={id}
			aria-label={ariaLabel}
			className="block h-5 w-5 rounded-full border-2 border-background bg-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
		/>
	</SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
