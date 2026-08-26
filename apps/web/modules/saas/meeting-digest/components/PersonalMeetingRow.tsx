"use client";

/**
 * Row affordances for meetings the team view did not render (#1899, FR5).
 *
 * Two kinds of row arrive here, and they mean opposite things about privacy:
 *
 *   - a genuine PERSONAL meeting from the caller's own calendar, private to
 *     them and never stored; and
 *   - a linked PROJECT meeting whose transcript has not synced, which the team
 *     view could not render because it builds rows from transcripts (DEF-0).
 *     This one is shared with the team.
 *
 * Labelling the second "Personal" would assert privacy it does not have, so
 * every distinction channel switches on `linkedWithoutTranscript`. Two
 * independent channels — text badge and an icon carrying an accessible name —
 * because colour alone fails the accessibility NFR. The dashed border is a
 * third, purely decorative cue.
 */
import { Badge } from "@ui/components/badge";
import { UserIcon } from "lucide-react";
import type { PersonalMeeting } from "../lib/types";
import { AWAITING_PRESENTATION } from "./awaiting-presentation";

function rowPresentation(meeting: PersonalMeeting) {
	return meeting.linkedWithoutTranscript
		? // Shared with the #2051 team rows so the two cannot drift — they
			// describe the same state and can appear on the same calendar.
			{ ...AWAITING_PRESENTATION }
		: {
				Icon: UserIcon,
				iconLabel: "Personal meeting",
				badge: "Personal",
				titleSuffix: "personal",
			};
}

/** Agenda-view row. */
export function PersonalAgendaRow({
	meeting,
	onSelect,
}: {
	meeting: PersonalMeeting;
	onSelect?: (meeting: PersonalMeeting) => void;
}) {
	const { Icon, iconLabel, badge } = rowPresentation(meeting);

	return (
		<button
			type="button"
			onClick={() => onSelect?.(meeting)}
			className="flex w-full items-center gap-2 rounded border border-dashed p-3 text-left text-sm hover:bg-muted/50"
		>
			<Icon
				className="size-4 shrink-0 text-muted-foreground"
				aria-label={iconLabel}
			/>
			<span className="font-medium">{meeting.subject}</span>
			<Badge variant="outline" className="ml-auto">
				{badge}
			</Badge>
		</button>
	);
}

/** Compact calendar-cell badge. */
export function PersonalCalendarBadge({
	meeting,
	onSelect,
}: {
	meeting: PersonalMeeting;
	onSelect?: (meeting: PersonalMeeting) => void;
}) {
	const { Icon, iconLabel, badge, titleSuffix } = rowPresentation(meeting);

	return (
		<button
			type="button"
			onClick={() => onSelect?.(meeting)}
			title={`${meeting.subject} (${titleSuffix})`}
			className="flex w-full flex-col items-stretch rounded border border-dashed px-1 py-0.5 text-left text-xs hover:bg-muted/50"
		>
			<span className="flex items-center gap-1 truncate">
				<Icon
					className="size-3 shrink-0 text-muted-foreground"
					aria-label={iconLabel}
				/>
				<span className="truncate">{meeting.subject}</span>
			</span>
			{/*
			 * Shared meetings only. The icon and the tooltip were the sole
			 * distinction here, and neither survives a screenshot — which is
			 * how a shared meeting came to be read as a private one. Text is
			 * the third non-colour channel the a11y NFR already asks for in
			 * the agenda row; the calendar cell simply dropped it.
			 *
			 * Its own line, not a `shrink-0` neighbour of the subject: sharing
			 * the row, the marker took roughly half of it, leaving the subject
			 * ~13 characters at 1600px and ~5 at 1280px. Both channels have to
			 * survive, and only one of the two dimensions is scarce here —
			 * a calendar cell can give up height far more cheaply than width.
			 * Indented to clear the icon so the two lines read as one chip.
			 */}
			{meeting.linkedWithoutTranscript && (
				<span className="pl-4 text-[10px] text-muted-foreground">
					{badge}
				</span>
			)}
		</button>
	);
}
