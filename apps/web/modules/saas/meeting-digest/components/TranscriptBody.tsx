"use client";

/**
 * Presentational transcript reader (#1899).
 *
 * Split out of TranscriptPane so both the project-meeting sheet (which reads a
 * persisted transcript from the database) and the personal-meeting sheet (which
 * holds a transcript fetched live from Graph and never stored) share one reader
 * — including the line anchoring and screen-reader announcement from #1896.
 *
 * This component is deliberately fetch-free: it receives content. That is what
 * lets the personal path reuse it without acquiring a database dependency.
 */
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExpandButton, ExpandedContentDialog } from "./ExpandedContentDialog";
import { TranscriptDownloadButton } from "./TranscriptDownloadButton";

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
	);
}

export function TranscriptBody({
	content,
	isLoading,
	isError,
	hasTranscript,
	jumpTarget = null,
	filename,
	fullTranscriptHref = null,
	emptyMessage = "No transcript is available for this meeting.",
	showDownload = true,
	expandTitle = "Transcript",
	resetKey = null,
}: {
	content: string;
	isLoading: boolean;
	isError: boolean;
	hasTranscript: boolean;
	jumpTarget?: { line: number; nonce: number } | null;
	filename: string;
	fullTranscriptHref?: string | null;
	emptyMessage?: string;
	// Transcript download is a team-meeting-only feature (#1897). Personal
	// meetings reuse this reader but must not surface the download action, so
	// they pass showDownload={false}.
	showDownload?: boolean;
	// Title for the expanded reading modal (#2108) — the meeting subject
	// where the caller has one.
	expandTitle?: string;
	// Identity of the meeting this transcript belongs to (#2108). When it
	// changes, the expanded modal closes — an explicit guarantee instead of
	// relying on callers happening to unmount this component per meeting
	// (today they do: the Transcript tab unmounts on meeting switch, and the
	// personal sheet gates on `requested` — but a future forceMount would
	// silently reopen the #2387 cross-meeting leak class without this).
	resetKey?: string | null;
}) {
	const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
	const [flashLine, setFlashLine] = useState<number | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const consumedNonceRef = useRef<number | null>(null);
	const [expanded, setExpanded] = useState(false);
	// Adjust-state-during-render (#2387 pattern): a cache-warm meeting switch
	// re-renders with new content synchronously, before any effect could run,
	// so the modal must close in the same render its meeting disappears in.
	const [lastResetKey, setLastResetKey] = useState(resetKey);
	if (resetKey !== lastResetKey) {
		setLastResetKey(resetKey);
		setExpanded(false);
	}

	const lines = useMemo(() => content.split("\n"), [content]);

	// Scroll to + flash the anchored line when a NEW jumpTarget arrives (the
	// nonce makes re-clicking the same line re-fire). `lines` is in the deps so
	// the mount-timing race resolves: on first open jumpTarget can be set
	// before content has loaded (no line refs yet), and the content landing
	// must re-run this. But `lines` also gets a fresh identity on any
	// background refetch while jumpTarget stays non-null — without a guard that
	// would re-scroll and re-flash with NO user action, yanking the pane out
	// from under a reader. The consumed-nonce ref makes those data-only
	// re-renders a no-op. An out-of-range / not-yet-loaded line never marks the
	// nonce consumed, so a later `lines` change retries the lookup.
	useEffect(() => {
		if (!jumpTarget) {
			return;
		}
		if (consumedNonceRef.current === jumpTarget.nonce) {
			return;
		}
		const el = lineRefs.current.get(jumpTarget.line);
		if (!el) {
			return;
		}
		consumedNonceRef.current = jumpTarget.nonce;
		el.scrollIntoView({
			block: "center",
			behavior: prefersReducedMotion() ? "auto" : "smooth",
		});
		setFlashLine(jumpTarget.line);
		const passage = (el.textContent ?? "").trim();
		setAnnouncement(
			passage
				? `Jumped to transcript: ${passage.slice(0, 120)}`
				: "Jumped to the linked transcript passage.",
		);
	}, [jumpTarget, lines]);

	// Clear the flash 1.5s after it lands, in its own effect keyed on
	// `flashLine`, so a re-run of the jump effect can't strand the highlight by
	// cancelling the clear timer without rescheduling it.
	useEffect(() => {
		if (flashLine === null) {
			return;
		}
		const t = setTimeout(() => setFlashLine(null), 1500);
		return () => clearTimeout(t);
	}, [flashLine]);

	// Retract the SR announcement once read, so a stale message isn't
	// re-announced on unrelated re-renders.
	useEffect(() => {
		if (!announcement) {
			return;
		}
		const t = setTimeout(() => setAnnouncement(""), 4000);
		return () => clearTimeout(t);
	}, [announcement]);

	if (!hasTranscript) {
		return <p className="text-muted-foreground">{emptyMessage}</p>;
	}
	if (isLoading) {
		return <p className="text-muted-foreground">Loading transcript…</p>;
	}
	if (isError) {
		return <p className="text-destructive">Failed to load transcript.</p>;
	}

	return (
		<div className="space-y-2">
			{/* Polite live region: voices the landing passage on jump for
			    screen-reader users, who don't perceive the scroll or flash. */}
			<div aria-live="polite" className="sr-only">
				{announcement}
			</div>
			{content.trim().length > 0 && (
				<div className="flex items-center justify-end gap-3">
					{fullTranscriptHref ? (
						<Link
							href={fullTranscriptHref}
							className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
						>
							<ExternalLinkIcon
								className="size-3"
								aria-hidden="true"
							/>
							Open full transcript
						</Link>
					) : null}
					{showDownload ? (
						<TranscriptDownloadButton
							content={content}
							filename={filename}
						/>
					) : null}
					<ExpandButton
						label="Expand transcript"
						onClick={() => setExpanded(true)}
					/>
				</div>
			)}
			<div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap font-sans text-xs text-muted-foreground">
				{lines.map((line, i) => {
					const lineNo = i + 1;
					return (
						<div
							key={i}
							ref={(el) => {
								if (el) {
									lineRefs.current.set(lineNo, el);
								} else {
									lineRefs.current.delete(lineNo);
								}
							}}
							className={
								flashLine === lineNo
									? "min-h-[1rem] transcript-line-flash"
									: "min-h-[1rem]"
							}
						>
							{line}
						</div>
					);
				})}
			</div>
			{/* Expanded reading view (#2108): the same content string, one
			    pre-wrap block — no per-line anchors, no download, no jump
			    wiring. Scrolling and closing only, per the ticket's FR6. */}
			<ExpandedContentDialog
				open={expanded}
				onOpenChange={setExpanded}
				title={expandTitle}
			>
				<div className="whitespace-pre-wrap font-sans text-foreground/80">
					{content}
				</div>
			</ExpandedContentDialog>
		</div>
	);
}
