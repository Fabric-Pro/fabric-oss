"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ActionItemList } from "./ActionItemList";
import {
	ExpandButton,
	ExpandedContentDialog,
	PanelExpandButton,
	panelWidthClass,
} from "./ExpandedContentDialog";
import { LinkedTicketsPanel } from "./LinkedTicketsPanel";
import { TranscriptBody } from "./TranscriptBody";
import { transcriptFilename } from "./TranscriptDownloadButton";

// ~90s of 4s polls — matches the extraction workflow's retry envelope.
const MAX_INSIGHT_POLLS = 22;

const STATUS_LABELS: Record<string, string> = {
	NOT_SCANNED: "Not analyzed",
	IN_PROGRESS: "Analyzing…",
	SCANNED: "Analyzed",
	FAILED: "Analysis failed",
};

export function toAnalysisStatusLabel(status: string): string {
	return STATUS_LABELS[status] ?? status;
}

/** #1823 FR5: "Last scanned …" from insightsExtractedAt; null = never scanned. */
export function toLastScannedLabel(value: Date | string | null): string | null {
	if (!value) {
		return null;
	}
	const d = typeof value === "string" ? new Date(value) : value;
	return `Last scanned ${d.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	})}`;
}

// Stable string key for an insightsExtractedAt value (Date | string | null),
// used to detect "a fresh extraction landed" without caring about the wire
// representation.
function extractedAtKey(value: unknown): string | null {
	if (!value) {
		return null;
	}
	return value instanceof Date ? value.toISOString() : String(value);
}

export function toTextItems(
	raw: unknown,
): Array<{ text: string; meta?: string; anchorLine?: number }> {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map((element) => {
		if (typeof element === "string") {
			return { text: element };
		}
		if (element !== null && typeof element === "object") {
			const obj = element as Record<string, unknown>;
			const text =
				typeof obj.text === "string"
					? obj.text
					: JSON.stringify(element);
			const parts: string[] = [];
			if (typeof obj.tentativeOwnerName === "string") {
				parts.push(obj.tentativeOwnerName);
			}
			if (typeof obj.dueHint === "string") {
				parts.push(`due ${obj.dueHint}`);
			}
			const meta = parts.length > 0 ? parts.join(" · ") : undefined;
			const anchorLine =
				typeof obj.anchorLine === "number" &&
				Number.isInteger(obj.anchorLine)
					? obj.anchorLine
					: undefined;
			return { text, meta, ...(anchorLine ? { anchorLine } : {}) };
		}
		return { text: JSON.stringify(element) };
	});
}

