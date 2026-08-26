"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { format, isSameMonth } from "date-fns";
import { useState } from "react";
import {
	dayKey,
	groupAwaitingByDay,
	groupMeetingsByDay,
	groupPersonalMeetingsByDay,
	monthGridDays,
} from "../lib/group-meetings";
import type {
	AwaitingMeeting,
	DigestMeeting,
	PersonalMeeting,
} from "../lib/types";
import { AwaitingCalendarBadge } from "./AwaitingTranscriptRow";
import { PersonalCalendarBadge } from "./PersonalMeetingRow";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_BADGES = 3;

export function CalendarCanvas({
	monthDate,
	meetings,
	onSelect,
	personalMeetings = [],
	onSelectPersonal,
	awaitingMeetings = [],
}: {
	monthDate: Date;
	meetings: DigestMeeting[];
	onSelect: (transcriptId: string) => void;
	personalMeetings?: PersonalMeeting[];
	onSelectPersonal?: (meeting: PersonalMeeting) => void;
	awaitingMeetings?: AwaitingMeeting[];
}) {
	const grouped = groupMeetingsByDay(meetings);
	const personalGrouped = groupPersonalMeetingsByDay(personalMeetings);
	const awaitingGrouped = groupAwaitingByDay(awaitingMeetings);
	const days = monthGridDays(monthDate);
	const [expandedDay, setExpandedDay] = useState<string | null>(null);

	return (
		<div>
			<div className="grid grid-cols-7 border-b text-xs font-medium text-muted-foreground">
				{WEEKDAYS.map((d) => (
					<div key={d} className="px-2 py-1">
						{d}
					</div>
				))}
			</div>
			<div className="grid grid-cols-7">
				{days.map((day) => {
					const key = dayKey(day);
					const items = grouped.get(key) ?? [];
					const personalItems = personalGrouped.get(key) ?? [];
					const awaitingItems = awaitingGrouped.get(key) ?? [];
					const total =
						items.length +
						personalItems.length +
						awaitingItems.length;
					const isExpanded = expandedDay === key;
					const visible = isExpanded
						? items
						: items.slice(0, MAX_BADGES);
					// Personal and awaiting badges share the 3-badge budget: a
					// busy calendar must not blow out the cell height.
					//
					// Order is by how much the row belongs to the TEAM's view of
					// the project: synced project meetings, then awaiting ones,
					// then the viewer's own personal calendar. Awaiting rows sit
					// above personal deliberately (DEF-1, #2051 staging QA) —
					// they are team content, and letting a viewer's private
					// entries push them behind "+N more" defeats the point of
					// surfacing them on the calendar at all.
					const visibleAwaiting = isExpanded
						? awaitingItems
						: awaitingItems.slice(
								0,
								Math.max(0, MAX_BADGES - visible.length),
							);
					const visiblePersonal = isExpanded
						? personalItems
						: personalItems.slice(
								0,
								Math.max(
									0,
									MAX_BADGES -
										visible.length -
										visibleAwaiting.length,
								),
							);
					return (
						<div
							key={day.toISOString()}
							className={cn(
								"min-h-[96px] border-b border-r p-1 align-top",
								!isSameMonth(day, monthDate) &&
									"bg-muted/30 text-muted-foreground",
							)}
						>
							<div className="text-xs">{format(day, "d")}</div>
							<ul className="mt-1 space-y-1">
								{visible.map((meeting) => (
									<li key={meeting.transcriptId}>
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={() =>
														onSelect(
															meeting.transcriptId,
														)
													}
													className="w-full truncate rounded bg-primary/10 px-1 py-0.5 text-left text-xs hover:bg-primary/20"
												>
													{meeting.subject ??
														"Meeting"}
												</button>
											</TooltipTrigger>
											<TooltipContent>
												{meeting.subject ?? "Meeting"}
											</TooltipContent>
										</Tooltip>
									</li>
								))}
								{visibleAwaiting.map((meeting) => (
									<li
										key={`${meeting.linkedMeetingId}:${new Date(meeting.occurrenceStart).toISOString()}`}
									>
										<AwaitingCalendarBadge
											meeting={meeting}
										/>
									</li>
								))}
								{visiblePersonal.map((meeting) => (
									<li key={meeting.id}>
										<PersonalCalendarBadge
											meeting={meeting}
											onSelect={onSelectPersonal}
										/>
									</li>
								))}
								{total > MAX_BADGES && (
									<li>
										<button
											type="button"
											className="px-1 text-xs text-muted-foreground underline"
											onClick={() =>
												setExpandedDay(
													isExpanded ? null : key,
												)
											}
										>
											{isExpanded
												? "Show less"
												: `+${total - MAX_BADGES} more`}
										</button>
									</li>
								)}
							</ul>
						</div>
					);
				})}
			</div>
		</div>
	);
}
