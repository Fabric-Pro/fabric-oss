/**
 * MeetingTranscriptPageView — dedicated full-page, read-only reader for a
 * single Microsoft Teams meeting transcript.
 *
 * Spec: 2026-06-23-meeting-transcript-viewer §5.4.
 *
 * Modeled on `UrlSourcePageView`: sticky breadcrumb header with a back-arrow,
 * a serif page h1 hero with an editorial uppercase label, a metadata line, and
 * a wide prose column that renders the full transcript markdown via
 * `ReactMarkdown` + `remark-gfm` (handles 30k+ chars scrollably, no overflow).
 *
 * Unlike `UrlSourcePageView` this view is purely presentational — there are NO
 * edit / annotate / comment / re-sync controls (FR-4, read-only). It receives a
 * pre-fetched, plain-JSON view model from the server route (first paint is the
 * data paint — no client query waterfall), so it is a server component (no
 * `"use client"`, no hooks).
 *
 * Editorial aesthetic (CLAUDE.md / D7):
 *  - Serif page h1 (`font-serif`).
 *  - Editorial section labels (uppercase, `tracking-[0.2em]`, `text-muted-foreground`).
 *  - Warm-neutral cards (`bg-card border border-border`).
 *  - No glassmorphism, no gradient-on-data, no hardcoded hex.
 *  - Transitions wrapped in `motion-safe:`.
 *
 * Summarized banner (D2 / AC3): when `wasSummarized` is true a prominent,
 * tokenized banner renders ABOVE the body conveying — in text, not icon-only —
 * that the stored content is an AI summary, not the full conversation. The
 * summary still renders below.
 */

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { ArrowLeftIcon, InfoIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TranscriptDeepLinkHighlighter } from "./TranscriptDeepLinkHighlighter";

/**
 * Plain-JSON view model fed by the server route. Defined here so the server
 * page can pass plain props without dragging Prisma types across the
 * server/client boundary.
 */
export type MeetingTranscriptViewData = {
	id: string;
	projectId: string;
	projectName: string;
	meetingSubject: string | null;
	/** ISO string or null. */
	meetingDate: string | null;
	speakerNames: string[];
	wasSummarized: boolean;
	content: string;
	/** ISO string. */
	syncedAt: string;
};

type Props = {
	transcript: MeetingTranscriptViewData;
	/** Full path back to the project's context tab, e.g. `/app/proj/projects/abc?tab=context`. */
	backHref: string;
};

function EditorialLabel({
	children,
	id,
}: {
	children: React.ReactNode;
	id?: string;
}) {
	return (
		<p
			id={id}
			className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
		>
			{children}
		</p>
	);
}

