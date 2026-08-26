"use client";

import { useIsOverflowing } from "@shared/hooks/use-is-overflowing";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { createElement, type ReactNode } from "react";

/** Inline-text tags this primitive can render as. */
type TruncatedTextTag = "span" | "p" | "div" | "h2" | "h3" | "h4";

export type TruncatedTextProps = {
	/**
	 * The full plain-text value. It is the tooltip body, the accessible name,
	 * and what overflow is measured against. When no `children` are given it is
	 * also the visible content. Rendered on a single line and clipped with an
	 * ellipsis; when too wide to fit, the full value is revealed in a tooltip on
	 * hover and on keyboard focus.
	 */
	text: string;
	/** Element tag to render. Defaults to `"span"`. */
	as?: TruncatedTextTag;
	/**
	 * Extra classes for the rendered element. `truncate` is always applied by
	 * the component, so callers pass only typography / width / spacing
	 * utilities (e.g. `font-semibold text-sm`, `max-w-[260px]`).
	 */
	className?: string;
	/** Tooltip placement. Defaults to `"bottom"`. */
	side?: "top" | "bottom" | "left" | "right";
	/**
	 * Optional rich visible content (e.g. a bold prefix). When provided it
	 * replaces `text` as what is shown, but `text` is still used for the
	 * tooltip, the accessible name, and overflow measurement — so the plain
	 * string must mirror the visible text.
	 */
	children?: ReactNode;
};

/**
 * A single-line label that clips overflowing text with an ellipsis and reveals
 * the full value in a tooltip — but only when the text actually doesn't fit.
 *
 * Composes the shared `useIsOverflowing` measurement hook with the standard
 * tooltip primitive, mirroring the established in-app pattern: the tooltip is
 * hard-disabled (`open={false}`) while the text fits, so short labels never
 * gain a redundant hover hint or a stray tab stop. When the text is clipped,
 * the element joins the tab order so keyboard users can focus it to read the
 * full value (WCAG 2.1 AA). The full value is also exposed as the element's
 * accessible name so assistive tech always announces the untruncated text.
 */
export function TruncatedText({
	text,
	as = "span",
	className,
	side = "bottom",
	children,
}: TruncatedTextProps) {
	const [overflowRef, isOverflowing] = useIsOverflowing<HTMLElement>(text);

	return (
		<Tooltip open={isOverflowing ? undefined : false}>
			<TooltipTrigger asChild>
				{createElement(
					as,
					{
						ref: overflowRef,
						// `min-w-0` lets the element shrink below its content
						// width when it's a flex/grid child — without it the
						// `truncate` never engages (a long unbroken string would
						// instead expand the element and blow out its container).
						className: cn("min-w-0 truncate", className),
						"aria-label": text,
						// Only a clipped label needs to be reachable for its
						// reveal — a label that already fits must not add
						// keyboard-navigation noise.
						tabIndex: isOverflowing ? 0 : undefined,
					},
					children ?? text,
				)}
			</TooltipTrigger>
			<TooltipContent
				side={side}
				className="max-w-[min(90vw,640px)] text-wrap break-words"
			>
				{text}
			</TooltipContent>
		</Tooltip>
	);
}
