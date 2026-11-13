"use client";

import { formatDurationMinutes } from "@repo/utils/time-tracking";
import { cn } from "@ui/lib";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useRef } from "react";
import { longDateLabel, shortDayLabel } from "../lib/date-labels";
import { type EntrySelection, emptyDraft } from "../lib/entry-draft";
import {
	groupDayEntries,
	type LoggableProject,
	minutesByDate,
	newEntryDefaults,
	type TimeEntry,
} from "../lib/time-entry-model";
import { TimeEntryForm } from "./TimeEntryForm";
import { TimeEntryRow } from "./TimeEntryRow";

/**
 * One day: the week's days to jump between, the quick entry line for the
 * selected day, and that day's entries grouped by project.
 */
export function DayView({
	organizationId,
	date,
	today,
	weekDates,
	entries,
	projects,
	timeZone,
	focusToken,
	onSelectDate,
	onQuickEntryChange,
}: {
	organizationId: string;
	date: string;
	today: string;
	weekDates: readonly string[];
	entries: readonly TimeEntry[];
	projects: readonly LoggableProject[];
	timeZone: string;
	focusToken: number;
	onSelectDate: (date: string) => void;
	/** The entry line's project, activity and work item, as they change. */
	onQuickEntryChange?: (selection: EntrySelection) => void;
}) {
	const t = useTranslations("timeTracking.day");
	const locale = useLocale();
	const totals = useMemo(
		() => minutesByDate(entries, weekDates),
		[entries, weekDates],
	);
	const groups = useMemo(
		() => groupDayEntries(entries, date),
		[entries, date],
	);
	const defaults = newEntryDefaults(entries, projects);
	const entriesRef = useRef<HTMLElement>(null);

	return (
		<div className="space-y-4">
			<div className="overflow-x-auto">
				<div
					className="grid min-w-[660px] grid-cols-7 gap-2"
					data-onboarding-target="time-day-strip"
				>
					{weekDates.map((day) => {
						const selected = day === date;
						return (
							<button
								key={day}
								type="button"
								aria-pressed={selected}
								onClick={() => onSelectDate(day)}
								className={cn(
									"flex flex-col gap-0.5 rounded-md border bg-card px-3 py-2 text-left",
									"motion-safe:transition-colors motion-safe:duration-150 hover:border-muted-foreground",
									"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
									selected
										? "border-2 border-primary px-[11px] py-[7px]"
										: "border-border",
								)}
							>
								<span className="text-muted-foreground text-xs">
									{shortDayLabel(day, locale)}
									{day === today ? ` · ${t("today")}` : ""}
								</span>
								<span
									className={cn(
										"font-semibold text-sm tabular-nums",
										totals[day] === 0 &&
											"text-muted-foreground",
									)}
								>
									{totals[day] > 0
										? formatDurationMinutes(totals[day])
										: "–"}
								</span>
							</button>
						);
					})}
				</div>
			</div>

			<section
				aria-label={t("logTime")}
				className="rounded-lg border border-border bg-card p-4"
				data-onboarding-target="time-quick-entry"
			>
				{projects.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						{t("noLoggableProjects")}
					</p>
				) : (
					<TimeEntryForm
						key={date}
						organizationId={organizationId}
						projects={projects}
						initialDraft={emptyDraft({
							projectId: defaults.projectId,
							activity: defaults.activity,
							workDate: date,
							timezone: timeZone,
						})}
						knownEntries={entries}
						focusToken={focusToken}
						onSelectionChange={onQuickEntryChange}
					/>
				)}
			</section>

			<section
				ref={entriesRef}
				tabIndex={-1}
				aria-label={t("entriesFor", {
					date: longDateLabel(date, locale),
				})}
				className="overflow-hidden rounded-lg border border-border bg-card focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
			>
				{groups.length === 0 ? (
					<p className="px-4 py-6 text-center text-muted-foreground text-sm">
						{t("noEntries")}
					</p>
				) : (
					groups.map((group) => (
						<div
							key={group.projectId}
							className="border-t border-border first:border-t-0"
						>
							<div className="flex items-center justify-between bg-muted/50 px-4 py-2 font-semibold text-sm">
								<span>{group.projectName}</span>
								<span className="tabular-nums">
									{formatDurationMinutes(group.totalMinutes)}
								</span>
							</div>
							{group.entries.map((entry) => (
								<TimeEntryRow
									key={entry.id}
									entry={entry}
									variant="day"
									organizationId={organizationId}
									projects={projects}
									knownEntries={entries}
									onDeleted={() =>
										entriesRef.current?.focus()
									}
								/>
							))}
						</div>
					))
				)}
			</section>
		</div>
	);
}