/** Format an ISO date string as a readable absolute date, or `null` if absent/invalid. */
function formatMeetingDate(iso: string | null): string | null {
	if (!iso) {
		return null;
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return date.toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

export function MeetingTranscriptPageView({ transcript, backHref }: Props) {
	const displayTitle = transcript.meetingSubject || "Meeting transcript";
	const meetingDate = formatMeetingDate(transcript.meetingDate);
	const speakerCount = transcript.speakerNames.length;
	const hasContent = transcript.content.trim().length > 0;

	return (
		<div className="flex w-full flex-col">
			{/* Skip-to-main-content link for keyboard users. */}
			<a
				href="#meeting-transcript-main"
				className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-md focus:ring-2 focus:ring-ring"
			>
				Skip to main content
			</a>

			{/* Sticky header strip — full-width app-shell bar with the back link
			    + breadcrumb. Mirrors UrlSourcePageView's chrome. */}
			<div className="sticky top-0 z-10 border-b border-border bg-background">
				<div className="flex w-full items-center gap-3 px-6 py-3">
					<Link
						href={backHref}
						aria-label="Back to project contexts"
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
							className="hover:text-foreground hover:underline"
						>
							{transcript.projectName}
						</Link>
						<span aria-hidden="true">›</span>
						<Link
							href={backHref}
							className="hover:text-foreground hover:underline"
						>
							Context
						</Link>
						<span aria-hidden="true">›</span>
						<span className="truncate text-foreground">
							{displayTitle}
						</span>
					</nav>
				</div>
			</div>

			{/* Hero block */}
			<header className="border-b border-border">
				<div className="mx-auto w-full max-w-4xl px-6 py-8">
					<div className="min-w-0 space-y-3">
						<EditorialLabel id="meeting-transcript-eyebrow">
							Meeting Transcript
						</EditorialLabel>
						<h1
							className="font-serif text-3xl font-normal leading-tight tracking-tight text-foreground sm:text-4xl"
							aria-describedby="meeting-transcript-eyebrow"
						>
							{displayTitle}
						</h1>
						<div
							className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm"
							data-testid="meeting-transcript-metadata"
						>
							{meetingDate ? (
								<span>{meetingDate}</span>
							) : (
								<span className="text-muted-foreground/70">
									Date unavailable
								</span>
							)}
							{speakerCount > 0 && (
								<>
									<span aria-hidden="true">·</span>
									<span className="inline-flex items-center gap-1.5">
										<UsersIcon
											className="size-3.5 shrink-0"
											aria-hidden="true"
										/>
										{speakerCount} participant
										{speakerCount === 1 ? "" : "s"}
									</span>
								</>
							)}
						</div>
						{speakerCount > 0 && (
							<p className="text-muted-foreground/80 text-xs">
								<span className="sr-only">Participants: </span>
								{transcript.speakerNames.join(", ")}
							</p>
						)}
					</div>
				</div>
			</header>

			{/* Body */}
			<main
				id="meeting-transcript-main"
				className="mx-auto w-full max-w-4xl px-6 py-8"
			>
				<section
					className="min-w-0 space-y-6"
					aria-labelledby="meeting-transcript-content-heading"
					data-testid="meeting-transcript-main-column"
				>
					<h2
						id="meeting-transcript-content-heading"
						className="sr-only"
					>
						Transcript
					</h2>

					{/* Summarized banner (D2 / AC3) — informational, not an
					    error. Meaning is conveyed in text; the icon is decorative
					    (aria-hidden) and the title/description carry the message. */}
					{transcript.wasSummarized && (
						<Alert
							variant="warning"
							data-testid="meeting-transcript-summarized-banner"
						>
							<InfoIcon aria-hidden="true" />
							<AlertTitle>
								Summarized — not the full transcript
							</AlertTitle>
							<AlertDescription>
								This meeting was synced before Fabric kept long
								transcripts in full, so only an AI summary of it
								exists. The original wording is not recoverable.
								Meetings synced since then are stored whole.
							</AlertDescription>
						</Alert>
					)}

					{hasContent ? (
						<article
							className="prose prose-stone dark:prose-invert max-w-none rounded-xl border border-border bg-card p-8 prose-pre:overflow-auto prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-headings:font-serif prose-headings:font-normal"
							data-testid="meeting-transcript-markdown"
						>
							<ReactMarkdown remarkPlugins={[remarkGfm]}>
								{transcript.content}
							</ReactMarkdown>
							{/* #1896: scroll to + highlight the line named by a
							    `#t-<line>` deep link (e.g. the digest's "Open
							    full transcript" link). */}
							<TranscriptDeepLinkHighlighter
								content={transcript.content}
							/>
						</article>
					) : (
						<div
							className="rounded-xl border border-border bg-muted/30 p-8 text-center text-muted-foreground text-sm"
							data-testid="meeting-transcript-empty"
						>
							<p className="font-medium text-foreground/80">
								Transcript content is unavailable.
							</p>
							<p className="mt-1 text-xs">
								The stored transcript body could not be loaded.
							</p>
						</div>
					)}
				</section>
			</main>
		</div>
	);
}
