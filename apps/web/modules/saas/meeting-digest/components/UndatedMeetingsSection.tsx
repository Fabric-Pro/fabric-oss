"use client";

/**
 * Meetings with no known date (Fizzy #3507, FR16).
 *
 * A transcript from a folder whose file named no date belongs to no day, so
 * the calendar cannot show it. It is listed here instead, never under the day
 * it was imported, until someone gives it a date.
 */

import { CalendarX2Icon } from "lucide-react";
import type { UndatedMeeting } from "../lib/types";

export function UndatedMeetingsSection({
	meetings,
	onSelect,
	onSetDate,
}: {
	meetings: UndatedMeeting[];
	onSelect: (transcriptId: string) => void;
	/** Absent for someone who cannot change the digest. */
	onSetDate?: (meeting: UndatedMeeting) => void;
}) {
	if (meetings.length === 0) {
		return null;
	}

	return (
		<section
			aria-labelledby="undated-meetings-heading"
			className="space-y-2"
		>
			<h3
				id="undated-meetings-heading"
				className="flex items-center gap-2 font-medium text-sm"
			>
				<CalendarX2Icon aria-hidden="true" className="size-4" />
				Unknown date
			</h3>
			<ul className="divide-y rounded-lg border">
				{meetings.map((meeting) => (
					<li
						key={meeting.id}
						className="flex items-center justify-between gap-3 px-3 py-2"
					>
						<button
							type="button"
							className="min-w-0 truncate text-left text-sm underline-offset-2 hover:underline"
							onClick={() => onSelect(meeting.transcriptId)}
						>
							{meeting.meetingSubject ?? "Untitled meeting"}
						</button>
						{onSetDate && (
							<button
								type="button"
								className="shrink-0 text-sm underline"
								onClick={() => onSetDate(meeting)}
							>
								Set date
							</button>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}
