"use client";

import { formatDurationMinutes } from "@repo/utils/time-tracking";
import { cn } from "@ui/lib";
import { useLocale, useTranslations } from "next-intl";
import { longDateLabel, shortDayLabel } from "../lib/date-labels";
import type { WeekTable as WeekTableModel } from "../lib/time-entry-model";

function Minutes({ minutes }: { minutes: number }) {
	return minutes > 0 ? (
		formatDurationMinutes(minutes)
	) : (
		<span className="text-muted-foreground">–</span>
	);
}

/**
 * Projects down, days across. Every day header and every filled cell is a
 * button that opens that day; today's column is tinted and also says "today"
 * in words. A day with suggested time waiting carries a quiet dot, named for
 * screen readers.
 */
export function WeekTable({
	table,
	today,
	suggestedDates,
	onOpenDay,
}: {
	table: WeekTableModel;
	today: string;
	/** Work dates with suggestions waiting to be confirmed. */
	suggestedDates?: ReadonlySet<string>;
	onOpenDay: (date: string) => void;
}) {
	const t = useTranslations("timeTracking.week");
	const tSuggestions = useTranslations("timeTracking.suggestions");
	const locale = useLocale();
	const cellButton =
		"rounded-sm px-1 tabular-nums hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";
	const todayTint = (date: string) => date === today && "bg-primary/[0.06]";

	return (
		<div
			className="overflow-x-auto rounded-lg border border-border bg-card"
			data-onboarding-target="time-week-table"
		>
			<table className="w-full min-w-[820px] text-sm">
				<caption className="sr-only">{t("caption")}</caption>
				<thead className="border-b border-border bg-muted/50">
					<tr>
						<th
							scope="col"
							className="h-9 px-3 text-left font-semibold text-muted-foreground text-xs"
						>
							{t("project")}
						</th>
						{table.dates.map((date) => (
							<th
								key={date}
								scope="col"
								className={cn(
									"h-9 px-3 text-right font-semibold text-muted-foreground text-xs",
									todayTint(date),
								)}
							>
								<button
									type="button"
									className={cellButton}
									onClick={() => onOpenDay(date)}
								>
									{shortDayLabel(date, locale)}
									{date === today ? ` · ${t("today")}` : ""}
									{suggestedDates?.has(date) ? (
										<>
											<span
												aria-hidden="true"
												className="ml-1.5 inline-block size-1.5 rounded-full bg-primary align-middle"
											/>
											<span className="sr-only">
												{` · ${tSuggestions("dayHasSuggestions")}`}
											</span>
										</>
									) : null}
								</button>
							</th>
						))}
						<th
							scope="col"
							className="h-9 px-3 text-right font-semibold text-muted-foreground text-xs"
						>
							{t("total")}
						</th>
					</tr>
				</thead>
				<tbody>
					{table.rows.map((row) => (
						<tr
							key={row.projectId}
							className="border-b border-border"
						>
							<th
								scope="row"
								className="px-3 py-2.5 text-left font-normal"
							>
								{row.projectName}
							</th>
							{row.cells.map((minutes, index) => {
								const date = table.dates[index];
								return (
									<td
										key={date}
										className={cn(
											"px-3 py-2.5 text-right tabular-nums",
											todayTint(date),
										)}
									>
										{minutes > 0 ? (
											<button
												type="button"
												className={cellButton}
												aria-label={t("openCell", {
													duration:
														formatDurationMinutes(
															minutes,
														),
													project: row.projectName,
													date: longDateLabel(
														date,
														locale,
													),
												})}
												onClick={() => onOpenDay(date)}
											>
												{formatDurationMinutes(minutes)}
											</button>
										) : (
											<Minutes minutes={0} />
										)}
									</td>
								);
							})}
							<td className="px-3 py-2.5 text-right font-semibold tabular-nums">
								{formatDurationMinutes(row.totalMinutes)}
							</td>
						</tr>
					))}
				</tbody>
				<tfoot className="bg-muted/50 font-semibold">
					<tr>
						<th scope="row" className="px-3 py-2.5 text-left">
							{t("total")}
						</th>
						{table.dayTotals.map((minutes, index) => (
							<td
								key={table.dates[index]}
								className={cn(
									"px-3 py-2.5 text-right tabular-nums",
									todayTint(table.dates[index]),
								)}
							>
								<Minutes minutes={minutes} />
							</td>
						))}
						<td className="px-3 py-2.5 text-right tabular-nums">
							{formatDurationMinutes(table.totalMinutes)}
						</td>
					</tr>
				</tfoot>
			</table>
		</div>
	);
}