export function TranscriptPane({
	projectId,
	organizationId,
	transcriptRef,
	hasTranscript,
	jumpTarget,
	meetingSubject = null,
	meetingDate = null,
	transcriptContextId = null,
}: {
	projectId: string;
	organizationId: string | null;
	transcriptRef: string;
	hasTranscript: boolean;
	jumpTarget?: { line: number; nonce: number } | null;
	meetingSubject?: string | null;
	meetingDate?: Date | string | null;
	transcriptContextId?: string | null;
}) {
	const pathname = usePathname();
	const { data, isLoading, isError } = useQuery({
		queryKey: [
			"projects.meetingTranscriptSync.getContent",
			projectId,
			transcriptRef,
		],
		queryFn: () =>
			orpcClient.projects.meetingTranscriptSync.getContent({
				projectId,
				organizationId,
				transcriptRef,
			}),
		enabled: hasTranscript,
	});

	return (
		<TranscriptBody
			content={data?.transcript.content ?? ""}
			isLoading={isLoading}
			isError={isError}
			hasTranscript={hasTranscript}
			jumpTarget={jumpTarget}
			filename={transcriptFilename(meetingSubject, meetingDate)}
			expandTitle={
				meetingSubject ? `Transcript — ${meetingSubject}` : "Transcript"
			}
			resetKey={transcriptRef}
			fullTranscriptHref={
				transcriptContextId
					? `${pathname}/contexts/${transcriptContextId}?back=meeting-digest${
							jumpTarget ? `#t-${jumpTarget.line}` : ""
						}`
					: null
			}
		/>
	);
}

function InsightList({
	raw,
	pending,
	onJump,
}: {
	raw: unknown;
	pending: boolean;
	onJump?: (anchorLine: number) => void;
}) {
	const items = toTextItems(raw);
	if (items.length === 0) {
		return (
			<p className="text-muted-foreground">
				{pending ? "Generating insights…" : "None"}
			</p>
		);
	}
	return (
		<ul className="list-disc space-y-1 pl-5 text-muted-foreground">
			{items.map((item, i) => (
				<li key={i}>
					{item.text}
					{item.meta ? ` — ${item.meta}` : ""}
					{onJump && item.anchorLine !== undefined && (
						<button
							type="button"
							onClick={() => onJump(item.anchorLine as number)}
							aria-label={`Jump to transcript for: ${item.text}`}
							className="ml-2 text-xs text-primary underline hover:no-underline"
						>
							Jump to transcript
						</button>
					)}
				</li>
			))}
		</ul>
	);
}

export function MeetingDetailSheet({
	projectId,
	organizationId,
	transcriptId,
	onClose,
	onActionItemToggled = () => {},
	highlightItemKey = null,
	panelExpanded = false,
	onPanelExpandedChange = () => {},
}: {
	projectId: string;
	organizationId: string | null;
	transcriptId: string | null;
	onClose: () => void;
	onActionItemToggled?: () => void;
	/** #1902 AC5: action item to open on and highlight, from a back-reference. */
	highlightItemKey?: string | null;
	/** #2108 follow-up: panel width is owned by MeetingDigestTab so it
	 *  survives meeting switches and sheet close. Optional so the sheet still
	 *  renders standalone in tests. */
	panelExpanded?: boolean;
	onPanelExpandedChange?: (expanded: boolean) => void;
}) {
	// Poll bookkeeping + trigger dedup are per opened meeting: the sheet stays
	// mounted across open/close (only transcriptId changes), so everything
	// resets when a meeting is (re)opened — including after a failed trigger,
	// which makes reopening retry.
	const pollsRef = useRef(0);
	const triggeredForRef = useRef<string | null>(null);
	// #1902: matching is fired once per opened meeting, separately from the
	// insights trigger — it can only run after extraction has produced rows.
	const linkTriggeredForRef = useRef<string | null>(null);
	const [extractionStalled, setExtractionStalled] = useState(false);
	// Manual regenerate: insightsReady stays true across a force re-run (the
	// cache was already filled), so the refetch guard below needs a separate
	// signal to keep polling — manualRun — plus a baseline of the
	// insightsExtractedAt it started from, to know when the fresh run lands.
	const [manualRun, setManualRun] = useState(false);
	const baselineExtractedAtRef = useRef<string | null>(null);
	// "Create proposals" (#1814 FR7): one-shot terminal-state message,
	// not a poller — reset alongside the other per-meeting state below.
	const [proposalMsg, setProposalMsg] = useState<string | null>(null);
	const [proposalBusy, setProposalBusy] = useState(false);
	// Controlled Tabs + jump-to-transcript state (#1896): a jump switches the
	// sheet to the Transcript tab and records a target for Task 5's
	// scroll-to-line to consume. The nonce lets re-clicking the same line
	// re-trigger the scroll even though `line` itself didn't change.
	// #1902 AC5: a back-reference lands on the Actions tab so the highlighted
	// item is on screen, rather than on the default Decisions tab.
	const [activeTab, setActiveTab] = useState(
		highlightItemKey ? "actions" : "decisions",
	);
	const [jumpTarget, setJumpTarget] = useState<{
		line: number;
		nonce: number;
	} | null>(null);
	// Expanded summary reading view (#2108) — display-only modal state.
	// Reset during render, NOT in the effect below: getMeeting serves a
	// cache-warm meeting synchronously, and the effect runs after paint — an
	// effect-based reset would flash the new meeting's summary in a modal the
	// user opened on the old one. Same adjust-state-during-render pattern as
	// PersonalMeetingSheet's per-meeting flags (#2387).
	const [summaryExpanded, setSummaryExpanded] = useState(false);
	const [lastExpandedFor, setLastExpandedFor] = useState(transcriptId);
	if (transcriptId !== lastExpandedFor) {
		setLastExpandedFor(transcriptId);
		setSummaryExpanded(false);
	}
	useEffect(() => {
		pollsRef.current = 0;
		triggeredForRef.current = null;
		linkTriggeredForRef.current = null;
		setExtractionStalled(false);
		setManualRun(false);
		baselineExtractedAtRef.current = null;
		setProposalMsg(null);
		setProposalBusy(false);
		// #1902 AC5: a back-reference deep link lands on the Actions tab so the
		// highlighted item is on screen; every other open starts on Decisions as
		// before. This is the ONLY setActiveTab in this effect — an earlier
		// version set it twice and the unconditional "decisions" silently won,
		// which shipped a deep link that opened the right meeting on the wrong tab.
		setActiveTab(highlightItemKey ? "actions" : "decisions");
		setJumpTarget(null);
	}, [transcriptId, highlightItemKey]);

	const {
		data,
		isLoading,
		refetch: refetchMeeting,
	} = useQuery({
		queryKey: [
			"projects.meetingDigest.getMeeting",
			projectId,
			transcriptId,
		],
		queryFn: () =>
			orpcClient.projects.meetingDigest.getMeeting({
				projectId,
				organizationId,
				transcriptId: transcriptId as string,
			}),
		enabled: Boolean(transcriptId),
		// #1823: linkedTickets completion state must be live, not the global
		// 60s-stale cache — a ticket closed on the board while the sheet was
		// last open has to show its checkmark on the next open.
		staleTime: 0,
		refetchOnMount: "always",
		// While the on-demand extraction (triggered below) is filling the
		// insights cache, poll until getMeeting reports it ready — but give up
		// after MAX_INSIGHT_POLLS so a permanently-failed extraction (LLM
		// outage, no usable transcript text) degrades to the terminal
		// "None"/"No summary available." states instead of polling forever.
		//
		// A manual regenerate is the one case where insightsReady is already
		// true when polling needs to start (the cache was filled by a prior
		// run) — manualRun keeps the guard open, and comparing the polled
		// insightsExtractedAt against the baseline stashed in regenerate()
		// is how we notice the fresh run landed and stop.
		//
		// Poll even while the tab is hidden — same reasoning as the agenda
		// poll in use-meeting-agenda.ts (#2136): extraction takes up to ~90s,
		// users tab away, and TanStack's default pauses interval refetches
		// for hidden tabs, freezing the sheet on its spinner until a reload.
		// MAX_INSIGHT_POLLS bounds the cost either way.
		refetchIntervalInBackground: true,
		refetchInterval: (query) => {
			const meeting = query.state.data;
			// #1902: keep polling while a matching run is outstanding, even once
			// insights are ready — links arrive after extraction, so stopping at
			// insightsReady would leave the chips absent until a manual refetch.
			const linkingPending = Boolean(
				meeting?.linkingEnabled && !meeting.linkingReady,
			);
			if (
				!meeting?.hasTranscript ||
				(meeting.insightsReady && !manualRun && !linkingPending)
			) {
				return false;
			}
			if (manualRun) {
				const current = extractedAtKey(meeting.insightsExtractedAt);
				if (
					current !== null &&
					current !== baselineExtractedAtRef.current
				) {
					setManualRun(false);
					return false;
				}
			}
			if (pollsRef.current >= MAX_INSIGHT_POLLS) {
				// Only an INSIGHTS timeout is an error worth showing. When the
				// budget ran out while we were merely waiting on link matching,
				// the summary and action items are already on screen and intact
				// — surfacing "Summary generation didn't finish" there would be
				// both false and a violation of FR8 (a missing link is never an
				// error). Stop polling quietly instead; the links appear on the
				// next open, and the matching run itself is unaffected.
				if (!meeting.insightsReady || manualRun) {
					setExtractionStalled(true);
				}
				setManualRun(false);
				return false;
			}
			pollsRef.current += 1;
			return 4000;
		},
	});

	const insightsPending = Boolean(
		data?.hasTranscript && !data.insightsReady && !extractionStalled,
	);

	// Self-populate: fire the extraction once per opened meeting when the
	// cache is missing/stale. The server collapses duplicate starts, so this
	// is safe against re-mounts; the ref just avoids re-firing on every poll.
	useEffect(() => {
		if (!transcriptId || !insightsPending) {
			return;
		}
		if (triggeredForRef.current === transcriptId) {
			return;
		}
		triggeredForRef.current = transcriptId;
		orpcClient.projects.meetingDigest
			.extractInsights({ projectId, organizationId, transcriptId })
			.catch(() => {
				// Failed trigger: stop pretending work is in flight — fall back
				// to the terminal empty states; clearing the ref lets reopening
				// the meeting retry.
				triggeredForRef.current = null;
				setExtractionStalled(true);
			});
	}, [transcriptId, insightsPending, projectId, organizationId]);

	// #1902: once extraction has produced action item rows, fire the matching
	// run. Deliberately gated on insightsReady — matching reads the rows, so
	// starting it earlier would match an empty meeting and stamp it done. The
	// server collapses duplicate starts; the ref just avoids re-firing per poll.
	useEffect(() => {
		if (!transcriptId || !data?.insightsReady || !data.linkingEnabled) {
			return;
		}
		if (data.linkingReady) {
			return;
		}
		if (linkTriggeredForRef.current === transcriptId) {
			return;
		}
		linkTriggeredForRef.current = transcriptId;
		orpcClient.projects.meetingDigest
			.linkActionItems({ projectId, organizationId, transcriptId })
			.catch(() => {
				// A failed trigger must not surface as an error: the digest is
				// fully usable without links (FR8). Clearing the ref lets
				// reopening the meeting retry.
				linkTriggeredForRef.current = null;
			});
	}, [
		transcriptId,
		data?.insightsReady,
		data?.linkingEnabled,
		data?.linkingReady,
		projectId,
		organizationId,
	]);

	// User-initiated re-run: force a fresh extraction even though the cache is
	// already filled. Stashes the current insightsExtractedAt as the baseline
	// the refetchInterval guard compares polls against, and marks
	// triggeredForRef so the auto-trigger effect above doesn't also fire.
	const regenerate = () => {
		pollsRef.current = 0;
		setExtractionStalled(false);
		triggeredForRef.current = transcriptId;
		baselineExtractedAtRef.current = extractedAtKey(
			data?.insightsExtractedAt,
		);
		setManualRun(true);
		orpcClient.projects.meetingDigest
			.extractInsights({
				projectId,
				organizationId,
				transcriptId: transcriptId as string,
				force: true,
			})
			.then((res) => {
				// force bypasses the freshness check but never the text-source
				// guard — a meeting with nothing to extract from (no context body,
				// no stored summary) reports back { started: false, reason:
				// "not-needed" } instead of starting a workflow. There's nothing to
				// poll for, so stop immediately instead of waiting ~90s to time out
				// and show a false "didn't finish" error.
				if (!res.started && res.reason === "not-needed") {
					setManualRun(false);
				}
			})
			.catch(() => {
				setExtractionStalled(true);
				setManualRun(false);
			});
	};

	// Jump-to-transcript (#1896): switch to the Transcript tab and stash the
	// target line; Task 5's TranscriptPane scroll effect reads jumpTarget.
	const handleJump = (anchorLine: number) => {
		setActiveTab("transcript");
		setJumpTarget((prev) => ({
			line: anchorLine,
			nonce: (prev?.nonce ?? 0) + 1,
		}));
	};

	// User-initiated proposal generation (#1814 FR7): reuses the auto-analyze
	// workflow + PendingBacklogProposal inbox. Terminal-state message only —
	// this does not poll (the inbox is where the result eventually surfaces).
	const generateProposals = async () => {
		if (!transcriptId) {
			return;
		}
		setProposalBusy(true);
		setProposalMsg(null);
		try {
			const res =
				await orpcClient.projects.meetingDigest.generateProposals({
					projectId,
					organizationId,
					transcriptId,
				});
			setProposalMsg(
				{
					started:
						"Analyzing the meeting — proposals will appear in the Proposal Inbox for review.",
					"in-progress":
						"Analysis is already running for this meeting.",
					"already-analyzed":
						"Proposals for this meeting already exist — review them in the Proposal Inbox.",
					"no-actionable-content":
						"No actionable content was detected in this meeting, so no proposals were generated.",
					"no-transcript":
						"This meeting has no transcript to analyze.",
				}[res.status] ?? res.status,
			);
		} catch {
			setProposalMsg("Could not start the analysis. Please try again.");
		} finally {
			setProposalBusy(false);
		}
	};

	return (
		<Sheet
			open={Boolean(transcriptId)}
			onOpenChange={(open) => !open && onClose()}
		>
			<SheetContent
				side="right"
				onOpenAutoFocus={(event) => {
					// SheetContent renders its own Close button *after*
					// {children} (sheet.tsx), so the panel toggle is always
					// the first tabbable and would otherwise take initial
					// focus — landing a keyboard user on a width preference
					// rather than the dismiss control. Reordering the toggle
					// within {children} cannot fix this, for the same reason.
					// Focus the panel itself: title and description are
					// announced, and Tab then proceeds in visual order.
					event.preventDefault();
					// Radix types the argument as a bare Event, so
					// currentTarget is EventTarget | null; at runtime it is
					// the content element.
					(event.currentTarget as HTMLElement | null)?.focus();
				}}
				className={cn(
					"overflow-y-auto transition-[width,max-width] duration-200 ease-in-out motion-reduce:transition-none",
					panelWidthClass(panelExpanded),
				)}
			>
				<SheetHeader className="pr-16">
					<SheetTitle>{data?.subject ?? "Meeting"}</SheetTitle>
					<SheetDescription className="sr-only">
						Meeting digest detail: summary, insights, and
						transcript.
					</SheetDescription>
				</SheetHeader>
				<PanelExpandButton
					expanded={panelExpanded}
					onToggle={() => onPanelExpandedChange(!panelExpanded)}
				/>

				{isLoading && (
					<p className="mt-4 text-sm text-muted-foreground">
						Loading…
					</p>
				)}

				{data && (
					<div className="mt-4 space-y-4 text-sm">
						<div>
							<span className="rounded bg-muted px-2 py-0.5 text-xs">
								{toAnalysisStatusLabel(data.analysisStatus)}
							</span>
							<span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs">
								{data.hasTranscript
									? "Transcript available"
									: "No transcript"}
							</span>
							{data.analysisStatus === "FAILED" &&
							data.analysisError ? (
								<p className="mt-1 text-xs text-destructive">
									{data.analysisError}
								</p>
							) : null}
						</div>
						<div>
							<p className="font-medium">Participants</p>
							<p className="text-muted-foreground">
								{data.participants.length
									? data.participants.join(", ")
									: "—"}
							</p>
						</div>
						<div>
							<div className="flex items-center gap-1">
								<p className="font-medium">Summary</p>
								{data.summary ? (
									<ExpandButton
										label="Expand summary"
										onClick={() => setSummaryExpanded(true)}
									/>
								) : null}
							</div>
							{data.summary ? (
								<>
									<div className="prose prose-sm prose-stone dark:prose-invert max-w-none text-muted-foreground">
										<ReactMarkdown
											remarkPlugins={[remarkGfm]}
										>
											{data.summary}
										</ReactMarkdown>
									</div>
									{extractionStalled ? (
										// A regenerate that timed out: keep the
										// stale summary visible, but say the
										// refresh didn't land.
										<p className="mt-1 text-xs text-destructive">
											Summary refresh didn&apos;t finish.
											It may have failed or timed out.
										</p>
									) : null}
								</>
							) : extractionStalled ? (
								<p className="text-destructive">
									Summary generation didn&apos;t finish. It
									may have failed or timed out.
								</p>
							) : (
								<p className="text-muted-foreground">
									{insightsPending
										? "Generating summary…"
										: "No summary available."}
								</p>
							)}
							{data.hasTranscript && !insightsPending ? (
								<>
									<button
										type="button"
										className="mt-1 text-xs text-muted-foreground underline hover:text-foreground disabled:cursor-default disabled:no-underline disabled:opacity-60"
										onClick={regenerate}
										disabled={manualRun}
									>
										{manualRun
											? "Regenerating summary…"
											: "Regenerate summary"}
									</button>
									{toLastScannedLabel(
										data.insightsExtractedAt,
									) ? (
										<p className="text-xs text-muted-foreground">
											{toLastScannedLabel(
												data.insightsExtractedAt,
											)}
										</p>
									) : null}
								</>
							) : null}
						</div>
						<div>
							<p className="font-medium">Created tasks</p>
							<LinkedTicketsPanel
								projectId={projectId}
								tickets={data.createdTasks}
							/>
						</div>
						<div className="space-y-1">
							<button
								type="button"
								className="rounded border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
								disabled={!data.hasTranscript || proposalBusy}
								onClick={generateProposals}
							>
								{proposalBusy
									? "Starting…"
									: "Create proposals"}
							</button>
							{proposalMsg ? (
								<p className="text-xs text-muted-foreground">
									{proposalMsg}
								</p>
							) : null}
						</div>
						<Tabs
							value={activeTab}
							onValueChange={(v) => {
								setActiveTab(v);
								// A manual tab switch cancels any pending jump.
								// The Transcript tab's pane unmounts when
								// inactive (Radix), which resets its
								// consumed-nonce guard — without clearing
								// jumpTarget here, re-opening the Transcript tab
								// would re-scroll/re-flash the last jumped line
								// with no user action. handleJump changes the
								// tab programmatically (not via onValueChange),
								// so a real jump's target is preserved.
								setJumpTarget(null);
							}}
						>
							<TabsList>
								<TabsTrigger value="decisions">
									Decisions
								</TabsTrigger>
								<TabsTrigger value="actions">
									Actions
								</TabsTrigger>
								<TabsTrigger value="questions">
									Questions
								</TabsTrigger>
								<TabsTrigger value="transcript">
									Transcript
								</TabsTrigger>
								<TabsTrigger value="declined" disabled>
									Declined (soon)
								</TabsTrigger>
							</TabsList>
							<TabsContent value="decisions">
								<InsightList
									raw={data.decisions}
									pending={insightsPending}
									onJump={handleJump}
								/>
							</TabsContent>
							<TabsContent value="actions">
								{insightsPending &&
								data.actionItems.length === 0 ? (
									<p className="text-muted-foreground">
										Generating insights…
									</p>
								) : (
									<ActionItemList
										projectId={projectId}
										organizationId={organizationId}
										items={data.actionItems}
										onToggled={onActionItemToggled}
										onJump={handleJump}
										linksByItemKey={
											data.linkingEnabled
												? data.linksByItemKey
												: undefined
										}
										onLinksChanged={refetchMeeting}
										highlightItemKey={highlightItemKey}
									/>
								)}
							</TabsContent>
							<TabsContent value="questions">
								<InsightList
									raw={data.openQuestions}
									pending={insightsPending}
									onJump={handleJump}
								/>
							</TabsContent>
							<TabsContent value="transcript">
								<TranscriptPane
									projectId={projectId}
									organizationId={organizationId}
									transcriptRef={data.transcriptRef}
									hasTranscript={data.hasTranscript}
									jumpTarget={jumpTarget}
									meetingSubject={data.subject}
									meetingDate={data.meetingDate}
									transcriptContextId={
										data.transcriptContextId
									}
								/>
							</TabsContent>
						</Tabs>
						{/* Expanded summary reading view (#2108): the same
						    markdown pipeline as the sidebar, nothing more —
						    scrolling and closing only, per the ticket. */}
						<ExpandedContentDialog
							open={summaryExpanded}
							onOpenChange={setSummaryExpanded}
							title={`Summary — ${data.subject ?? "Meeting"}`}
						>
							<div className="prose prose-sm prose-stone dark:prose-invert max-w-none">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>
									{data.summary ?? ""}
								</ReactMarkdown>
							</div>
						</ExpandedContentDialog>
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}
