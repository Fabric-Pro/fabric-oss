"use client";

import { format } from "date-fns";
import {
	CalendarClockIcon,
	FileTextIcon,
	LinkIcon,
	RefreshCwIcon,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	type AgendaStatus,
	type UpcomingMeeting,
	useUpcomingMeetings,
} from "../hooks/use-upcoming-meetings";
import { groupUpcomingByDay } from "../lib/group-upcoming";
import { AgendaStatusIndicator } from "./AgendaStatusIndicator";
import { LazyDaysSentinel } from "./LazyDaysSentinel";

/**
 * The upcoming list reads the caller's delegated Microsoft/Teams calendar, which
 * is a per-user MICROSOFT_GRAPH connection — NOT the org "Microsoft 365" knowledge
 * connector. Deep-link the not-connected CTA straight to that provider's connect
 * page so the user lands on the "Connect Microsoft 365" button, not the knowledge
 * card that can't grant calendar access. Derived from the current path so it works
 * in both the org (/app/{slug}/…) and personal (/app/…) routes; trailing slash is
 * stripped so the personal case doesn't produce a double slash.
 */
function microsoftConnectHref(pathname: string): string {
	const base = pathname.split("/projects/")[0].replace(/\/$/, "");
	return `${base}/settings/integrations/actions/MICROSOFT_GRAPH`;
}

/**
 * The row button opens the agenda sheet in every state — it does not generate
 * anything directly. Labelling it "Generate agenda" next to a row already
 * flagged "Agenda ready" therefore described neither what exists nor what the
 * click does, and read as an offer to overwrite work that was already there.
 * Each label below names what the user actually gets.
 */
export function agendaActionLabel(agendaStatus: AgendaStatus | null): string {
	switch (agendaStatus) {
		case "READY":
		case "GENERATING":
			return "View agenda";
		// A failed row still exists and the sheet opens on its error with a
		// retry, so "view" would undersell the one action worth taking.
		case "FAILED":
			return "Retry agenda";
		default:
			return "Generate agenda";
	}
}

function AgendaActionIcon({
	agendaStatus,
	className,
}: {
	agendaStatus: AgendaStatus | null;
	className?: string;
}) {
	// Sparkles reads as "make something new", which is only true before an
	// agenda exists.
	if (agendaStatus === "READY" || agendaStatus === "GENERATING") {
		return <FileTextIcon className={className} />;
	}
	if (agendaStatus === "FAILED") {
		return <RefreshCwIcon className={className} />;
	}
	return <SparklesIcon className={className} />;
}

interface ListProps {
	meetings: UpcomingMeeting[];
	canEdit: boolean;
	/** Injected so "Today"/"Tomorrow" are deterministic in tests. */
	now?: Date;
	/** Whether the later-days window has loaded — scopes the empty-state copy. */
	hasLoadedLater?: boolean;
	onLinkMeeting: (meeting: UpcomingMeeting) => void;
	onGenerateAgenda: (meeting: UpcomingMeeting) => void;
}

/**
 * Presentational list — split from the data-fetching wrapper so it can be
 * rendered in tests without a query client, matching the TranscriptBody split
 * made for #1899.
 *
 * Grouped under day headings (#2106, FR1). Days with no meetings never appear;
 * grouping itself lives in `groupUpcomingByDay` so the date arithmetic can be
 * tested without rendering.
 */
