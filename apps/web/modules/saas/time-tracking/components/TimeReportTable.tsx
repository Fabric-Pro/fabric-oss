"use client";

import {
	formatDurationMinutes,
	PROJECT_BILLING_MODEL_LABELS,
	TIME_ACTIVITY_LABELS,
} from "@repo/utils/time-tracking";
import { cn } from "@ui/lib";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useState } from "react";
import { shortDateLabel } from "../lib/date-labels";
import type {
	ReportTableProject,
	TimeReport,
	TimeReportRow,
} from "../lib/report-table";

/** Entries shown per project before "Show all", so a busy month stays light. */
const ENTRY_PREVIEW_LIMIT = 50;

function entrySummary(row: TimeReportRow, locale: string): string {
	const workItem = [row.storyIdentifier, row.storyTitle]
		.filter((part): part is string => Boolean(part))
		.join(" ");
	return [
		shortDateLabel(row.workDate, locale),
		row.userName,
		TIME_ACTIVITY_LABELS[row.activity],
		workItem,
		row.description ?? "",
	]
		.filter((part) => part !== "")
		.join(" · ");
}

/**
 * One row per project, each opening onto its entries, and the grand total.
 * An entry's duration sits in the Billable or the Non-billable column, which
 * is its billable mark.
 */
export function TimeReportTable({
	projects,
	totals,
	showTotal,
	initiallyExpanded = [],
}: {
	projects: ReportTableProject[];
	totals: TimeReport["totals"];
	showTotal: boolean;
	initiallyExpanded?: readonly string[];
}) {
	const t = useTranslations("timeTracking.report.table");
	const locale = useLocale();
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(
		() => new Set(initiallyExpanded),
	);
	const [showingAll, setShowingAll] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const toggle = (projectId: string) =>
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(projectId)) {
				next.delete(projectId);
			} else {
				next.add(projectId);
			}
			return next;
		});

	const numeric = "px-3 py-2.5 text-right tabular-nums";
	const durationOrBlank = (minutes: number) =>
		minutes > 0 ? formatDurationMinutes(minutes) : "";

	return (
		<div className="overflow-x-auto rounded-lg border border-border bg-card">
			<table className="w-full min-w-[720px] text-sm">
				<caption className="sr-only">{t("caption")}</caption>
				<thead className="border-border border-b bg-muted/50">
					<tr>
						<th
							scope="col"
							className="h-9 px-3 text-left font-semibold text-muted-foreground text-xs"
						>
							{t("project")}
						</th>
						{(
							[
								["people", t("people")],
								["billable", t("billable")],
								["nonBillable", t("nonBillable")],
								["total", t("total")],
							] as const
						).map(([key, label]) => (
							<th
								key={key}
								scope="col"
								className="h-9 px-3 text-right font-semibold text-muted-foreground text-xs"
							>
								{label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{projects.map((project) => {
						const isOpen = expanded.has(project.projectId);
						const entries = showingAll.has(project.projectId)
							? project.entries
							: project.entries.slice(0, ENTRY_PREVIEW_LIMIT);
						const Chevron = isOpen
							? ChevronDownIcon
							: ChevronRightIcon;
						return (
							<Fragment key={project.projectId}>
								<tr className="border-border border-b font-semibold">
									<th
										scope="row"
										className="px-3 py-2.5 text-left"
									>
										<button
											type="button"
											aria-expanded={isOpen}
											onClick={() =>
												toggle(project.projectId)
											}
											className="inline-flex items-center gap-2 rounded-sm text-left font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
										>
											<Chevron
												className="size-4 shrink-0 text-muted-foreground"
												aria-hidden="true"
											/>
											{project.projectName}
										</button>
										<span className="ml-2 font-normal text-muted-foreground text-xs">
											{
												PROJECT_BILLING_MODEL_LABELS[
													project.billingModel
												]
											}
										</span>
									</th>
									<td className={numeric}>
										{project.peopleCount}
									</td>
									<td className={numeric}>
										{formatDurationMinutes(
											project.billableMinutes,
										)}
									</td>
									<td className={numeric}>
										{formatDurationMinutes(
											project.nonBillableMinutes,
										)}
									</td>
									<td className={numeric}>
										{formatDurationMinutes(
											project.totalMinutes,
										)}
									</td>
								</tr>
								{isOpen
									? entries.map((row) => (
											<tr
												key={row.id}
												className="border-border border-b bg-muted/30 text-xs"
											>
												<td
													colSpan={2}
													className="py-2 pr-3 pl-9"
												>
													{entrySummary(row, locale)}
												</td>
												<td
													className={cn(
														numeric,
														"py-2",
													)}
												>
													{row.billable
														? durationOrBlank(
																row.durationMinutes,
															)
														: ""}
												</td>
												<td
													className={cn(
														numeric,
														"py-2",
													)}
												>
													{row.billable
														? ""
														: durationOrBlank(
																row.durationMinutes,
															)}
												</td>
												<td
													className={cn(
														numeric,
														"py-2",
													)}
												>
													{formatDurationMinutes(
														row.durationMinutes,
													)}
												</td>
											</tr>
										))
									: null}
								{isOpen &&
								entries.length < project.entries.length ? (
									<tr className="border-border border-b bg-muted/30 text-xs">
										<td
											colSpan={5}
											className="py-2 pr-3 pl-9"
										>
											<button
												type="button"
												onClick={() =>
													setShowingAll(
														(current) =>
															new Set([
																...current,
																project.projectId,
															]),
													)
												}
												className="rounded-sm text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
											>
												{t("showAll", {
													count: project.entries
														.length,
												})}
											</button>
										</td>
									</tr>
								) : null}
							</Fragment>
						);
					})}
				</tbody>
				{showTotal ? (
					<tfoot className="bg-muted/50 font-semibold">
						<tr>
							<th scope="row" className="px-3 py-2.5 text-left">
								{t("total")}
							</th>
							<td className={numeric}>{totals.peopleCount}</td>
							<td className={numeric}>
								{formatDurationMinutes(totals.billableMinutes)}
							</td>
							<td className={numeric}>
								{formatDurationMinutes(
									totals.nonBillableMinutes,
								)}
							</td>
							<td className={numeric}>
								{formatDurationMinutes(totals.totalMinutes)}
							</td>
						</tr>
					</tfoot>
				) : null}
			</table>
		</div>
	);
}
