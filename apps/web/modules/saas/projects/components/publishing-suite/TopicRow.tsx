"use client";

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
import {
	AlarmClockIcon,
	AlarmClockOffIcon,
	ChevronDownIcon,
	MailIcon,
	MailOpenIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { DeclineTopicDialog } from "./DeclineTopicDialog";
import { PostTypesDialog } from "./PostTypesDialog";
import { PublishTopicDialog } from "./PublishTopicDialog";
import { type SnoozePreset, SnoozeTopicDialog } from "./SnoozeTopicDialog";
import { TopicDetails } from "./TopicDetails";
import {
	type PostType,
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
	topicHref,
	onChangeStatus,
	onChangePostTypes,
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
	onChangeStatus: (
		status: TopicStatus,
		declineReason: string | null,
		publishedUrl: string | null,
	) => Promise<void>;
	onChangePostTypes: (postTypes: PostType[] | null) => Promise<void>;
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
	const [declineOpen, setDeclineOpen] = useState(false);
	const [declinePending, setDeclinePending] = useState(false);
	const [publishOpen, setPublishOpen] = useState(false);
	const [publishPending, setPublishPending] = useState(false);
	const [postTypesOpen, setPostTypesOpen] = useState(false);
	const [postTypesPending, setPostTypesPending] = useState(false);
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

	const details = (
		<TopicDetails
			topic={topic}
			canEdit={canEdit}
			isPending={isPending}
			onEditUrl={() => setPublishOpen(true)}
			onEditPostTypes={() => setPostTypesOpen(true)}
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
		<li className="rounded-xl border border-border bg-card p-4">
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
					{isSnoozed && topic.snoozedUntil ? (
						<p className="text-xs text-muted-foreground">
							Snoozed until{" "}
							{formatSnoozeDate(new Date(topic.snoozedUntil))}
						</p>
					) : null}
				</div>
				<div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
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
