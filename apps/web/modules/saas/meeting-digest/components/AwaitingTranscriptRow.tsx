"use client";

/**
 * Inert rows for included linked meetings whose transcript has not synced
 * (#2051).
 *
 * Deliberately NOT buttons. MeetingDetailSheet is gated entirely on
 * `transcriptId` and keyed by it, so there is nothing for a click to open — a
 * clickable row here would open an empty sheet and assert content exists.
 */
import { Badge } from "@ui/components/badge";
import type { AwaitingMeeting } from "../lib/types";
import { AWAITING_PRESENTATION } from "./awaiting-presentation";

const { Icon, iconLabel, badge, titleSuffix } = AWAITING_PRESENTATION;

const subjectOf = (meeting: AwaitingMeeting) =>
	meeting.subject ?? "Untitled meeting";

/** Compact calendar-cell badge. */
export function AwaitingCalendarBadge({
	meeting,
}: {
	meeting: AwaitingMeeting;
}) {
	return (
		<div
			title={`${subjectOf(meeting)} (${titleSuffix})`}
			className="flex w-full flex-col items-stretch rounded border border-dashed px-1 py-0.5 text-left text-xs text-muted-foreground"
		>
			<span className="flex items-center gap-1 truncate">
				<Icon className="size-3 shrink-0" aria-label={iconLabel} />
				<span className="truncate">{subjectOf(meeting)}</span>
			</span>
			{/*
			 * Mirrors PersonalCalendarBadge's text marker exactly — the icon and
			 * tooltip alone are invisible in a screenshot, and these two rows
			 * share one calendar cell and must render the "linked, no
			 * transcript yet" state identically (see awaiting-presentation.tsx).
			 *
			 * On its own line for the reason spelled out there: side by side,
			 * the marker cost the subject more width than the cell had to give.
			 */}
			<span className="pl-4 text-[10px] text-muted-foreground">
				{badge}
			</span>
		</div>
	);
}

/** Agenda-view row. */
export function AwaitingAgendaRow({ meeting }: { meeting: AwaitingMeeting }) {
	return (
		<div className="flex w-full items-center gap-2 rounded border border-dashed p-3 text-left text-sm text-muted-foreground">
			<Icon className="size-4 shrink-0" aria-label={iconLabel} />
			<span className="font-medium">{subjectOf(meeting)}</span>
			<Badge variant="outline" className="ml-auto">
				{badge}
			</Badge>
		</div>
	);
}
