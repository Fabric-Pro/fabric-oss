"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { format, isSameMonth } from "date-fns";
import { useState } from "react";
import { mergeDayRows } from "../lib/day-rows";
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
					const isExpanded = expandedDay === key;
					// The cell shows the day's earliest meetings, whatever kind
					// they are, and defers the rest to "+N more" — so it always
					// reads as the start of that day rather than a selection out
					// of it. The badge cap keeps a busy day from blowing out the
					// cell height.
					const dayRows = mergeDayRows({
						team: grouped.get(key),
						awaiting: awaitingGrouped.get(key),
						personal: personalGrouped.get(key),
					});
					const total = dayRows.length;
					const rows = isExpanded
						? dayRows
						: dayRows.slice(0, MAX_BADGES);
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
								{rows.map((row) =>
									row.kind === "team" ? (
										<li key={row.key}>
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														onClick={() =>
															onSelect(
																row.meeting
																	.transcriptId,
															)
														}
														className="w-full truncate rounded bg-primary/10 px-1 py-0.5 text-left text-xs hover:bg-primary/20"
													>
														{row.meeting.subject ??
															"Meeting"}
													</button>
												</TooltipTrigger>
												<TooltipContent>
													{row.meeting.subject ??
														"Meeting"}
												</TooltipContent>
											</Tooltip>
										</li>
									) : row.kind === "awaiting" ? (
										<li key={row.key}>
											<AwaitingCalendarBadge
												meeting={row.meeting}
											/>
										</li>
									) : (
										<li key={row.key}>
											<PersonalCalendarBadge
												meeting={row.meeting}
												onSelect={onSelectPersonal}
											/>
										</li>
									),
								)}
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
