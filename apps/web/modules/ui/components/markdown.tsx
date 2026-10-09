"use client";

import { cn } from "@ui/lib";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The typography preset boxes every `code` element as an inline chip (border,
 * background, padding). Inside a fenced block that gave each line its own
 * chip, so the block's `code` is reset and the `pre` carries the box.
 */
const PRE_BLOCK_CLASS =
	"prose-pre:rounded-md prose-pre:border prose-pre:px-4 prose-pre:py-3 prose-pre:border-border prose-pre:bg-muted [&_pre_code]:rounded-none [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0";

/**
 * Shared Markdown renderer.
 *
 * Wraps `react-markdown` + `remark-gfm` in the house
 * `prose prose-sm dark:prose-invert max-w-none` convention so every surface
 * that renders long-form Markdown (proposal descriptions, acceptance criteria,
 * maturation digests, …) looks the same. This is the canonical component the
 * codebase's many inline `<ReactMarkdown remarkPlugins={[remarkGfm, ...remarkPlugins]} components={components}>` call
 * sites can converge on — those needing a custom `components` map (e.g.
 * `ContextSummaryMarkdown`'s reference-chip links) would first need that
 * escape hatch added here.
 *
 * GFM is enabled (tables, task lists, strikethrough, autolinks). Raw HTML is
 * NOT rendered as markup — it is shown as text, and we deliberately do not add
 * `rehype-raw`, so untrusted Markdown cannot inject markup. Callers pass
 * Markdown source as `children` (a string); `components` and `remarkPlugins`
 * let one surface restyle elements or hide node types without forking this.
 */
export function Markdown({
	children,
	className,
	components,
	remarkPlugins = [],
}: {
	children: string;
	className?: string;
	/** Element overrides, for a surface that must wrap or restyle some elements. */
	components?: Components;
	/** Extra remark plugins, run after GFM. */
	remarkPlugins?: NonNullable<Options["remarkPlugins"]>;
}) {
	return (
		<div
			className={cn(
				"prose prose-sm dark:prose-invert max-w-none",
				PRE_BLOCK_CLASS,
				className,
			)}
		>
			<ReactMarkdown
				remarkPlugins={[remarkGfm, ...remarkPlugins]}
				components={components}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}