export function UpcomingMeetingsList({
	meetings,
	canEdit,
	now,
	hasLoadedLater = false,
	onLinkMeeting,
	onGenerateAgenda,
}: ListProps) {
	const groups = groupUpcomingByDay(meetings, now ?? new Date());

	if (groups.length === 0) {
		// Scoped to the window actually fetched. On first paint only today and
		// tomorrow have been looked at, so claiming the fortnight is empty would
		// tell a user with a full week ahead that they are free — the Friday
		// evening case, where the near window is a quiet weekend.
		return (
			<p className="rounded border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
				{hasLoadedLater
					? "No meetings scheduled in the next two weeks."
					: "No meetings scheduled in the next two days."}
			</p>
		);
	}

	return (
		<div className="space-y-3">
			{groups.map((group) => (
				<section
					key={group.key}
					aria-labelledby={`upcoming-${group.key}`}
				>
					<h4
						id={`upcoming-${group.key}`}
						className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
					>
						{group.label}
					</h4>
					<ul className="divide-y rounded border">
						{group.meetings.map((meeting) => (
							<li
								key={`${meeting.joinUrl}:${meeting.startTime}`}
								className="flex items-center justify-between gap-3 px-3 py-2"
							>
								<div className="flex min-w-0 items-center gap-2.5">
									<AgendaStatusIndicator
										linkedMeetingId={
											meeting.linkedMeetingId
										}
										agendaStatus={meeting.agendaStatus}
									/>
									<div className="min-w-0">
										<p className="truncate text-sm font-medium">
											{meeting.subject}
										</p>
										<p className="text-xs text-muted-foreground">
											{format(
												new Date(meeting.startTime),
												"HH:mm",
											)}
											{" · "}
											{meeting.organizer}
										</p>
									</div>
								</div>

								{canEdit &&
									(meeting.linkedMeetingId ? (
										<button
											type="button"
											className="inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
											onClick={() =>
												onGenerateAgenda(meeting)
											}
										>
											<AgendaActionIcon
												agendaStatus={
													meeting.agendaStatus
												}
												className="size-3.5"
											/>
											{agendaActionLabel(
												meeting.agendaStatus,
											)}
										</button>
									) : (
										<button
											type="button"
											className="inline-flex shrink-0 items-center gap-1 rounded border border-dashed px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
											onClick={() =>
												onLinkMeeting(meeting)
											}
										>
											<LinkIcon className="size-3.5" />
											Link to generate agenda
										</button>
									))}
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

interface SectionProps {
	projectId: string;
	organizationId?: string | null;
	canEdit: boolean;
	onLinkMeeting: (meeting: UpcomingMeeting) => void;
	onGenerateAgenda: (meeting: UpcomingMeeting) => void;
}

export function UpcomingMeetingsSection({
	projectId,
	organizationId,
	canEdit,
	onLinkMeeting,
	onGenerateAgenda,
}: SectionProps) {
	const pathname = usePathname();
	const {
		meetings,
		isLoading,
		isError,
		notConnected,
		loadLater,
		isLoadingLater,
		isLaterError,
		hasLoadedLater,
	} = useUpcomingMeetings({
		projectId,
		organizationId,
		enabled: true,
	});

	return (
		<section
			className="space-y-2"
			aria-labelledby="upcoming-meetings-heading"
		>
			<h3
				id="upcoming-meetings-heading"
				className="flex items-center gap-1.5 text-sm font-semibold"
			>
				<CalendarClockIcon className="size-4" />
				Upcoming
			</h3>

			{isLoading && (
				<p className="text-sm text-muted-foreground">
					Loading upcoming meetings…
				</p>
			)}

			{notConnected && (
				<p className="rounded border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
					<Link
						href={microsoftConnectHref(pathname)}
						className="font-medium text-primary underline underline-offset-2"
					>
						Connect Microsoft
					</Link>{" "}
					to see your upcoming meetings.
				</p>
			)}

			{isError && !notConnected && (
				<p className="rounded border border-destructive/40 px-3 py-2 text-sm text-destructive">
					Couldn't load upcoming meetings. Please try again.
				</p>
			)}

			{!isLoading && !isError && !notConnected && (
				<>
					<UpcomingMeetingsList
						meetings={meetings}
						canEdit={canEdit}
						hasLoadedLater={hasLoadedLater}
						onLinkMeeting={onLinkMeeting}
						onGenerateAgenda={onGenerateAgenda}
					/>
					{!hasLoadedLater && (
						<LazyDaysSentinel
							onLoad={loadLater}
							isLoading={isLoadingLater}
							isError={isLaterError}
						/>
					)}
				</>
			)}
		</section>
	);
}
