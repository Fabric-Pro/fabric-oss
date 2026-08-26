"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { LinkedMeetingSelector } from "@saas/meetings/components";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { addMonths, format, subMonths } from "date-fns";
import { PlusIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLinkedMeetingJoinUrls } from "../hooks/use-linked-meeting-join-urls";
import { useMeetingDigest } from "../hooks/use-meeting-digest";
import { usePersonalMeetings } from "../hooks/use-personal-meetings";
import type { UpcomingMeeting } from "../hooks/use-upcoming-meetings";
import { parseDigestDeepLink } from "../lib/digest-deep-link";
import { dayKey } from "../lib/group-meetings";
import type { PersonalMeeting } from "../lib/types";
import { AgendaSheet } from "./AgendaSheet";
import { AgendaView } from "./AgendaView";
import { CalendarCanvas } from "./CalendarCanvas";
import { DigestConfigPanel } from "./DigestConfigPanel";
import { MeetingDetailSheet } from "./MeetingDetailSheet";
import { PersonalMeetingSheet } from "./PersonalMeetingSheet";
import {
	PersonalMeetingsConsent,
	usePersonalInsightsCacheConsent,
	usePersonalMeetingsConsent,
} from "./PersonalMeetingsConsent";
import { UpcomingMeetingsSection } from "./UpcomingMeetingsSection";

