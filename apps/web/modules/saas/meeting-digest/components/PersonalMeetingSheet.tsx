"use client";

/**
 * Detail sheet for a personal calendar meeting (#1899).
 *
 * Deliberately NOT MeetingDetailSheet. That component is database-bound: it
 * polls for insight extraction, creates tickets from action items, and
 * regenerates summaries — all of which require persisted rows that personal
 * meetings must never have (FR7).
 *
 * The transcript is fetched only when the user explicitly asks. Auto-fetching
 * on open would pull private content into the page on mere navigation.
 */
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { cn } from "@ui/lib";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import {
	type CachedInsights,
	dropInsights,
	readInsights,
	writeInsights,
} from "../lib/personal-insights-cache";
import type { PersonalInsightItem, PersonalMeeting } from "../lib/types";
import {
	ExpandButton,
	ExpandedContentDialog,
	PanelExpandButton,
	panelWidthClass,
} from "./ExpandedContentDialog";
import { ImportToProjectContextButton } from "./ImportToProjectContextButton";
import { TranscriptBody } from "./TranscriptBody";
import { transcriptFilename } from "./TranscriptDownloadButton";

function formatMeetingDate(startTime: string | null): string {
	if (!startTime) {
		return "Date unknown";
	}
	const d = new Date(startTime);
	return Number.isNaN(d.getTime())
		? "Date unknown"
		: format(d, "EEEE, d MMMM yyyy 'at' HH:mm");
}

/**
 * Ephemeral summary + action items for a personal meeting.
 *
 * Renders read-only and offers no ticket creation, unlike the team meeting
 * sheet: a ticket needs a persisted row, and nothing here is persisted. The
 * "not saved" line is load-bearing rather than decorative — without it a user
 * reasonably assumes this summary will still be here tomorrow.
 */
