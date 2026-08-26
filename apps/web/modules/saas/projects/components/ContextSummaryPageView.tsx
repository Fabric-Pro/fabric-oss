/**
 * ContextSummaryPageView — dedicated full-page, read-only reader for a
 * project's compressed context summary.
 *
 * Modeled on `MeetingTranscriptPageView`: sticky breadcrumb header with a
 * back-arrow, a serif page h1 hero with an editorial uppercase label and a
 * "Summary" badge, a metadata line, and a wide prose column that renders the
 * full summary markdown via `ReactMarkdown` + `remark-gfm`. A comfortable
 * reading width (`max-w-4xl`) replaces the cramped dialog.
 *
 * Purely presentational server component (no `"use client"`, no hooks): it
 * receives a pre-fetched plain-JSON view model from the server route, so first
 * paint is the data paint. Editorial aesthetic per CLAUDE.md — serif headings,
 * warm-neutral cards, design tokens only, `motion-safe:` transitions.
 */

import { Badge } from "@ui/components/badge";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import {
	ContextSummaryMarkdown,
	type SummaryReference,
} from "./ContextSummaryMarkdown";
import { ContextSummaryReaderActions } from "./ContextSummaryReaderActions";

type ContextSummaryViewData = {
	projectId: string;
	projectName: string;
	content: string;
	/** ISO string — the watermark up to which this summary stands in for raw. */
	coveredThrough: string;
	coveredContextCount: number;
	/** ISO string. */
	updatedAt: string;
	/** Summary row id + tenancy — for authorized reference drill-down. */
	summaryId: string;
	organizationId: string | null;
	/** Source-level references cited by the summary (may be empty for legacy). */
	references: SummaryReference[];
};

type Props = {
	summary: ContextSummaryViewData;
	/** Full path back to the project's context tab. */
	backHref: string;
};

function formatDate(iso: string): string | null {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return date.toLocaleDateString(undefined, {
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}

export function ContextSummaryPageView({ summary, backHref }: Props) {
	const generatedOn = formatDate(summary.updatedAt);
	const coveredThrough = formatDate(summary.coveredThrough);
	const sourceCount = summary.coveredContextCount;
	const hasContent = summary.content.trim().length > 0;

	return (
		<div className="flex w-full flex-col">
			<a
				href="#context-summary-main"
				className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-md focus:ring-2 focus:ring-ring"
			>
				Skip to main content
			</a>

			{/* Sticky breadcrumb header — mirrors the transcript / URL-source readers. */}
			<div className="sticky top-0 z-10 border-b border-border bg-background">
				<div className="flex w-full items-center gap-3 px-6 py-3">
					<Link
						href={backHref}
						aria-label="Back to project context"
						className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground motion-safe:transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<ArrowLeftIcon className="size-4" aria-hidden="true" />
					</Link>

					<nav
						aria-label="Breadcrumb"
						className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground text-sm"
					>
						<Link
							href={backHref}
							className="hover:text-foreground hover:underline"
						>
							Projects
						</Link>
						<span aria-hidden="true">›</span>
						<Link
							href={backHref}
							className="truncate hover:text-foreground hover:underline"
						>
							{summary.projectName}
						</Link>
						<span aria-hidden="true">›</span>
						<Link
							href={backHref}
							className="hover:text-foreground hover:underline"
						>
							Context
						</Link>
						<span aria-hidden="true">›</span>
						<span className="text-foreground">Summary</span>
					</nav>
				</div>
			</div>

			{/* Hero block */}
			<header className="border-b border-border">
				<div className="mx-auto w-full max-w-4xl px-6 py-8">
					<div className="min-w-0 space-y-3">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div className="flex items-center gap-2">
								<p
									id="context-summary-eyebrow"
									className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
								>
									Context Summary
								</p>
								<Badge variant="secondary">Summary</Badge>
							</div>
							{/* Admin edit + history controls (client island) */}
							<ContextSummaryReaderActions
								projectId={summary.projectId}
								organizationId={summary.organizationId}
								summaryId={summary.summaryId}
								content={summary.content}
								references={summary.references}
							/>
						</div>
						<h1
							className="font-serif text-3xl font-normal leading-tight tracking-tight text-foreground sm:text-4xl"
							aria-describedby="context-summary-eyebrow"
						>
							{summary.projectName}
						</h1>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
							{generatedOn && (
								<span>Generated {generatedOn}</span>
							)}
							<span aria-hidden="true">·</span>
							<span>
								{sourceCount} source
								{sourceCount === 1 ? "" : "s"} compressed
							</span>
							{coveredThrough && (
								<>
									<span aria-hidden="true">·</span>
									<span>
										Covered through {coveredThrough}
									</span>
								</>
							)}
						</div>
						<p className="text-muted-foreground/80 text-xs">
							A read-only, AI-generated compression of this
							project's older context. The raw sources remain
							available on the Context tab.
						</p>
					</div>
				</div>
			</header>

			{/* Body */}
			<main
				id="context-summary-main"
				className="mx-auto w-full max-w-4xl px-6 py-8"
			>
				<h2 className="sr-only">Summary</h2>
				{hasContent ? (
					<article className="prose prose-stone dark:prose-invert max-w-none rounded-xl border border-border bg-card p-8 prose-headings:font-serif prose-headings:font-normal prose-pre:overflow-auto prose-pre:border prose-pre:border-border prose-pre:bg-muted">
						<ContextSummaryMarkdown
							content={summary.content}
							references={summary.references}
							projectId={summary.projectId}
							summaryId={summary.summaryId}
							organizationId={summary.organizationId}
						/>
					</article>
				) : (
					<div className="rounded-xl border border-border bg-muted/30 p-8 text-center text-muted-foreground text-sm">
						This summary has no content yet.
					</div>
				)}
			</main>
		</div>
	);
}
