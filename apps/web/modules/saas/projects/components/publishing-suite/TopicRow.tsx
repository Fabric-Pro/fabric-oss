"use client";

import {
	AGING_AFTER_DAYS,
	STALE_AFTER_DAYS,
	type TopicNeglect,
} from "@repo/database/src/publishing-inbox";
import { Button } from "@ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNowStrict } from "date-fns";
import {
	AlarmClockIcon,
	AlarmClockOffIcon,
	ChevronDownIcon,
	MailIcon,
	MailOpenIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { AssigneesDialog } from "./AssigneesDialog";
import { ContributorsDialog } from "./ContributorsDialog";
import { DeclineTopicDialog } from "./DeclineTopicDialog";
import { PostTypesDialog } from "./PostTypesDialog";
import { PublishTopicDialog } from "./PublishTopicDialog";
import { type SnoozePreset, SnoozeTopicDialog } from "./SnoozeTopicDialog";
import { TopicDetails, TopicRankReason } from "./TopicDetails";
import {
	type PostType,
	type ProjectMember,
	type PublishingTopic,
	TOPIC_STATUSES,
	type TopicStatus,
} from "./topic-shared";

// ---------------------------------------------------------------------------
// Row: title + pitch + status control (with the styled decline dialog).
//
// Two rendering paths, one set of parts. The flag-off layout below is the
// exact markup that shipped — same element order, same class strings. It is
// the rollback path and stays frozen; do not restructure it to "share more"
// with the Inbox layout.
// ---------------------------------------------------------------------------

/**
 * A wire timestamp as a usable `Date`, or `null` when there is none.
 *
 * Two things make this a guard rather than padding. Timestamps cross the wire
 * as `Date | string` (the same reason `PublishingSuiteList` normalizes before
 * composing the Inbox sections), and an absent one yields an Invalid Date
 * whose `toISOString()` THROWS — inside a row that renders eagerly, that is
 * not a missing line, it is the whole tab.
 */
function toDate(value: Date | string | null | undefined): Date | null {
	if (value == null) {
		return null;
	}
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The wake date in the reader's own locale. Date-only on purpose: a snooze is
 *  a coarse instrument, and a time-of-day would imply a precision that three
 *  fixed presets do not have. */
function formatSnoozeDate(value: Date): string {
	return value.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

export function TopicRow({
	topic,
	canEdit,
	inbox,
	isPending,
	neglect = null,
	isHighlighted = false,
	topicHref,
	members,
	membersPending,
	membersError,
	viewerUserId,
	onChangeStatus,
	onChangePostTypes,
	onChangeContributors,
	onChangeAssignees,
	onSetReadState,
	onSetSnooze,
}: {
	topic: PublishingTopic;
	canEdit: boolean;
	/** PUBLISHING_INBOX. False renders exactly the row that shipped. */
	inbox: boolean;
	/**
	 * Href of this topic's Item Page (#1851 FR2). Passed in rather than built
	 * here: the row has no `projectId` and no tenant context, and giving it a
	 * hook to fetch them would make a presentational component depend on where
	 * it is mounted.
	 */
	topicHref: string;
	/** True while THIS topic's status mutation is in flight (C-Med2). */
	isPending: boolean;
	/**
	 * How long this topic has gone untouched and which threshold that has
	 * passed, or `null` if neither — the very value `topicNeglect` already
	 * computed for the Suggested ordering, so the badge and the sink can never
	 * disagree about the same row.
	 *
	 * Passed in rather than derived here for the same reason `topicHref` is:
	 * the row has no clock of its own, and one `now` per render is what keeps
	 * a row from being badged stale but left un-sunk across a day boundary.
	 * Optional and `null` by default — a mount with no neglect information is
	 * a row that is not neglected, which is what the flag-off path wants.
	 */
	neglect?: TopicNeglect | null;
	/**
	 * Whether this topic is in "Worth a look" — the model ranked it above its
	 * neighbours when the batch was written AND it is still fresh.
	 *
	 * Computed by `composeInboxSections` from the same `now` that decides the
	 * sections, and handed down, so the row's tint and the section it sits in
	 * cannot disagree. `false` by default, which is what the flag-off path and
	 * every non-Inbox mount want.
	 */
	isHighlighted?: boolean;
	/**
	 * The project's members, for the contributors picker. Fetched ONCE in
	 * `PublishingSuiteList` and passed down — a query here would fire once
	 * per rendered topic instead of once per list.
	 */
	members: readonly ProjectMember[];
	/** Whether that shared `members.list` query has not settled, or failed —
	 *  threaded through to `ContributorsDialog` so it can block Save on an
	 *  untrustworthy members list instead of treating `?? []` as "nobody". */
	membersPending: boolean;
	membersError: boolean;
	/** The signed-in user's id, so the contributors picker can label their
	 *  own row ("(You)") and so removing yourself is an obviously available
	 *  action. `null` while the session has not resolved yet. */
	viewerUserId: string | null;
	onChangeStatus: (
		status: TopicStatus,
		declineReason: string | null,
		publishedUrl: string | null,
	) => Promise<void>;
	onChangePostTypes: (postTypes: PostType[] | null) => Promise<void>;
	onChangeContributors: (
		contributorUserIds: string[] | null,
	) => Promise<void>;
	/** A8. No `null` arm: assignees have no AI-resolved set to revert to, so
	 *  `[]` is the only way to clear the list and it means exactly "nobody". */
	onChangeAssignees: (assigneeUserIds: string[]) => Promise<void>;
	onSetReadState: (read: boolean) => Promise<void>;
	onSetSnooze: (
		preset: SnoozePreset | null,
		reason: string | null,
	) => Promise<void>;
}) {
	// Visible hint for the two icon-only controls. The `aria-label` on each
	// button is what a screen reader announces and stays authoritative; this
	// copy is the sighted-mouse equivalent, and says what the control DOES
	// rather than restating its label.
	const t = useTranslations("tooltips.publishing");
	const router = useRouter();
	const [declineOpen, setDeclineOpen] = useState(false);
	const [declinePending, setDeclinePending] = useState(false);
	const [publishOpen, setPublishOpen] = useState(false);
	const [publishPending, setPublishPending] = useState(false);
	const [postTypesOpen, setPostTypesOpen] = useState(false);
	const [postTypesPending, setPostTypesPending] = useState(false);
	const [contributorsOpen, setContributorsOpen] = useState(false);
	const [contributorsPending, setContributorsPending] = useState(false);
	const [assigneesOpen, setAssigneesOpen] = useState(false);
	const [assigneesPending, setAssigneesPending] = useState(false);
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const [snoozePending, setSnoozePending] = useState(false);
	const [expanded, setExpanded] = useState(false);
	// Optimistic read state. `null` means "follow the server"; a boolean is
	// what this user just asked for and has not been confirmed by a refetch
	// yet. Read `isRead` below, never `topic.isRead` directly.
	const [readOverride, setReadOverride] = useState<boolean | null>(null);
	// Optimistic snooze state, same contract as `readOverride` above: `null`
	// means "follow the server", a boolean is what this user just asked for
	// and has not been confirmed by a refetch yet. Read `isSnoozed` below,
	// never `topic.isSnoozed` directly — `changeSnooze` clears the pending
	// set in its `finally`, which re-enables the control while the cache
	// still holds the pre-write value, so an unguarded read renders a stale
	// label and lets a second click fire a redundant (if idempotent) write.
	const [snoozeOverride, setSnoozeOverride] = useState<boolean | null>(null);

	const handleValueChange = (next: string) => {
		if (next === topic.status) {
			return;
		}
		if (next === "DECLINED") {
			// Route through the styled dialog to collect an optional reason.
			setDeclineOpen(true);
			return;
		}
		if (next === "PUBLISHED") {
			// Route through the styled dialog to collect an optional URL.
			setPublishOpen(true);
			return;
		}
		// Fire-and-forget: a failure is surfaced by the shared mutation's
		// onError toast. The catch only prevents an unhandled rejection.
		void onChangeStatus(next as TopicStatus, null, null).catch(() => {});
	};

	// C-Med2: close the dialog only AFTER the decline succeeds, so a failed
	// decline keeps the typed reason (and surfaces the error via the shared
	// onError toast) instead of silently discarding it.
	const handleDeclineConfirm = async (reason: string | null) => {
		setDeclinePending(true);
		try {
			await onChangeStatus("DECLINED", reason, null);
			setDeclineOpen(false);
		} catch {
			// Error already surfaced by the shared mutation's onError toast;
			// keep the dialog open so the reason isn't lost.
		} finally {
			setDeclinePending(false);
		}
	};

	// Two DISTINCT exits (Global Constraints): "Mark as published" (this
	// handler) always mutates — with the typed URL, or `null` when dismissed
	// (FR15). Cancel/Escape/overlay-close never call this handler at all; they
	// only flip `publishOpen` back to false via the dialog's plain
	// `onOpenChange={setPublishOpen}` below, so the topic stays in its prior
	// status with no mutation (ticket line 141).
	const handlePublishConfirm = async (url: string | null) => {
		setPublishPending(true);
		try {
			await onChangeStatus("PUBLISHED", null, url);
			setPublishOpen(false);
		} catch {
			// Error surfaced by the shared mutation onError toast; keep dialog
			// open so the typed URL isn't lost (mirrors decline).
		} finally {
			setPublishPending(false);
		}
	};

	const handlePostTypesSubmit = async (postTypes: PostType[] | null) => {
		setPostTypesPending(true);
		try {
			await onChangePostTypes(postTypes);
			setPostTypesOpen(false);
		} catch {
			// Surfaced by the shared mutation's onError toast; keep the dialog
			// open so the user's checkbox choices aren't lost (mirrors decline).
		} finally {
			setPostTypesPending(false);
		}
	};

	const handleContributorsSubmit = async (
		contributorUserIds: string[] | null,
	) => {
		setContributorsPending(true);
		try {
			await onChangeContributors(contributorUserIds);
			setContributorsOpen(false);
		} catch {
			// Surfaced by the shared mutation's onError toast; keep the dialog
			// open so the user's checkbox choices aren't lost (mirrors
			// handlePostTypesSubmit above).
		} finally {
			setContributorsPending(false);
		}
	};

	const handleAssigneesSubmit = async (assigneeUserIds: string[]) => {
		setAssigneesPending(true);
		try {
			await onChangeAssignees(assigneeUserIds);
			setAssigneesOpen(false);
		} catch {
			// Surfaced by the shared mutation's onError toast; keep the dialog
			// open so the user's checkbox choices aren't lost (mirrors
			// handleContributorsSubmit above).
		} finally {
			setAssigneesPending(false);
		}
	};

	// Close only after success, so a failed write keeps the typed rationale
	// instead of discarding it (same contract as decline and publish).
	const handleSnoozeConfirm = async (
		preset: SnoozePreset,
		reason: string | null,
	) => {
		setSnoozePending(true);
		setSnoozeOverride(true);
		try {
			await onSetSnooze(preset, reason);
			setSnoozeOpen(false);
		} catch {
			// Surfaced by the shared mutation's onError toast; fall back to
			// the server's answer rather than keep claiming snoozed.
			setSnoozeOverride(null);
		} finally {
			setSnoozePending(false);
		}
	};

	// The row's effective read state: what this user last asked for, falling
	// back to what the server last said.
	//
	// This indirection is load-bearing, and the obvious version without it is
	// wrong in two ways at once. `topic.isRead` comes from the query cache,
	// which does NOT update when the write succeeds — it updates when the
	// invalidation refetch lands, several round trips later. Read straight
	// from the prop and, inside that window: expand → collapse → expand sends
	// a SECOND read=true (the upsert moves `readAt`, so it is an observable
	// change, not a harmless repeat), and the manual toggle still renders
	// "Mark as read" for a row the user has just visibly opened, so clicking
	// it sends read=true a third time instead of the unread the label promises.
	const isRead = readOverride ?? topic.isRead;

	// Same indirection, same reason: `topic.isSnoozed` comes from the query
	// cache and does not update until the invalidation refetch lands.
	const isSnoozed = snoozeOverride ?? topic.isSnoozed;

	// Retire each overlay the moment the cache agrees with it. An overlay
	// exists to cover ONE window — the write has succeeded but the
	// invalidation refetch has not landed yet — and outside that window it is
	// not optimism, it is a mask: because the effective value always prefers
	// the overlay, a row that never retires one stops following the server for
	// as long as it stays mounted, and a change made in another tab or by a
	// teammate never appears. Read state is where that bites, since it does
	// not affect section membership; a snooze usually moves the topic out of
	// its section and unmounts the row, which hides the same flaw by accident.
	//
	// Narrow residual, deliberately not chased: if a contradicting write by
	// someone else lands so that this row's refetch never once observes the
	// value we asked for, the overlay stays until the user next acts on the
	// row. Closing that needs the write folded into the query cache with
	// rollback, which is the right shape if this is ever revisited.
	useEffect(() => {
		if (readOverride !== null && topic.isRead === readOverride) {
			setReadOverride(null);
		}
	}, [topic.isRead, readOverride]);

	useEffect(() => {
		if (snoozeOverride !== null && topic.isSnoozed === snoozeOverride) {
			setSnoozeOverride(null);
		}
	}, [topic.isSnoozed, snoozeOverride]);

	// FR4: expanding IS opening. Fires only on the OPEN edge, only when the
	// topic is effectively unread. A failed write drops back to the server's
	// answer rather than leaving a read row that was never recorded.
	//
	// Deliberately NOT also guarded on `!isPending`: a status or post-type
	// write in flight for this same topic must not silently skip the read
	// marker with no retry — that would violate FR4's "expanding IS opening"
	// for the whole window the other write is in flight. The optimistic
	// overlay above already prevents the double-write the old guard existed
	// to avoid, and read markers write a different table from status/post-type
	// changes, so there is no race to lose here.
	const handleToggleExpand = () => {
		const next = !expanded;
		setExpanded(next);
		if (next && !isRead) {
			setReadOverride(true);
			void onSetReadState(true).catch(() => setReadOverride(null));
		}
	};

	const handleManualReadToggle = () => {
		const next = !isRead;
		setReadOverride(next);
		void onSetReadState(next).catch(() => setReadOverride(null));
	};

	// Pairs the disclosure button's `aria-controls` with the expanded region's
	// `id` (standard disclosure pattern). Unique per topic so multiple rows
	// on the same page never collide.
	const detailsRegionId = `topic-details-${topic.id}`;

	// STABLE across any re-render that carries no real change — mirrors
	// `topic.userPostTypes ?? topic.suggestedPostTypes` in the post-types
	// dialog wiring below. Without the memo, `topic.contributors.map(...)`
	// would allocate a NEW array on every render of this row (a parent state
	// change unrelated to contributors, a background refetch that changed
	// nothing, etc.), and `ContributorsDialog` re-seeds its selection whenever
	// this reference changes — silently discarding whatever the user had just
	// checked. `topic.contributors` and `topic.userContributorUserIds`
	// themselves stay referentially stable across a no-op refetch (TanStack
	// Query's structural sharing), so this memo only recomputes when the
	// topic's contributor data has ACTUALLY changed.
	const contributorIds = useMemo(
		() =>
			topic.userContributorUserIds ?? topic.contributors.map((c) => c.id),
		[topic.userContributorUserIds, topic.contributors],
	);

	// A8 needs the SAME referential stability `contributorIds` is memoized for —
	// `AssigneesDialog` re-seeds its selection whenever the reference changes,
	// so a fresh array every render would discard whatever the user just checked
	// — but it needs no `useMemo` to get it. `topic.assigneeUserIds` is a plain
	// column passed straight through, and TanStack Query's structural sharing
	// already keeps it stable across a refetch that changed nothing. A memo whose
	// body is the dependency is ceremony, not a guard. The dialog is handed the
	// RAW ids rather than the resolved `assignees`: the two differ exactly when a
	// handle failed to resolve, and seeding from the handles would let Save
	// silently remove whoever the lookup lost. Anything less direct than a
	// pass-through here (a `??`, a `.map()`) DOES need the memo — see
	// `TopicItemPage`, where the same value is `topic?.assigneeUserIds ?? []`.

	const details = (
		<TopicDetails
			topic={topic}
			canEdit={canEdit}
			isPending={isPending}
			// The Inbox row lifts the rank-reason line into its collapsed
			// summary column below, so the expanded region must not repeat it.
			// The flag-off row has no summary column to lift it into and keeps
			// rendering it here, exactly where it shipped.
			showRankReason={!inbox}
			onEditUrl={() => setPublishOpen(true)}
			onEditPostTypes={() => setPostTypesOpen(true)}
			onEditContributors={() => setContributorsOpen(true)}
			onEditAssignees={() => setAssigneesOpen(true)}
		/>
	);

	const angleChip = topic.angle ? (
		<p className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
			<span className="uppercase tracking-[0.15em] text-muted-foreground">
				Angle
			</span>
			<span className="text-foreground">{topic.angle}</span>
		</p>
	) : null;

	const pitchLine = topic.pitch ? (
		<p className="text-sm leading-6 text-muted-foreground">{topic.pitch}</p>
	) : null;

	// Last activity, mirroring `StoryTile`'s `lastEditedAt ?? createdAt`: what
	// the reader wants at a glance is when the topic was last TOUCHED, not when
	// it was created. The fallback is real rather than ceremonial — a row can
	// reach this component with no usable `updatedAt` at all, and one bad
	// timestamp must cost the age line, never the row.
	const createdAt = toDate(topic.createdAt);
	const lastActivityAt = toDate(topic.updatedAt) ?? createdAt;

	// `<time>` rather than `<span>`: the exact instant is a hover away for a
	// mouse user, so `dateTime` is what carries it everywhere else. It is
	// deliberately NOT given an `aria-label` — `time` has the implicit ARIA
	// role `generic`, which prohibits naming from `aria-label` (the same trap
	// `TopicDetails` documents on its post-type chips), and the relative text
	// is already visible to everyone.
	const ageLine = lastActivityAt ? (
		<Tooltip>
			<TooltipTrigger asChild>
				<time
					dateTime={lastActivityAt.toISOString()}
					className="text-xs text-muted-foreground"
				>
					{formatDistanceToNowStrict(lastActivityAt, {
						addSuffix: true,
					})}
				</time>
			</TooltipTrigger>
			<TooltipContent>
				<div className="space-y-1 text-[11px] leading-snug">
					{createdAt ? (
						<p>{`Created · ${createdAt.toLocaleString()}`}</p>
					) : null}
					<p>{`Updated · ${lastActivityAt.toLocaleString()}`}</p>
				</div>
			</TooltipContent>
		</Tooltip>
	) : null;

	// The badge escalates in FOUR steps rather than two, because "quiet" and
	// "stale" told a reader nothing about how far along the topic was between
	// them — a 12-day row and a 29-day row wore the same pill.
	//
	// The bands stop at 25 and not at 30 on purpose: a topic ARCHIVES out of
	// the list at `STALE_AFTER_DAYS`, so red is the last thing seen before it
	// disappears rather than a state it rests in. Raise the archive threshold
	// and these want revisiting together.
	//
	// Colour is never the only carrier — the number and the word beside it say
	// the same thing, which is what keeps this legible with colour stripped.
	const neglectTone = (days: number) => {
		if (days >= 25) {
			return "border-destructive/70 bg-destructive/15";
		}
		if (days >= 20) {
			return "border-highlight/70 bg-highlight/20";
		}
		if (days >= 15) {
			return "border-highlight/60 bg-highlight/15";
		}
		return "border-highlight/25 bg-highlight/5";
	};

	/**
	 * The whole card opens the topic, not just the title.
	 *
	 * Everything interactive inside the row keeps its own behaviour — the
	 * disclosure chevron, the status select, mute, snooze, the dialogs — so
	 * the handler bails on anything that closest()-matches a control. Without
	 * that, opening the status dropdown would navigate away instead.
	 *
	 * Three more bail-outs, each for a real gesture rather than a hypothetical:
	 * a modified or middle click is "open somewhere else" and belongs to the
	 * anchor, not here; and a click that ends a text selection is someone
	 * copying the pitch, who would lose it to a navigation.
	 */
	const handleRowClick = (event: React.MouseEvent<HTMLLIElement>) => {
		if (event.defaultPrevented || event.button !== 0) {
			return;
		}
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		if (
			(event.target as HTMLElement).closest(
				"a, button, input, select, textarea, [role='button'], [role='dialog'], [role='menu'], [role='listbox']",
			)
		) {
			return;
		}
		if (window.getSelection()?.toString()) {
			return;
		}
		router.push(topicHref);
	};

	/**
	 * Why the model ranked this one above its neighbours.
	 *
	 * The chip is not decoration and not a duplicate of the pitch — it says
	 * WHY, which is the whole difference between a highlight that means
	 * something and one that reads as noise. A tinted surface with no
	 * explanation is exactly the "look at this" badge that stops being looked
	 * at, so the two ship together or not at all.
	 *
	 * `isHighlighted` arrives as a PROP for the same reason `neglect` does: the
	 * row has no clock, and a highlight expires with age. Deriving it here from
	 * `highlightReason !== null` would tint a row that the section composition
	 * had already decided was too old to lift — the two disagreeing about one
	 * topic, across a day boundary, with nothing to make it visible.
	 */
	const highlightChip =
		isHighlighted && topic.highlightReason ? (
			<p className="inline-flex w-fit items-center rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-primary text-xs">
				{topic.highlightReason}
			</p>
		) : null;

	// Never colour alone (WCAG 2.1 AA): the muted surface on the row below is
	// the at-a-glance signal, and this badge is what actually SAYS it — the row
	// stays readable with colour stripped out entirely, and the two tiers are
	// told apart by their WORDS ("quiet" then "stale"), never by their tint.
	//
	// The day count LEADS, in the larger of the two type sizes, because the
	// number is the message; the word trailing it is the editorial label that
	// gives the number its meaning. That is `angleChip`'s value-and-label pill
	// read in the other order, which is why it reuses its geometry rather than
	// inventing a second badge shape for the same row. The thresholds
	// themselves are invisible, so the title names the one just passed.
	const neglectBadge =
		neglect === null ? null : (
			<p
				className={cn(
					"inline-flex w-fit items-baseline gap-1.5 rounded-full border px-2 py-0.5",
					// `bg-card` and not `bg-background` for the quiet pill: the
					// row underneath it is `bg-muted`, and `--background` sits
					// about two units of lightness from that — the same
					// non-step rejected for the row surface below. `--card` is
					// a real step against `--muted` in both themes, and it is
					// what `angleChip` already uses to read as a pill on a row.
					neglectTone(neglect.days),
				)}
				title={`No activity in over ${
					neglect.level === "stale"
						? STALE_AFTER_DAYS
						: AGING_AFTER_DAYS
				} days`}
			>
				<span className="font-semibold text-foreground text-xs tabular-nums">
					{neglect.days}
				</span>{" "}
				<span className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
					{`${neglect.days === 1 ? "day" : "days"} ${neglect.level === "stale" ? "stale" : "quiet"}`}
				</span>
			</p>
		);

	// Fix 2 (external review, flag-ON row only): the Inbox row needs the
	// trigger full-width below `sm:` so it can drop onto its own line at
	// phone widths, while the flag-off row keeps the exact fixed width it has
	// always rendered (pinned by the parity snapshot). A function — rather
	// than a single shared JSX value — keeps that className out of the
	// flag-off call site entirely instead of leaking the responsive variant
	// into a node both branches render.
	const renderStatusSelect = (triggerClassName: string) => (
		<Select
			value={topic.status}
			onValueChange={handleValueChange}
			disabled={!canEdit || isPending}
		>
			<SelectTrigger
				className={triggerClassName}
				aria-label={`Status for ${topic.title}`}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{TOPIC_STATUSES.map((s) => (
					<SelectItem key={s.value} value={s.value}>
						{s.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);

	const dialogs = (
		<>
			<DeclineTopicDialog
				topicTitle={topic.title}
				open={declineOpen}
				onOpenChange={setDeclineOpen}
				onConfirm={handleDeclineConfirm}
				isPending={declinePending}
			/>
			<PublishTopicDialog
				topicTitle={topic.title}
				open={publishOpen}
				onOpenChange={setPublishOpen}
				onConfirm={handlePublishConfirm}
				isPending={publishPending}
				initialUrl={topic.publishedUrl}
				title={
					topic.status === "PUBLISHED"
						? "Edit published URL"
						: undefined
				}
				confirmLabel={topic.status === "PUBLISHED" ? "Save" : undefined}
			/>
			<PostTypesDialog
				topicTitle={topic.title}
				open={postTypesOpen}
				onOpenChange={setPostTypesOpen}
				initialSelected={
					topic.userPostTypes ?? topic.suggestedPostTypes
				}
				hasOverride={topic.userPostTypes !== null}
				hasAiSuggestion={topic.suggestedPostTypes.length > 0}
				onSubmit={handlePostTypesSubmit}
				isPending={postTypesPending}
			/>
			<ContributorsDialog
				topicTitle={topic.title}
				open={contributorsOpen}
				onOpenChange={setContributorsOpen}
				members={members}
				contributors={topic.contributors}
				initialSelected={contributorIds}
				hasOverride={topic.userContributorUserIds !== null}
				viewerUserId={viewerUserId}
				onSubmit={handleContributorsSubmit}
				isPending={contributorsPending}
				membersPending={membersPending}
				membersError={membersError}
			/>
			<AssigneesDialog
				topicTitle={topic.title}
				open={assigneesOpen}
				onOpenChange={setAssigneesOpen}
				members={members}
				assignees={topic.assignees}
				initialSelected={topic.assigneeUserIds}
				viewerUserId={viewerUserId}
				onSubmit={handleAssigneesSubmit}
				isPending={assigneesPending}
				membersPending={membersPending}
				membersError={membersError}
			/>
			<SnoozeTopicDialog
				topicTitle={topic.title}
				open={snoozeOpen}
				onOpenChange={setSnoozeOpen}
				onConfirm={handleSnoozeConfirm}
				isPending={snoozePending}
			/>
		</>
	);

	if (!inbox) {
		return (
			<li className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-4">
				<div className="min-w-0 space-y-1">
					{/* #1851 FR2. The flag-off layout is the rollback path and
					    stays frozen otherwise — this is a deliberate feature
					    addition, not a restructure to share markup with the
					    Inbox layout. Here the title was a plain <p>, so it
					    becomes a link with no disclosure to displace. */}
					<Link
						href={topicHref}
						className="block font-medium text-foreground"
					>
						{topic.title}
					</Link>
					{angleChip}
					{pitchLine}
					{details}
				</div>
				<div className="shrink-0">
					{renderStatusSelect("w-[10rem]")}
				</div>
				{dialogs}
			</li>
		);
	}

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the title is a real
		// anchor and already carries the keyboard and screen-reader path to
		// this destination. Making the row a second focusable control for the
		// same href would add a duplicate tab stop announcing the same thing —
		// worse for a keyboard user, not better. This handler is a MOUSE
		// convenience layered on top of an already-accessible row.
		<li
			onClick={handleRowClick}
			className={cn(
				"cursor-pointer rounded-xl border border-border p-4 transition-colors hover:border-muted-foreground/40",
				// A neglected row recedes by swapping the card surface for the
				// muted one — NOT by `opacity-*`, which would drag every piece
				// of text on the row below the AA contrast floor the rest of
				// the list clears. Nothing here is colour-only: `neglectBadge`
				// above says it in words.
				//
				// ONE surface step, taken at the EARLIER threshold, which is
				// where the owner asked for "less visible by colour". A second
				// step for stale would have to sit between `--card` and
				// `--muted`, and in light mode that gap is about two units of
				// lightness — a graduation visible in the code and in nothing
				// else. Stale escalates where the escalation can actually be
				// seen: the badge tint, its word, and the sink.
				// Hot GAINS exactly what aging loses, so one axis carries the
				// whole gradient: tinted, card, muted, gone. A second visual
				// vocabulary for "look at this" would compete with the one
				// already saying "stop looking at this".
				neglect !== null
					? "bg-muted"
					: isHighlighted
						? "border-primary/40 bg-primary/5"
						: "bg-card",
			)}
		>
			{/* Fix 2 (external review): `flex-wrap` lets the action cluster
			    drop below the title instead of squeezing it at phone widths.
			    `basis-full sm:basis-auto` gives the summary column the whole
			    row to itself below `sm:` (forcing the wrap) and restores its
			    original flex-1 sizing at `sm:` and up. */}
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 flex-1 basis-full space-y-1 sm:basis-auto">
					<div className="flex items-start gap-2">
						{isRead ? null : (
							<span
								className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
								aria-hidden="true"
							/>
						)}
						{/* #1851 FR2: the title is a real anchor to the Topic
						    Item Page, so middle-click, Ctrl+click and "open in
						    new tab" work. It cannot live INSIDE the disclosure
						    button — a link nested in a button is invalid and
						    breaks the button's accessible name — so the
						    disclosure moved to its own chevron below. */}
						<Link
							href={topicHref}
							className="min-w-0 flex-1 text-left"
						>
							<span
								className={cn(
									"text-foreground",
									isRead ? "font-medium" : "font-semibold",
								)}
							>
								{topic.title}
							</span>
						</Link>
						<button
							type="button"
							data-testid="topic-disclosure"
							aria-expanded={expanded}
							aria-controls={detailsRegionId}
							// Never colour alone: `aria-label` is what a screen
							// reader actually hears, and it takes precedence
							// over the visible span's own text ("name from
							// content"), so this is the ONLY string announced
							// — no risk of the read/unread suffix picking up a
							// stray join-space from concatenating two child
							// nodes' accessible names.
							//
							// #1851: this label MOVED here from the title,
							// which is now a link. It has to keep the exact
							// same text — it is the row's only non-colour
							// unread signal, and `publishing-suite-inbox`
							// asserts on it by accessible name.
							aria-label={`${topic.title}, ${
								isRead ? "read" : "unread"
							}`}
							onClick={handleToggleExpand}
							className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
						>
							<ChevronDownIcon
								className={cn(
									"size-4 transition-transform duration-200",
									expanded && "rotate-180",
								)}
								aria-hidden="true"
							/>
						</button>
					</div>
					{angleChip}
					{pitchLine}
					{/* One metadata line, not three stacked paragraphs. The
					    age moved OUT of here entirely — it lives in the action
					    column now, beside the status it belongs with — and the
					    role reason became a pill, because four consecutive
					    lines of grey text is exactly how both of them stopped
					    being read.

					    `break-words` stays on the reason: it joins every
					    matched tag and is unbounded, and this is the one mount
					    where a single long token could push the row wider than
					    its container. */}
					{topic.rankReason || neglectBadge || highlightChip ? (
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-0.5">
							{highlightChip}
							<TopicRankReason
								topic={topic}
								variant="pill"
								className="break-words"
							/>
							{neglectBadge}
						</div>
					) : null}
					{isSnoozed && topic.snoozedUntil ? (
						<p className="text-xs text-muted-foreground">
							Snoozed until{" "}
							{formatSnoozeDate(new Date(topic.snoozedUntil))}
						</p>
					) : null}
				</div>
				<div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
					{/* Age sits with the controls that describe the topic's
					    state, not at the bottom of the summary column where it
					    was competing with three other grey lines for the same
					    glance. Hidden below `sm:` — at phone widths this
					    cluster wraps under the title and the row is short
					    enough that "when" is one scroll away, not lost. */}
					<span className="hidden sm:inline-flex">{ageLine}</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label={
									isRead ? "Mark as unread" : "Mark as read"
								}
								disabled={isPending}
								onClick={handleManualReadToggle}
							>
								{isRead ? (
									<MailIcon
										className="size-4"
										aria-hidden="true"
									/>
								) : (
									<MailOpenIcon
										className="size-4"
										aria-hidden="true"
									/>
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{isRead ? t("markUnread") : t("markRead")}
						</TooltipContent>
					</Tooltip>
					{canEdit ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									data-onboarding-target="publishing-suite-snooze"
									aria-label={
										isSnoozed ? "Unsnooze" : "Snooze"
									}
									disabled={isPending}
									onClick={() => {
										if (isSnoozed) {
											setSnoozeOverride(false);
											void onSetSnooze(null, null).catch(
												() => setSnoozeOverride(null),
											);
											return;
										}
										setSnoozeOpen(true);
									}}
								>
									{isSnoozed ? (
										<AlarmClockOffIcon
											className="size-4"
											aria-hidden="true"
										/>
									) : (
										<AlarmClockIcon
											className="size-4"
											aria-hidden="true"
										/>
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{isSnoozed ? t("unsnooze") : t("snooze")}
							</TooltipContent>
						</Tooltip>
					) : null}
					{renderStatusSelect("w-full sm:w-[10rem]")}
				</div>
			</div>
			{expanded ? (
				<div
					id={detailsRegionId}
					className="mt-3 space-y-1 border-t border-border pt-3"
				>
					{details}
					{topic.status === "DECLINED" &&
					topic.declineReason?.trim() ? (
						<div className="pt-2">
							<span className="app-editorial-label">
								Why this was declined
							</span>
							<p className="mt-1 text-sm leading-6 text-muted-foreground">
								{topic.declineReason.trim()}
							</p>
						</div>
					) : null}
					{isSnoozed && topic.snoozeReason?.trim() ? (
						<p className="pt-2 text-xs text-muted-foreground">
							Snooze note — {topic.snoozeReason.trim()}
						</p>
					) : null}
				</div>
			) : null}
			{dialogs}
		</li>
	);
}