function PersonalMeetingInsights({
	summary,
	actionItems,
	reason,
	isLoading,
	isError,
	cacheEnabled,
	meetingSubject,
}: {
	summary: string | null;
	actionItems: PersonalInsightItem[];
	reason?: string;
	isLoading: boolean;
	isError: boolean;
	cacheEnabled: boolean;
	meetingSubject: string;
}) {
	// Expanded summary reading view (#2108). Lives here rather than in the
	// sheet on purpose: this component unmounts whenever the meeting changes
	// (summariseRequested resets per meeting), so expanded state can never
	// leak across meetings — the leak class that bit this sheet before.
	const [expanded, setExpanded] = useState(false);

	if (isLoading) {
		return (
			<p className="text-muted-foreground" aria-live="polite">
				Summarising this meeting…
			</p>
		);
	}

	if (isError) {
		return (
			<p className="text-muted-foreground">
				Couldn't summarise this meeting. Try again.
			</p>
		);
	}

	if (reason === "admin-consent-required") {
		return (
			<p className="text-muted-foreground">
				Fabric needs your IT admin to approve transcript access before
				personal meetings can be summarised.
			</p>
		);
	}

	if (reason === "transcript-access-disabled") {
		return (
			<p className="text-muted-foreground">
				Your Teams administrator needs to turn on transcript API access
				(Teams admin center → Meetings → Meeting settings) before Fabric
				can read meeting transcripts.
			</p>
		);
	}

	if (reason === "not-connected") {
		return (
			<p className="text-muted-foreground">
				Connect your Microsoft account in Settings → Integrations to
				summarise this meeting.
			</p>
		);
	}

	if (reason === "no-access") {
		return (
			<p className="text-muted-foreground">
				Microsoft won't release this meeting's transcript to you because
				someone else organised it, so there's nothing to summarise.
			</p>
		);
	}

	// #2170 QA. Graph answers 404/3004 when it cannot resolve the join URL at
	// all. Distinct from "no transcript yet": there is no Teams meeting behind
	// this calendar entry to produce one, so there is nothing to wait for.
	if (reason === "meeting-not-found") {
		return (
			<p className="text-muted-foreground">
				Fabric couldn't find this meeting in Teams, so there's nothing
				to summarise. It may not have been a Teams meeting, or Microsoft
				no longer has a record of it.
			</p>
		);
	}

	// A transcript that exists but holds only greetings. Separate from
	// "no transcript" because the transcript is right there in the panel, and
	// separate from the error above because "Try again" is advice that cannot
	// work — the same request would be impossible a second time.
	if (reason === "insufficient-content") {
		return (
			<p className="text-muted-foreground">
				There wasn't enough in this meeting's transcript to summarise.
			</p>
		);
	}

	if (reason === "no-transcript" || !summary) {
		return (
			<p className="text-muted-foreground">
				There's no transcript for this meeting yet, so there's nothing
				to summarise.
			</p>
		);
	}

	return (
		<div className="space-y-3">
			<div>
				<div className="flex items-center gap-1">
					<h3 className="mb-1 font-medium">Summary</h3>
					<ExpandButton
						label="Expand summary"
						onClick={() => setExpanded(true)}
					/>
				</div>
				<p className="whitespace-pre-wrap text-muted-foreground">
					{summary}
				</p>
				{/* Same in-memory string, nothing persisted — the modal keeps
				    the personal lane's no-persistence promise intact. */}
				<ExpandedContentDialog
					open={expanded}
					onOpenChange={setExpanded}
					title={`Summary — ${meetingSubject}`}
				>
					<p className="whitespace-pre-wrap text-foreground/80">
						{summary}
					</p>
				</ExpandedContentDialog>
			</div>

			{actionItems.length > 0 && (
				<div>
					<h3 className="mb-1 font-medium">Action items</h3>
					<ul className="list-disc space-y-1 pl-5 text-muted-foreground">
						{actionItems.map((item) => (
							<li key={item.text}>
								{item.text}
								{item.tentativeOwnerName
									? ` — ${item.tentativeOwnerName}`
									: ""}
								{item.dueHint ? ` (${item.dueHint})` : ""}
							</li>
						))}
					</ul>
				</div>
			)}

			{/*
			 * The "not saved" line is load-bearing rather than decorative —
			 * without it a user reasonably assumes this summary will still be
			 * here tomorrow. Once caching is opted into (#2104) the opposite is
			 * true, so the claim has to flip rather than quietly stay wrong.
			 */}
			<p className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
				{cacheEnabled
					? "This summary is saved in this browser so re-opening this meeting is instant. It never leaves your device, and is removed when you turn off saved summaries or sign out. Personal meetings still have no action-item tracking or ticket creation."
					: "This summary isn't saved — it's generated fresh each time you ask, and disappears when you close this panel. That's why personal meetings have no action-item tracking or ticket creation."}
			</p>
		</div>
	);
}

