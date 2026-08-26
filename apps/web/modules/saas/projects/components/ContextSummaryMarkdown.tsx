"use client";

/**
 * Client renderer for a context summary's markdown that turns the engine's
 * inline `[S#]` citation markers into clickable reference chips. Each chip opens
 * a popover that lazily resolves the ORIGINAL source (raw context row or
 * decision) via the authorized `projects.contexts.resolveSummaryReference`
 * procedure — the staff drill-down path. Raw sources are never mutated; this is
 * a read-only window onto them.
 *
 * Markers are surfaced without fragile mdast surgery: each known `[S#]` is
 * rewritten to a sentinel link `[S#](#ref-S#)` before rendering, and the `a`
 * component override renders those as chips (leaving real links untouched).
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type SummaryReference = {
	marker: string;
	sourceType: string;
	sourceId: string;
	sourceTimestamp: string;
	label?: string;
};

type Props = {
	content: string;
	references: SummaryReference[];
	projectId: string;
	summaryId: string;
	organizationId: string | null;
};

const REF_HREF_PREFIX = "#ref-";
const MARKER_PATTERN = /\[(S\d+)\](?!\()/g;

function formatTimestamp(iso: string): string | null {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function ReferenceChip({
	reference,
	projectId,
	summaryId,
	organizationId,
}: {
	reference: SummaryReference;
	projectId: string;
	summaryId: string;
	organizationId: string | null;
}) {
	const [open, setOpen] = useState(false);
	const resolved = useQuery(
		orpc.projects.contexts.resolveSummaryReference.queryOptions({
			input: {
				projectId,
				summaryId,
				sourceId: reference.sourceId,
				organizationId,
			},
			enabled: open,
			staleTime: 5 * 60 * 1000,
		}),
	);

	const timestamp = formatTimestamp(reference.sourceTimestamp);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={`View source ${reference.marker}${reference.label ? `: ${reference.label}` : ""}`}
					className="mx-0.5 inline-flex items-center rounded-sm bg-primary/10 px-1 align-baseline font-medium text-[0.7em] text-primary no-underline motion-safe:transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					{reference.marker}
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-80 max-w-[min(90vw,20rem)] space-y-2 text-sm"
			>
				<div className="flex items-center gap-2">
					<Badge variant="secondary" className="text-[0.7rem]">
						{reference.sourceType}
					</Badge>
					{timestamp && (
						<span className="text-muted-foreground text-xs">
							{timestamp}
						</span>
					)}
				</div>
				{reference.label && (
					<p className="font-medium text-foreground">
						{reference.label}
					</p>
				)}
				<div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-muted-foreground text-xs">
					{resolved.isLoading && "Loading source…"}
					{resolved.isError && "This source is no longer available."}
					{resolved.data?.reference?.content?.trim() ||
						(resolved.isSuccess ? "(empty source)" : "")}
				</div>
				{resolved.data?.reference?.sourceUrl && (
					<a
						href={resolved.data.reference.sourceUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-block text-primary text-xs hover:underline"
					>
						Open original source ↗
					</a>
				)}
			</PopoverContent>
		</Popover>
	);
}

export function ContextSummaryMarkdown({
	content,
	references,
	projectId,
	summaryId,
	organizationId,
}: Props) {
	const refByMarker = useMemo(() => {
		const map = new Map<string, SummaryReference>();
		for (const ref of references) {
			map.set(ref.marker, ref);
		}
		return map;
	}, [references]);

	// Rewrite known markers to sentinel links so ReactMarkdown parses them as
	// anchors we intercept; unknown markers are left as plain text.
	const prepared = useMemo(
		() =>
			content.replace(MARKER_PATTERN, (match, marker: string) =>
				refByMarker.has(marker)
					? `[${marker}](${REF_HREF_PREFIX}${marker})`
					: match,
			),
		[content, refByMarker],
	);

	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={{
				a({ href, children, node: _node, ...props }) {
					if (
						typeof href === "string" &&
						href.startsWith(REF_HREF_PREFIX)
					) {
						const marker = href.slice(REF_HREF_PREFIX.length);
						const reference = refByMarker.get(marker);
						if (reference) {
							return (
								<ReferenceChip
									reference={reference}
									projectId={projectId}
									summaryId={summaryId}
									organizationId={organizationId}
								/>
							);
						}
						return <>{children}</>;
					}
					return (
						<a href={href} {...props}>
							{children}
						</a>
					);
				},
			}}
		>
			{prepared}
		</ReactMarkdown>
	);
}