export function MeetingDigestTab({
	projectId,
	organizationId,
	canEdit,
	userId = "",
	projectName = "this project",
}: {
	projectId: string;
	organizationId: string | null;
	canEdit: boolean;
	/**
	 * Shown in the #2170 import confirmation. Defaulted rather than required so
	 * the existing tests of this component keep working; the default is a
	 * truthful fallback, not a placeholder that could read as a bug.
	 */
	projectName?: string;
	/**
	 * Passed down rather than read from `useSession` here (#2104): the parent
	 * already holds the session, and taking a context dependency in this
	 * component would make every existing test of it require a SessionProvider
	 * for a value only the personal-meeting cache uses.
	 */
	userId?: string;
}) {
	const [monthDate, setMonthDate] = useState(() => new Date());
	const [showConfig, setShowConfig] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	// #2108 follow-up: panel width is shared by both meeting sheets and owned
	// here, not in either sheet, because it is one flag used by both — it
	// cannot live inside either sheet without the other losing access to it.
	// Holding it here also means widening one panel opens the other wide.
	// Session-scoped by design — it resets on reload, and nothing is persisted.
	const [panelExpanded, setPanelExpanded] = useState(false);
	// #1902 FR6/AC5: arriving from a work item's back-reference opens that
	// meeting and highlights the action item. Read once on mount rather than on
	// every searchParams change, so closing the sheet does not immediately
	// re-open it from a URL the user has not navigated away from.
	const searchParams = useSearchParams();
	const [highlightItemKey, setHighlightItemKey] = useState<string | null>(
		null,
	);
	const deepLinkApplied = useRef(false);
	useEffect(() => {
		if (deepLinkApplied.current) {
			return;
		}
		const { transcriptRef, itemKey } = parseDigestDeepLink(searchParams);
		if (!transcriptRef) {
			return;
		}
		deepLinkApplied.current = true;
		setSelected(transcriptRef);
		setHighlightItemKey(itemKey);
	}, [searchParams]);
	const [view, setView] = useState<"month" | "agenda">("month");
	// #2143: which of the two digest tabs is active. Deliberately plain state —
	// the card settled on "Upcoming default, no persistence". Held here rather
	// than as Tabs defaultValue so opening and closing the Configure panel
	// (which unmounts the tab area) doesn't silently reset the selection.
	const [digestTab, setDigestTab] = useState<"upcoming" | "calendar">(
		"upcoming",
	);
	const [agendaTarget, setAgendaTarget] = useState<UpcomingMeeting | null>(
		null,
	);
	const {
		meetings,
		configMeetings,
		seriesWithoutTranscripts,
		awaitingOccurrences,
		isLoading,
		isError,
		setIncluded,
		onActionItemToggled,
		generateSummary,
		generatingRefs,
		summaryErrors,
		unlinkMeeting,
		refreshAfterLink,
	} = useMeetingDigest({
		projectId,
		organizationId,
		monthDate,
	});
	const includedMeetings = meetings.filter((m) => m.includedInDigest);

	const [showPicker, setShowPicker] = useState(false);
	const { confirm } = useConfirmationAlert();

	// Fetched unconditionally (once canEdit) rather than gated on
	// showPicker/showConfig: the picker and the digest's own listMeetings
	// query both start in the same render when the picker is opened from the
	// header, and listMeetings is served from a 60s Redis cache that often
	// wins that race — so gating this query narrower let already-linked
	// series render briefly un-badged and selectable in the picker (#1898
	// final review, FIX 7). The query itself is cheap and shares a cache key
	// with the Settings screen, so there's no cost to fetching it eagerly.
	const { joinUrls } = useLinkedMeetingJoinUrls({
		projectId,
		organizationId,
		enabled: canEdit,
	});

	// FIX 3 (#1898 final review): Exclude has no optimistic update and no
	// in-flight indicator, so the button still reads "Exclude" while a
	// setIncluded request is in flight. A second click before it resolves
	// sends `included: true` and reverses the user's intent. Track pending
	// linkedMeetingIds here (not in DigestConfigPanel, which stays
	// presentational) and disable that row's button until the mutation
	// settles.
	const [pendingIncludeIds, setPendingIncludeIds] = useState<Set<string>>(
		new Set(),
	);

	// FIX 2 (#1898 final review): setIncluded is the primary remove action
	// (Exclude), but it was called fire-and-forget from DigestConfigPanel —
	// a rejection produced an unhandled promise rejection and no UI
	// feedback at all. Mirrors unlink's try/catch below: success needs no
	// toast (the row re-renders via cache invalidation), failure does.
	const handleSetIncluded = useCallback(
		async (linkedMeetingId: string, included: boolean) => {
			setPendingIncludeIds((prev) => new Set(prev).add(linkedMeetingId));
			try {
				await setIncluded(linkedMeetingId, included);
			} catch (error) {
				console.error("Failed to update meeting digest setting", error);
				toast.error("Failed to update meeting digest setting", {
					description:
						"The meeting's digest setting was not changed. Please try again.",
				});
			} finally {
				setPendingIncludeIds((prev) => {
					const next = new Set(prev);
					next.delete(linkedMeetingId);
					return next;
				});
			}
		},
		[setIncluded],
	);

	// FIX 4 (#1898 final review): the confirmation dialog stays open and
	// clickable for the whole unlink round trip (unlink + three cache
	// invalidations + refetches). A second click before it settles re-runs
	// this same onConfirm closure; since the row is already gone by then,
	// the retry 404s/P2025s and reports failure for a meeting that was in
	// fact unlinked. Guard locally so a second invocation while one is
	// already running for that meeting is a no-op.
	//
	// #1905: ConfirmationAlertProvider now guards re-entry itself and always
	// closes once onConfirm settles, so this is no longer the only thing
	// standing between a double click and a spurious failure toast. Kept as
	// defense in depth — it is keyed per meeting, which the provider's single
	// in-flight flag is not.
	const unlinkInFlightRef = useRef<Set<string>>(new Set());

	const handleUnlink = (meeting: {
		linkedMeetingId: string;
		subject: string | null;
	}) =>
		confirm({
			title: `Unlink ${meeting.subject ?? "this meeting"}?`,
			message:
				"This removes the meeting from the project and permanently deletes its synced transcripts and their indexed context. Project answers that cite this meeting will lose that source. To just hide it from the digest, use Exclude instead.",
			confirmLabel: "Unlink meeting",
			destructive: true,
			onConfirm: async () => {
				if (unlinkInFlightRef.current.has(meeting.linkedMeetingId)) {
					return;
				}
				unlinkInFlightRef.current.add(meeting.linkedMeetingId);
				try {
					await unlinkMeeting(meeting.linkedMeetingId);
					toast.success("Meeting unlinked");
				} catch (error) {
					console.error("Failed to unlink meeting", error);
					toast.error("Failed to unlink meeting", {
						description:
							"The meeting is still linked. Please try again.",
					});
				} finally {
					unlinkInFlightRef.current.delete(meeting.linkedMeetingId);
				}
			},
		});

	// #1899. Resolved server-side and delivered via the RSC payload, so this is
	// runtime-toggleable from the admin UI. The old NEXT_PUBLIC_ mirror was
	// inlined at build time and could not be flipped without a redeploy.
	const personalMeetingsEnabled = useFeatureFlag("PERSONAL_MEETINGS");

	// #1901a. Same flag as agenda generation — an upcoming list with no agenda
	// button is a half-feature. As of #2143 this flag also selects the tabbed
	// (Upcoming/Calendar) vs. untabbed calendar-only digest layout.
	const meetingAgendaEnabled = useFeatureFlag("MEETING_AGENDA");

	// #2104. Separate from PERSONAL_MEETINGS so on-device caching can be rolled
	// back without disabling personal meetings entirely.
	const insightsCacheEnabled = useFeatureFlag("PERSONAL_INSIGHTS_CACHE");

	// #2170. Separate from PERSONAL_MEETINGS because it gates the one action
	// that stores personal meeting content: read-only personal meetings must
	// survive withdrawing the import, and revoking the flag has to take the
	// affordance away on the next render rather than merely stop working.
	const contextImportEnabled = useFeatureFlag("MEETING_CONTEXT_IMPORT");

	const [scope, setScope] = useState<"team" | "all">("team");
	const [selectedPersonal, setSelectedPersonal] =
		useState<PersonalMeeting | null>(null);
	const {
		consented,
		enable: enablePersonal,
		disable: disablePersonal,
	} = usePersonalMeetingsConsent(projectId);

	const queryClient = useQueryClient();

	const { cacheEnabled, enableCache, disableCache } =
		usePersonalInsightsCacheConsent(userId, projectId);

	/**
	 * Rolling the feature back must erase too, not merely hide the control.
	 *
	 * With the flag off, `showCacheToggle` is false — so "Forget summaries",
	 * the only way to clear what is already on disk, disappears along with it,
	 * while the entries and the opt-in key stay. Nothing prunes them either:
	 * the TTL only runs on a read, and reads stop with the flag. So the kill
	 * switch left opted-in users holding summaries they could no longer erase.
	 * `disableCache` is the same single revocation path the Turn off handler
	 * uses, so data and consent cannot drift apart here either.
	 *
	 * Bounded by what a browser can promise: the erase happens the next time
	 * this tab renders for that user, since nothing of ours runs on their
	 * device before then. Sign-out already purges unconditionally, so the two
	 * paths cover each other.
	 */
	useEffect(() => {
		if (!insightsCacheEnabled && cacheEnabled) {
			disableCache();
		}
	}, [insightsCacheEnabled, cacheEnabled, disableCache]);

	/**
	 * Turning personal meetings off must erase, not merely stop reading (#2104).
	 *
	 * Before caching existed, `disable()` was enough: nothing survived the
	 * query. Now an opted-in user has summaries on disk and in the query cache,
	 * and the invariant is that cached personal data never outlives the consent
	 * that created it.
	 */
	const handleDisablePersonal = useCallback(() => {
		// disableCache() clears the consent key AND purges the project's
		// entries. Calling the cache's purge helper directly (the old
		// approach) did only the second half, so re-enabling personal
		// meetings resumed caching with no fresh click — the data honoured
		// the invariant, the consent did not. One revocation path means the
		// two halves cannot drift apart again.
		disableCache();
		queryClient.removeQueries({
			queryKey: ["projects.meetingDigest.getPersonalInsights"],
		});
		queryClient.removeQueries({
			queryKey: ["projects.meetingDigest.getPersonalTranscript"],
		});
		disablePersonal();
	}, [disableCache, queryClient, disablePersonal]);

	// Selecting the "All" filter is a view choice; loading personal data
	// additionally requires consent. Both must hold (FR1 + FR2).
	const personalActive =
		personalMeetingsEnabled && scope === "all" && consented;

	const {
		personalMeetings,
		isLoading: personalIsLoading,
		isError: personalIsError,
		notConnected: personalNotConnected,
	} = usePersonalMeetings({
		projectId,
		organizationId,
		monthDate,
		enabled: personalActive,
	});

	// These three states own their own messaging, so the generic "no meetings
	// yet" copy must stand down for them — otherwise a user who simply hasn't
	// connected Microsoft is told to link Teams meetings, forever, or a user
	// hitting a generic personal-fetch failure is told nothing at all.
	const personalPending =
		personalActive &&
		(personalIsLoading || personalNotConnected || personalIsError);

	// #2051: a meeting that now renders as an awaiting TEAM row must not also
	// arrive through the personal lane. listPersonalMeetings suppresses a linked
	// meeting only once it has a transcript (its `renderedJoinUrls` is built from
	// `_count.transcripts > 0`), and an awaiting meeting by definition has none —
	// so without this the same meeting appears twice in one calendar cell in the
	// "All meetings" scope, once as a team row and once labelled "Not synced yet".
	//
	// Matched on (join URL, day). Both sides derive their day from the meeting's
	// START — occurrenceStart here, Graph's start there — so the day is directly
	// comparable, and matching the day rather than the URL alone keeps a genuine
	// occurrence on some other day visible.
	const awaitingKeys = useMemo(
		() =>
			new Set(
				awaitingOccurrences.map(
					(a) =>
						`${a.joinUrl.trim().toLowerCase()}|${dayKey(new Date(a.occurrenceStart))}`,
				),
			),
		[awaitingOccurrences],
	);
	const visiblePersonalMeetings = useMemo(
		() =>
			personalMeetings.filter((m) => {
				if (!m.startTime) {
					return true;
				}
				const start = new Date(m.startTime);
				if (Number.isNaN(start.getTime())) {
					return true;
				}
				return !awaitingKeys.has(
					`${m.joinUrl.trim().toLowerCase()}|${dayKey(start)}`,
				);
			}),
		[personalMeetings, awaitingKeys],
	);

	// #2051: awaiting rows count as content. Without this a project whose only
	// meetings are unsynced falls through to "No meetings in the digest yet" and
	// the calendar never renders — the exact scenario this ticket is about.
	const hasDigestContent =
		includedMeetings.length > 0 ||
		awaitingOccurrences.length > 0 ||
		(personalActive && visiblePersonalMeetings.length > 0);

	// The generic empty state and DigestConfigPanel each already ship their own
	// "Add meeting" affordance — the header button only needs to appear when
	// neither of those is on screen, otherwise the user sees two of them at
	// once (FR1: reachable once populated, not a duplicate control).
	const showGenericEmptyState =
		!isLoading &&
		!isError &&
		!showConfig &&
		!hasDigestContent &&
		!personalPending;

	// #2143: the empty state moved inside calendarContent, so on the tabbed
	// layout it is only actually on screen while the Calendar tab is active.
	// The header button must key off mounted-ness, not eligibility — an empty
	// digest viewed from the default Upcoming tab would otherwise have no
	// one-click add affordance at all (the same stranding #1898 review
	// finding 1 guarded against, reintroduced across the tab boundary).
	const genericEmptyStateOnScreen =
		showGenericEmptyState &&
		(!meetingAgendaEnabled || digestTab === "calendar");

	// Must match DigestConfigPanel's render condition exactly — the header
	// Add button is gated on this so the two can never both be hidden at once
	// (a loading/error state with showConfig=true would otherwise strand the
	// user with zero add affordances, see #1898 review finding 1).
	const configPanelVisible = !isLoading && !isError && showConfig && canEdit;

	// #2143: the calendar side of the page, shared verbatim between the
	// Calendar tab (MEETING_AGENDA on) and the untabbed flag-off layout so
	// the two render paths cannot drift.
	const calendarContent = (
		<>
			{seriesWithoutTranscripts.length > 0 && (
				<p className="rounded border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
					Included, but no transcripts synced yet:{" "}
					{seriesWithoutTranscripts
						.map((s) => s.subject ?? "Untitled meeting")
						.join(", ")}
					. They will appear on the calendar once a transcript syncs.
				</p>
			)}
			<div className="flex items-center gap-2">
				<button
					type="button"
					aria-label="Previous month"
					className="rounded border px-2 py-0.5 text-sm hover:bg-muted"
					onClick={() => setMonthDate((d) => subMonths(d, 1))}
				>
					←
				</button>
				<span className="min-w-[9rem] text-center text-sm font-medium">
					{format(monthDate, "MMMM yyyy")}
				</span>
				<button
					type="button"
					aria-label="Next month"
					className="rounded border px-2 py-0.5 text-sm hover:bg-muted"
					onClick={() => setMonthDate((d) => addMonths(d, 1))}
				>
					→
				</button>
				<button
					type="button"
					className="text-sm underline"
					onClick={() => setMonthDate(new Date())}
				>
					Today
				</button>
				{personalMeetingsEnabled && (
					<div className="ml-auto flex rounded border text-sm">
						{(
							[
								["team", "Team"],
								["all", "All meetings"],
							] as const
						).map(([value, label]) => (
							<button
								key={value}
								type="button"
								className={`px-3 py-0.5 ${scope === value ? "bg-muted font-medium" : ""}`}
								aria-pressed={scope === value}
								onClick={() => setScope(value)}
							>
								{label}
							</button>
						))}
					</div>
				)}
				<div
					data-onboarding-target="meeting-digest-view-toggle"
					className={`${personalMeetingsEnabled ? "" : "ml-auto "}flex rounded border text-sm`}
				>
					{(["month", "agenda"] as const).map((v) => (
						<button
							key={v}
							type="button"
							className={`px-3 py-0.5 capitalize ${view === v ? "bg-muted font-medium" : ""}`}
							aria-pressed={view === v}
							onClick={() => setView(v)}
						>
							{v}
						</button>
					))}
				</div>
			</div>
			{personalMeetingsEnabled && scope === "all" && (
				<PersonalMeetingsConsent
					consented={consented}
					onEnable={enablePersonal}
					onDisable={handleDisablePersonal}
					showCacheToggle={insightsCacheEnabled}
					cacheEnabled={cacheEnabled}
					onToggleCache={cacheEnabled ? disableCache : enableCache}
					// #2170: the disclosure has to describe the surface the user
					// actually has. Same flag that renders the import action, so
					// the copy and the affordance can never disagree.
					importEnabled={contextImportEnabled}
				/>
			)}
			{personalActive && personalNotConnected && (
				<p className="rounded border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
					Connect your Microsoft account in Settings → Integrations to
					see your personal meetings.
				</p>
			)}
			{personalActive && personalIsError && (
				<p className="text-sm text-destructive">
					Failed to load your personal meetings.
				</p>
			)}
			{personalActive && personalIsLoading && (
				<p className="text-sm text-muted-foreground">
					Loading your personal meetings…
				</p>
			)}
			{hasDigestContent ? (
				view === "month" ? (
					<CalendarCanvas
						monthDate={monthDate}
						meetings={includedMeetings}
						onSelect={setSelected}
						personalMeetings={
							personalActive ? visiblePersonalMeetings : []
						}
						onSelectPersonal={setSelectedPersonal}
						awaitingMeetings={awaitingOccurrences}
					/>
				) : (
					<AgendaView
						monthDate={monthDate}
						meetings={includedMeetings}
						projectId={projectId}
						organizationId={organizationId}
						onSelect={setSelected}
						onToggled={onActionItemToggled}
						onGenerate={generateSummary}
						generatingRefs={generatingRefs}
						summaryErrors={summaryErrors}
						personalMeetings={
							personalActive ? visiblePersonalMeetings : []
						}
						onSelectPersonal={setSelectedPersonal}
						awaitingMeetings={awaitingOccurrences}
					/>
				)
			) : personalPending ? null : (
				<div className="space-y-2">
					<p className="text-sm text-muted-foreground">
						No meetings in the digest yet.
					</p>
					{canEdit && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setShowPicker(true)}
						>
							<PlusIcon className="size-4 mr-1.5" />
							Add meeting
						</Button>
					)}
				</div>
			)}
		</>
	);

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-1.5">
					<h2
						data-onboarding-target="meeting-digest-header"
						className="text-lg font-medium"
					>
						Meeting Digest
					</h2>
					<PageTourButton pageId="meeting-digest" />
				</div>
				{canEdit && (
					<div className="flex items-center gap-3">
						{!configPanelVisible && !genericEmptyStateOnScreen && (
							<button
								type="button"
								className="text-sm underline"
								onClick={() => setShowPicker(true)}
							>
								Add meeting
							</button>
						)}
						<button
							type="button"
							data-onboarding-target="meeting-digest-configure"
							className="text-sm underline"
							onClick={() => setShowConfig((v) => !v)}
						>
							{showConfig ? "Done" : "Configure meetings"}
						</button>
					</div>
				)}
			</div>

			{isError && (
				<p className="text-sm text-destructive">
					Failed to load digest.
				</p>
			)}
			{isLoading && (
				<p className="text-sm text-muted-foreground">Loading…</p>
			)}

			{configPanelVisible && (
				<DigestConfigPanel
					meetings={configMeetings}
					onSetIncluded={handleSetIncluded}
					pendingIncludeIds={pendingIncludeIds}
					onAddMeeting={() => setShowPicker(true)}
					onUnlink={handleUnlink}
				/>
			)}

			{!isLoading &&
				!isError &&
				!showConfig &&
				(meetingAgendaEnabled ? (
					<Tabs
						value={digestTab}
						onValueChange={(value) =>
							setDigestTab(value as "upcoming" | "calendar")
						}
					>
						<TabsList aria-label="Meeting digest views">
							<TabsTrigger value="upcoming">Upcoming</TabsTrigger>
							<TabsTrigger value="calendar">Calendar</TabsTrigger>
						</TabsList>
						<TabsContent value="upcoming" className="mt-4">
							<UpcomingMeetingsSection
								projectId={projectId}
								organizationId={organizationId}
								canEdit={canEdit}
								onLinkMeeting={() => setShowPicker(true)}
								onGenerateAgenda={(meeting) =>
									setAgendaTarget(meeting)
								}
							/>
						</TabsContent>
						<TabsContent
							value="calendar"
							className="mt-4 space-y-4"
						>
							{calendarContent}
						</TabsContent>
					</Tabs>
				) : (
					calendarContent
				))}

			{canEdit && (
				<LinkedMeetingSelector
					projectId={projectId}
					organizationId={organizationId}
					open={showPicker}
					onOpenChange={setShowPicker}
					onLinked={refreshAfterLink}
					existingJoinUrls={joinUrls}
				/>
			)}

			<MeetingDetailSheet
				projectId={projectId}
				organizationId={organizationId}
				transcriptId={selected}
				onClose={() => {
					setSelected(null);
					setHighlightItemKey(null);
				}}
				onActionItemToggled={onActionItemToggled}
				highlightItemKey={highlightItemKey}
				panelExpanded={panelExpanded}
				onPanelExpandedChange={setPanelExpanded}
			/>

			<PersonalMeetingSheet
				projectId={projectId}
				organizationId={organizationId}
				meeting={selectedPersonal}
				onClose={() => setSelectedPersonal(null)}
				userId={userId}
				cacheEnabled={insightsCacheEnabled && cacheEnabled}
				// Flag only, deliberately NOT `&& canEdit`. The server gate is
				// CONTEXT_CREATE, which EDITOR holds, while `canEdit` here means
				// owner/admin/project_admin — so pairing them hid the action from
				// exactly the people who add most of a project's context, and who
				// can already do it unimpeded from the Context tab (which renders
				// ProjectContextsList with no role gate at all). Matching that
				// surface's convention keeps one answer to "may I add context?"
				// instead of two that disagree.
				canImportToContext={contextImportEnabled}
				projectName={projectName}
				panelExpanded={panelExpanded}
				onPanelExpandedChange={setPanelExpanded}
			/>

			{agendaTarget?.linkedMeetingId && (
				<AgendaSheet
					// Keyed on the (meeting, occurrence) identity — not just
					// used as a React list key — so switching agendaTarget to
					// a different meeting/occurrence remounts AgendaSheet
					// instead of reusing the instance. Without this, the poll
					// budget in useMeetingAgenda (pollCount.current, stalled)
					// belongs to the component instance rather than to the
					// meeting being viewed: driving meeting A to `stalled`
					// and then switching straight to a fresh GENERATING
					// meeting B carries that stale state over and B reports
					// stalled on its very first fetch.
					key={`${agendaTarget.linkedMeetingId}:${agendaTarget.startTime}`}
					projectId={projectId}
					organizationId={organizationId}
					linkedMeetingId={agendaTarget.linkedMeetingId}
					occurrenceStart={agendaTarget.startTime}
					meetingSubject={agendaTarget.subject}
					canEdit={canEdit}
					onClose={() => setAgendaTarget(null)}
				/>
			)}
		</div>
	);
}