export function PersonalMeetingSheet({
	projectId,
	organizationId,
	meeting,
	onClose,
	userId = "",
	cacheEnabled = false,
	canImportToContext = false,
	projectName = "this project",
	panelExpanded = false,
	onPanelExpandedChange = () => {},
}: {
	projectId: string;
	organizationId: string | null;
	meeting: PersonalMeeting | null;
	onClose: () => void;
	/** Cache entries are user-scoped; see personal-insights-cache.ts. */
	userId?: string;
	/** Both the #2104 feature flag and the user's own opt-in. */
	cacheEnabled?: boolean;
	/** #2170: the MEETING_CONTEXT_IMPORT flag AND the caller's edit right. */
	canImportToContext?: boolean;
	/** Named in the #2170 confirmation dialog. */
	projectName?: string;
	/** #2108 follow-up: shared with the team sheet via MeetingDigestTab, so
	 *  the width survives this component unmounting on close. */
	panelExpanded?: boolean;
	onPanelExpandedChange?: (expanded: boolean) => void;
}) {
	const [requested, setRequested] = useState(false);
	const [summariseRequested, setSummariseRequested] = useState(false);
	// #2170. Set once this meeting has been added to project context, so the
	// privacy notice below stops claiming it is private to the caller. The
	// notice is the only thing on screen that tells the user who can see this
	// meeting; leaving it standing next to content that is now shared would be
	// the most consequential kind of stale UI this surface can have.
	const [imported, setImported] = useState(false);
	// ...but the flag above only knows about imports THIS sheet performed. A
	// reload, or opening a meeting someone imported in an earlier session, would
	// otherwise put the "visible only to you" notice over content the project
	// already holds. `alreadyImported` is the server's answer and survives both.
	// `meeting` is null whenever the sheet is closed, and this runs above the
	// guard that returns early for that — hence the optional chain.
	const isInProjectContext = imported || meeting?.alreadyImported === true;

	/**
	 * Reset both explicit-ask flags whenever the sheet is pointed at a different
	 * meeting.
	 *
	 * Found in live QA: summarising meeting A and then opening meeting B showed
	 * B already summarised, because this component stays mounted across the
	 * parent's `selectedPersonal` changes and the flags survived with it. That
	 * auto-fetched B's transcript on mere navigation — the exact thing this
	 * file's header forbids.
	 *
	 * Keyed off the meeting identity rather than the close handler on purpose:
	 * `onOpenChange` only fires when the user dismisses the sheet, so anything
	 * that swaps the meeting without a dismiss (or any future caller that does)
	 * would leak again. Deriving it from the prop makes the guarantee
	 * independent of how the sheet is driven. This is the standard
	 * adjust-state-during-render pattern, not an effect: React re-renders
	 * immediately, so no fetch is issued with a stale flag.
	 */
	const meetingKey = meeting
		? `${meeting.joinUrl}:${meeting.startTime ?? ""}`
		: null;
	const [lastMeetingKey, setLastMeetingKey] = useState(meetingKey);
	if (meetingKey !== lastMeetingKey) {
		setLastMeetingKey(meetingKey);
		setRequested(false);
		setSummariseRequested(false);
		// #2170: same reason as the two flags above — this drives a privacy
		// claim, and carrying it to the next meeting would tell the user a
		// still-private meeting is shared with the project.
		setImported(false);
	}

	/**
	 * A linked project meeting is shared with the team, not private to the
	 * caller — it surfaces in this lane only because no transcript has synced
	 * yet (DEF-0). The #2104 opt-in is worded as being about the user's
	 * personal meetings, so a shared one must not be written to the device,
	 * served from it, pinned in the query cache, or described as saved. One
	 * derived value keeps all four sites in agreement.
	 */
	const cacheActive =
		cacheEnabled && !!meeting && !meeting.linkedWithoutTranscript;

	/**
	 * Tiers 1 and 2 of the #2104 cache.
	 *
	 * `staleTime` is Infinity unconditionally, regardless of `cacheActive`.
	 * Nothing in this app overrides TanStack's `refetchOnWindowFocus` default
	 * of true, so a query at `staleTime: 0` re-runs `getPersonalInsights` — a
	 * fresh Graph fetch plus a fresh LLM summarise — on every alt-tab back
	 * into the page, silently changing the displayed summary under the user.
	 * "Recomputed every ask" is what `enabled: summariseRequested` already
	 * gives: a fresh ask is a fresh `Summarise meeting` click after
	 * `meetingKey` resets it, not a window refocus.
	 *
	 * When the user has NOT opted in — either they never turned caching on,
	 * or `cacheActive` is false because this particular meeting is shared —
	 * `gcTime: 0` keeps #1899's discipline: nothing persisted, and the
	 * summary is dropped from the query cache the moment the sheet closes.
	 *
	 * When `cacheActive` is true, `initialData` serves the on-device entry
	 * synchronously so no request is issued at all, and `gcTime` becomes
	 * tab-lifetime so a second open in the same session is free.
	 * `summariseRequested` still resets per meeting (see above), so a cached
	 * summary never renders until the user asks — a hit removes the wait, not
	 * the click.
	 */
	// Memoised because a cache read parses the whole project blob (up to 100
	// entries), and this sits on the render path of an open sheet.
	const cached: CachedInsights | null = useMemo(() => {
		if (!meeting) {
			return null;
		}
		if (cacheActive) {
			return readInsights(
				userId,
				projectId,
				meeting.joinUrl,
				meeting.startTime ?? undefined,
			);
		}
		// Guarded miss because this particular meeting is SHARED — not
		// because the user hasn't opted in at all. `cacheActive` keeps
		// `readInsights` from ever being called for it again, so nothing else
		// on the read path prunes an entry written before it became shared.
		// Delete it here, on the same deferred-write path the module's own
		// TTL sweep uses (#2137), or it outlives its TTL until the LRU cap
		// evicts it or the user purges.
		if (cacheEnabled && meeting.linkedWithoutTranscript) {
			dropInsights(
				userId,
				projectId,
				meeting.joinUrl,
				meeting.startTime ?? undefined,
			);
		}
		return null;
	}, [cacheActive, cacheEnabled, userId, projectId, meeting]);

	const insights = useQuery({
		queryKey: [
			"projects.meetingDigest.getPersonalInsights",
			projectId,
			meeting?.joinUrl,
			meeting?.startTime,
		],
		queryFn: async () => {
			const result =
				await orpcClient.projects.meetingDigest.getPersonalInsights({
					projectId,
					organizationId,
					joinUrl: meeting?.joinUrl ?? "",
					startTime: meeting?.startTime ?? undefined,
					meetingSubject: meeting?.subject ?? null,
				});

			// Only a real summary is worth keeping. A `reason` response means
			// there was nothing to summarise, and caching that would pin a
			// transient Graph state — e.g. a transcript that has not landed yet
			// — and keep reporting "no transcript" after one appears.
			if (cacheActive && meeting && result.summary) {
				writeInsights(
					userId,
					projectId,
					meeting.joinUrl,
					meeting.startTime ?? undefined,
					{
						summary: result.summary,
						actionItems: result.actionItems ?? [],
					},
				);
			}

			return result;
		},
		enabled: summariseRequested && !!meeting,
		initialData: cached
			? { summary: cached.summary, actionItems: cached.actionItems }
			: undefined,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: cacheActive ? 5 * 60_000 : 0,
	});

	const { data, isLoading, isError } = useQuery({
		queryKey: [
			"projects.meetingDigest.getPersonalTranscript",
			projectId,
			meeting?.joinUrl,
			meeting?.startTime,
		],
		queryFn: () =>
			orpcClient.projects.meetingDigest.getPersonalTranscript({
				projectId,
				organizationId,
				joinUrl: meeting?.joinUrl ?? "",
				startTime: meeting?.startTime ?? undefined,
			}),
		enabled: requested && !!meeting,
		// Personal transcript text must not linger in the client cache once the
		// sheet closes.
		staleTime: 0,
		gcTime: 0,
	});

	if (!meeting) {
		return null;
	}

	const reason = data?.reason;
	const content = data?.content ?? "";

	return (
		<Sheet
			open={true}
			onOpenChange={(open) => {
				if (!open) {
					setRequested(false);
					onClose();
				}
			}}
		>
			<SheetContent
				onOpenAutoFocus={(event) => {
					// Same reason as the team sheet: SheetContent renders its
					// own Close button after {children}, so the panel toggle
					// would otherwise take initial focus. Focus the panel
					// itself instead of a width preference.
					event.preventDefault();
					(event.currentTarget as HTMLElement | null)?.focus();
				}}
				className={cn(
					"overflow-y-auto transition-[width,max-width] duration-200 ease-in-out motion-reduce:transition-none",
					panelWidthClass(panelExpanded),
				)}
			>
				<SheetHeader className="pr-16">
					<SheetTitle className="flex items-center gap-2">
						{meeting.subject}
						<Badge variant="outline">
							{meeting.linkedWithoutTranscript
								? "Not synced yet"
								: "Personal"}
						</Badge>
					</SheetTitle>
					{/*
					 * DEF-1. Without a Description, Radix points the dialog's
					 * aria-describedby at an ID that never renders, so screen
					 * readers announce no description at all and the console
					 * warns on every open. MeetingDetailSheet solves it the same
					 * way; this sheet did not inherit the fix.
					 */}
					<SheetDescription className="sr-only">
						{meeting.linkedWithoutTranscript
							? "Project meeting awaiting transcript sync. Load its transcript on demand."
							: "Personal meeting details. Load its transcript on demand."}
					</SheetDescription>
				</SheetHeader>
				<PanelExpandButton
					expanded={panelExpanded}
					onToggle={() => onPanelExpandedChange(!panelExpanded)}
				/>

				<div className="mt-4 space-y-4 text-sm">
					<div className="space-y-1 text-muted-foreground">
						<p>{formatMeetingDate(meeting.startTime)}</p>
						<p>Organized by {meeting.organizer}</p>
						<a
							href={meeting.joinUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary underline-offset-2 hover:underline"
						>
							Open in Teams
						</a>
					</div>

					{/*
					 * Two different meetings reach this sheet and only one of them
					 * is private (DEF-0). Saying "visible only to you" over a
					 * linked project meeting would misinform the user about who
					 * can see it — the inverse of the privacy promise this feature
					 * exists to keep. The on-demand, never-stored half is true for
					 * both, so it is stated either way.
					 */}
					<p className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
						{meeting.linkedWithoutTranscript
							? "This meeting is linked to the project and shared with the project's members. Its transcript hasn't synced yet, so it isn't in the digest — the copy below is fetched from Microsoft when you ask for it and is not stored in Fabric."
							: isInProjectContext
								? "You added this meeting to the project, so its transcript is now stored in Fabric as project context, visible to everyone with access to this project, and readable by Fabric's AI features. Remove it from the project's Context tab to undo that."
								: "This meeting is visible only to you. Its transcript is fetched from Microsoft when you ask for it and is never stored in Fabric."}
					</p>

					<div className="flex flex-wrap gap-2">
						{!requested && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setRequested(true)}
							>
								Load transcript
							</Button>
						)}
						{!summariseRequested && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setSummariseRequested(true)}
							>
								Summarise meeting
							</Button>
						)}
						{/*
						 * #2170. Genuinely-personal meetings only: a
						 * `linkedWithoutTranscript` row is already a project
						 * meeting whose transcript the sync pipeline owns, so
						 * importing it would create a second copy of content
						 * the project is about to receive anyway.
						 */}
						{canImportToContext &&
							!meeting.linkedWithoutTranscript && (
								<ImportToProjectContextButton
									key={meetingKey ?? ""}
									projectId={projectId}
									organizationId={organizationId}
									projectName={projectName}
									meeting={meeting}
									onImported={() => setImported(true)}
								/>
							)}
					</div>

					{summariseRequested && (
						<PersonalMeetingInsights
							summary={insights.data?.summary ?? null}
							actionItems={insights.data?.actionItems ?? []}
							reason={insights.data?.reason}
							isLoading={insights.isLoading}
							isError={insights.isError}
							cacheEnabled={cacheActive}
							meetingSubject={meeting.subject}
						/>
					)}

					{requested && reason === "admin-consent-required" && (
						<p className="text-muted-foreground">
							Fabric needs your IT admin to approve transcript
							access before personal meeting transcripts can be
							read.
						</p>
					)}

					{requested && reason === "transcript-access-disabled" && (
						<p className="text-muted-foreground">
							Your Teams administrator needs to turn on transcript
							API access (Teams admin center → Meetings → Meeting
							settings) before Fabric can read meeting
							transcripts.
						</p>
					)}

					{requested && reason === "not-connected" && (
						<p className="text-muted-foreground">
							Connect your Microsoft account in Settings →
							Integrations to read this transcript.
						</p>
					)}

					{requested && reason === "no-access" && (
						<p className="text-muted-foreground">
							Microsoft won't release this meeting's transcript to
							you because someone else organised it. Ask the
							organiser to share it, or open the meeting in Teams.
						</p>
					)}

					{requested && reason === "meeting-not-found" && (
						<p className="text-muted-foreground">
							Fabric couldn't find this meeting in Teams. It may
							not have been a Teams meeting, or Microsoft no
							longer has a record of it.
						</p>
					)}

					{requested &&
						reason !== "admin-consent-required" &&
						reason !== "transcript-access-disabled" &&
						reason !== "not-connected" &&
						reason !== "no-access" &&
						reason !== "meeting-not-found" && (
							<TranscriptBody
								content={content}
								isLoading={isLoading}
								isError={isError}
								hasTranscript={
									isLoading || isError || content.length > 0
								}
								filename={transcriptFilename(
									meeting.subject,
									meeting.startTime,
								)}
								expandTitle={`Transcript — ${meeting.subject}`}
								resetKey={meetingKey}
								// Transcript download is team-meetings-only
								// (#1897). A genuinely personal meeting gets no
								// download action; a linked project meeting shown
								// here (linkedWithoutTranscript) is a team meeting
								// and keeps it.
								showDownload={meeting.linkedWithoutTranscript}
							/>
						)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
