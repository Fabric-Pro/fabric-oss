"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@ui/lib";
import * as React from "react";

function TooltipProvider({
	delayDuration = 500,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
	return (
		<TooltipPrimitive.Provider
			data-slot="tooltip-provider"
			delayDuration={delayDuration}
			{...props}
		/>
	);
}

function Tooltip({
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
	return (
		<TooltipProvider>
			<TooltipPrimitive.Root data-slot="tooltip" {...props} />
		</TooltipProvider>
	);
}

function TooltipTrigger({
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
	return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

type TooltipSurface = "inverse" | "popover";

/**
 * The `inverse` surface paints `--foreground` as its background, so a child
 * carrying an ordinary theme text token (`text-muted-foreground`,
 * `text-primary`, …) resolves against the *page* palette and lands at roughly
 * 2.2:1 (dark) / 2.6:1 (light) — well under the 4.5:1 AA floor.
 *
 * Re-pointing Tailwind's `--color-*` namespace on the content element makes
 * those utilities resolve against the tooltip's own palette instead, so the
 * ~50 call sites that nest themed children stay legible without each having to
 * opt into `surface="popover"`.
 *
 * The `--color-*` namespace is load-bearing. Tailwind v4 resolves
 * `--color-muted-foreground: var(--muted-foreground)` once at `:root`, so
 * overriding the raw `--muted-foreground` further down the tree is a no-op
 * (verified against the deployed build, 2026-07-20).
 *
 * Inside this element `var(--foreground)` is the tooltip's background and
 * `var(--background)` is its text colour — the inversion is what makes one
 * formula work in both themes. Accents keep 35% of their own hue so amber
 * still reads as amber; the remaining 65% is the guaranteed-legible text
 * colour, which is what carries the contrast (measured 7.1:1 dark, 10.9:1
 * light for `--highlight`).
 */
const INVERSE_TOKEN_OVERRIDES = {
	"--color-foreground": "var(--background)",
	"--color-popover-foreground": "var(--background)",
	"--color-card-foreground": "var(--background)",
	"--color-muted-foreground":
		"color-mix(in srgb, var(--background) 72%, var(--foreground))",
	"--color-border":
		"color-mix(in srgb, var(--background) 30%, var(--foreground))",
	"--color-muted":
		"color-mix(in srgb, var(--foreground) 85%, var(--background))",
	"--color-primary":
		"color-mix(in srgb, var(--primary) 35%, var(--background))",
	"--color-highlight":
		"color-mix(in srgb, var(--highlight) 35%, var(--background))",
	"--color-destructive":
		"color-mix(in srgb, var(--destructive) 35%, var(--background))",
	"--color-secondary":
		"color-mix(in srgb, var(--secondary) 35%, var(--background))",
	"--color-success":
		"color-mix(in srgb, var(--success) 35%, var(--background))",
} as React.CSSProperties;

function TooltipContent({
	className,
	sideOffset = 0,
	surface = "inverse",
	style,
	children,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
	/**
	 * `"inverse"` (default) — high-contrast `bg-foreground / text-background`
	 * pill used for short single-line hints.
	 *
	 * `"popover"` — the standard popover surface (`bg-popover /
	 * text-popover-foreground` + border). Prefer it for genuinely rich
	 * tooltips: legend rows, multi-paragraph descriptions, anything that
	 * reads as a small card rather than a hint.
	 *
	 * Legibility is no longer the reason to reach for it. `inverse` used to
	 * render themed children invisible, so rich content had to opt out; that
	 * is now handled centrally by `INVERSE_TOKEN_OVERRIDES` above and both
	 * surfaces clear WCAG AA. This prop is a presentation choice.
	 */
	surface?: TooltipSurface;
}) {
	const isPopover = surface === "popover";
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				data-surface={surface}
				sideOffset={sideOffset}
				style={
					isPopover ? style : { ...INVERSE_TOKEN_OVERRIDES, ...style }
				}
				className={cn(
					// `max-w` is a default, not a ceiling: `cn()` runs tailwind-merge, so a
					// call site passing its own `max-w-*` still wins. 20rem matches the value
					// ~60 sites had already picked by hand; the 90vw term keeps the box inside
					// the viewport on narrow screens.
					// `text-pretty` (not `text-balance`) so line 1 fills the available width —
					// balancing left long copy wrapping short of the cap.
					"animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit max-w-[min(90vw,20rem)] origin-(--radix-tooltip-content-transform-origin) rounded-md text-xs text-pretty break-words",
					isPopover
						? "border border-border/60 bg-popover text-popover-foreground shadow-md px-3 py-2"
						: // Painted with arbitrary `var(--foreground)` / `var(--background)` rather
							// than `bg-foreground` / `text-background` on purpose. Those utilities
							// compile to `var(--color-foreground)` / `var(--color-background)`, and
							// `INVERSE_TOKEN_OVERRIDES` re-points `--color-foreground` on *this same
							// element* — so the surface would repaint itself with its own text colour
							// and render every default tooltip at 1.00:1. Reading the raw theme
							// variables keeps the surface out of the remapped namespace.
							"bg-[var(--foreground)] text-[var(--background)] px-3 py-1.5",
					className,
				)}
				{...props}
			>
				{children}
				<TooltipPrimitive.Arrow
					className={cn(
						"z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]",
						isPopover
							? "fill-popover bg-popover border border-border/60"
							: // Same reason as the surface above: the arrow is a descendant, so it
								// inherits the remapped `--color-foreground` and would fill with the
								// tooltip's text colour instead of its background.
								"bg-[var(--foreground)] fill-[var(--foreground)]",
					)}
				/>
			</TooltipPrimitive.Content>
		</TooltipPrimitive.Portal>
	);
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
