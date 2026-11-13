"use client";

import { formatDurationMinutes } from "@repo/utils/time-tracking";
import { triggerBlobDownload } from "@saas/projects/lib/markdown-to-document";
import { PageHeader } from "@saas/shared/components/PageHeader";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	EmptyState,
	EmptyStateIcon,
	EmptyStateTitle,
} from "@ui/components/empty-state";
import { Skeleton } from "@ui/components/skeleton";
import {
	ChevronLeftIcon,
	ChevronRightIcon,
	ClockIcon,
	DownloadIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { monthLabel, weekRangeLabel } from "../lib/date-labels";
import {
	buildReportRequest,
	defaultReportFilters,
	NO_REPORT_FILTERS,
	type ReportScope,
} from "../lib/report-filters";
import { monthRange, type ReportMonth, shiftMonth } from "../lib/report-month";
import {
	buildReportTable,
	reportFailure,
	reportFilterOptions,
} from "../lib/report-table";
import { exportTimeReportCsv, timeReportQuery } from "../lib/time-tracking-api";
import { browserTimeZone, todayInZone } from "../lib/zoned-time";
import { InfoHint } from "./InfoHint";
import { TimeReportFilters } from "./TimeReportFilters";
import { TimeReportTable } from "./TimeReportTable";

function ReportHeader({
	scope,
	action,
}: {
	scope: ReportScope["kind"];
	action: ReactNode;
}) {
	const t = useTranslations("timeTracking.report");
	return (
		<PageHeader
			title={
				scope === "organization"
					? t("titleOrganization")
					: t("titleProject")
			}
			titleAdornment={
				<InfoHint label={t("aboutTitle")}>{t("about")}</InfoHint>
			}
			actions={action}
		/>
	);
}

function LoadingRows() {
	const t = useTranslations("timeTracking.report");
	return (
		<output className="block space-y-2">
			<span className="sr-only">{t("loading")}</span>
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-10 w-full" />
		</output>
	);
}

/**
 * A time report for the organization or for one project: a month at a time,
 * one row per project opening onto its entries, filters, and a CSV export of
 * exactly what is shown. A project report can swap the month for a custom
 * range of work dates from its filters.
 *
 * The month starts as the current one in the browser's time zone, so nothing
 * dated renders until the page has mounted there: a server guess would be
 * replaced on hydration.
 */
export function TimeReport({ scope }: { scope: ReportScope }) {
	const t = useTranslations("timeTracking.report");
	const [month, setMonth] = useState<ReportMonth | null>(null);
	useEffect(() => {
		setMonth(monthRange(todayInZone(browserTimeZone())));
	}, []);

	if (month === null) {
		return (
			<div className="space-y-6">
				<ReportHeader
					scope={scope.kind}
					action={
						<Button type="button" disabled>
							<DownloadIcon aria-hidden="true" />
							{t("exportCsv")}
						</Button>
					}
				/>
				<Skeleton className="h-8 w-80" />
				<LoadingRows />
			</div>
		);
	}

	return <MonthReport scope={scope} month={month} onMonthChange={setMonth} />;
}

function MonthReport({
	scope,
	month,
	onMonthChange,
}: {
	scope: ReportScope;
	month: ReportMonth;
	onMonthChange: (month: ReportMonth) => void;
}) {
	const t = useTranslations("timeTracking.report");
	const locale = useLocale();
	const [filters, setFilters] = useState(() =>
		defaultReportFilters(scope.kind),
	);

	const request = buildReportRequest(scope, month, filters);
	const reportQuery = useQuery({
		...timeReportQuery(request),
		placeholderData: keepPreviousData,
	});
	// The filter lists come from the period with no other filters, so choosing
	// one filter does not empty the others. With no filters set it is the same
	// read as the table's, which the cache serves once.
	const optionsQuery = useQuery(
		timeReportQuery(
			buildReportRequest(scope, month, {
				...NO_REPORT_FILTERS,
				range: filters.range,
			}),
		),
	);

	const report = reportQuery.data;
	const table = useMemo(
		() => (report ? buildReportTable(report) : []),
		[report],
	);
	const options = useMemo(() => {
		const source = optionsQuery.data ?? report;
		return source
			? reportFilterOptions(source)
			: { projects: [], people: [] };
	}, [optionsQuery.data, report]);

	const exportMutation = useMutation({
		mutationFn: () => exportTimeReportCsv(request),
		onSuccess: ({ filename, csv }) => {
			triggerBlobDownload(
				// Excel reads a CSV as UTF-8 only when it starts with a byte-order mark.
				new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }),
				filename,
			);
		},
		onError: () => {
			toast.error(t("exportFailed"));
		},
	});

	const failure = reportQuery.isError
		? reportFailure(reportQuery.error)
		: null;
	if (failure === "no-access") {
		return (
			<div className="space-y-6">
				<ReportHeader scope={scope.kind} action={null} />
				<p className="py-12 text-center text-muted-foreground text-sm">
					{t("noAccess")}
				</p>
			</div>
		);
	}

	const loading = reportQuery.isPending || reportQuery.isPlaceholderData;
	const empty = report !== undefined && report.rows.length === 0;

	return (
		<div className="space-y-6">
			<ReportHeader
				scope={scope.kind}
				action={
					<Button
						type="button"
						disabled={
							exportMutation.isPending ||
							loading ||
							failure !== null ||
							empty
						}
						onClick={() => exportMutation.mutate()}
					>
						<DownloadIcon aria-hidden="true" />
						{t("exportCsv")}
					</Button>
				}
			/>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					{filters.range ? (
						<h2 className="font-semibold text-base">
							{weekRangeLabel(
								filters.range.from,
								filters.range.to,
								locale,
							)}
						</h2>
					) : (
						<>
							<Button
								type="button"
								variant="outline"
								size="icon-sm"
								aria-label={t("previousMonth")}
								onClick={() =>
									onMonthChange(shiftMonth(month, -1))
								}
							>
								<ChevronLeftIcon aria-hidden="true" />
							</Button>
							<h2 className="min-w-36 text-center font-semibold text-base">
								{monthLabel(month.from, locale)}
							</h2>
							<Button
								type="button"
								variant="outline"
								size="icon-sm"
								aria-label={t("nextMonth")}
								onClick={() =>
									onMonthChange(shiftMonth(month, 1))
								}
							>
								<ChevronRightIcon aria-hidden="true" />
							</Button>
						</>
					)}
					<div className="ml-2">
						<TimeReportFilters
							filters={filters}
							onChange={setFilters}
							showProjectFilter={scope.kind === "organization"}
							projects={options.projects}
							people={options.people}
							project={
								scope.kind === "project"
									? {
											projectId: scope.projectId,
											organizationId:
												scope.organizationId,
										}
									: null
							}
							month={month}
						/>
					</div>
				</div>
				<p className="flex items-baseline gap-3">
					<span className="text-muted-foreground text-sm">
						{t("total")}
					</span>
					<span className="font-semibold text-xl tabular-nums">
						{report && !loading
							? formatDurationMinutes(report.totals.totalMinutes)
							: "–"}
					</span>
					{report && !loading ? (
						<span className="text-muted-foreground text-sm tabular-nums">
							{t("billablePart", {
								duration: formatDurationMinutes(
									report.totals.billableMinutes,
								),
							})}
						</span>
					) : null}
				</p>
			</div>

			{failure === "too-many-rows" ? (
				<p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm">
					{t("tooManyRows")}
				</p>
			) : failure === "failed" ? (
				<p className="py-12 text-center text-muted-foreground text-sm">
					{t("loadFailed")}
				</p>
			) : loading || !report ? (
				<LoadingRows />
			) : empty ? (
				<EmptyState className="rounded-lg border border-border bg-card">
					<EmptyStateIcon>
						<ClockIcon className="size-8" aria-hidden="true" />
					</EmptyStateIcon>
					<EmptyStateTitle>
						{filters.range ? t("emptyRange") : t("empty")}
					</EmptyStateTitle>
				</EmptyState>
			) : (
				<TimeReportTable
					projects={table}
					totals={report.totals}
					showTotal={scope.kind === "organization"}
					initiallyExpanded={
						scope.kind === "project"
							? table.map((project) => project.projectId)
							: []
					}
				/>
			)}
		</div>
	);
}
