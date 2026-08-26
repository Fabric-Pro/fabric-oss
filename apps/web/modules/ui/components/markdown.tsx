"use client";

import { cn } from "@ui/lib";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Shared Markdown renderer.
 *
 * Wraps `react-markdown` + `remark-gfm` in the house
 * `prose prose-sm dark:prose-invert max-w-none` convention so every surface
 * that renders long-form Markdown (proposal descriptions, acceptance criteria,
 * maturation digests, …) looks the same. This is the canonical component the
 * codebase's many inline `<ReactMarkdown remarkPlugins={[remarkGfm]}>` call
 * sites can converge on — those needing a custom `components` map (e.g.
 * `ContextSummaryMarkdown`'s reference-chip links) would first need that
 * escape hatch added here.
 *
 * GFM is enabled (tables, task lists, strikethrough, autolinks). Raw HTML is
 * NOT rendered — `react-markdown` ignores embedded HTML by default and we
 * deliberately do not add `rehype-raw`, so untrusted Markdown cannot inject
 * markup. Callers pass Markdown source as `children` (a string).
 */
export function Markdown({
	children,
	className,
}: {
	children: string;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"prose prose-sm dark:prose-invert max-w-none",
				className,
			)}
		>
			<ReactMarkdown remarkPlugins={[remarkGfm]}>
				{children}
			</ReactMarkdown>
		</div>
	);
}
