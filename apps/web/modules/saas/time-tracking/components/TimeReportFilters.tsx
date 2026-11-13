"use client";

import {
	MAX_TIME_REPORT_SPAN_DAYS,
	PROJECT_BILLING_MODEL_LABELS,
	PROJECT_BILLING_MODEL_VALUES,
	TIME_ACTIVITIES,
	TIME_ACTIVITY_VALUES,
	type TimeActivity,
} from "@repo/utils/time-tracking";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import { ListFilterIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import {
	activeFilterCount,
	type BillableFilter,
	NO_REPORT_FILTERS,
	type ReportFilters,
	type ReportRange,
	reportRangeProblem,
} from "../lib/report-filters";
import type { ReportMonth } from "../lib/report-month";
import type { ReportOption } from "../lib/report-table";
import { isProjectBillingModel } from "../lib/time-settings-model";
import { WorkItemPicker } from "./WorkItemPicker";

/** Radix Select needs a non-empty value for "no filter". */
const ANY = "any";

const BILLABLE_FILTERS: readonly BillableFilter[] = [
	"all",
	"billable",
	"non-billable",
];

function isBillableFilter(value: string): value is BillableFilter {
	return (BILLABLE_FILTERS as readonly string[]).includes(value);
}

function isTimeActivity(value: string): value is TimeActivity {
	return (TIME_ACTIVITY_VALUES as readonly string[]).includes(value);
}

function FilterField({
	label,
	value,
	onValueChange,
	children,
}: {
	label: string;
	value: string;
	onValueChange: (value: string) => void;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<div className="space-y-1.5">
			<span id={id} className="font-medium text-xs">
				{label}
			</span>
			<Select value={value} onValueChange={onValueChange}>
				<SelectTrigger aria-labelledby={id} className="h-8">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>{children}</SelectContent>
			</Select>
		</div>
	);
}

const PERIOD_MODES = ["month", "custom"] as const;

type PeriodMode = (typeof PERIOD_MODES)[number];

/**
 * The project report's period: the month the screen steps through, or a
 * custom range of work dates. A range is applied only once it can be read;
 * until then the report keeps the period it had.
 */
function PeriodFilter({
	filters,
	month,
	onChange,
}: {
	filters: ReportFilters;
	month: ReportMonth;
	onChange: (filters: ReportFilters) => void;
}) {
	const t = useTranslations("timeTracking.report.filters");
	const id = useId();
	const [mode, setMode] = useState<PeriodMode>(
		filters.range ? "custom" : "month",
	);
	const [draft, setDraft] = useState<ReportRange>(filters.range ?? month);
	const problem = reportRangeProblem(draft);

	const changeDraft = (next: ReportRange) => {
		setDraft(next);
		if (reportRangeProblem(next) === null) {
			onChange({ ...filters, range: next });
		}
	};

	const chooseMode = (next: PeriodMode) => {
		setMode(next);
		if (next === "month") {
			onChange({ ...filters, range: null });
		} else if (problem === null) {
			onChange({ ...filters, range: draft });
		}
	};

	return (
		<div className="space-y-2">
			<fieldset className="space-y-1.5">
				<legend className="font-medium text-xs">{t("period")}</legend>
				<div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/60 p-0.5">
					{PERIOD_MODES.map((option) => (
						<button
							key={option}
							type="button"
							aria-pressed={mode === option}
							onClick={() => chooseMode(option)}
							className={cn(
								"rounded-[5px] border px-3 py-1 font-medium text-xs",
								"motion-safe:transition-colors motion-safe:duration-150",
								"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
								mode === option
									? "border-border bg-card text-foreground shadow-sm"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
						>
							{option === "month"
								? t("periodMonth")
								: t("periodCustom")}
						</button>
					))}
				</div>
			</fieldset>
			{mode === "custom" ? (
				<div className="space-y-1.5">
					<div className="grid grid-cols-2 gap-2">
						<div className="space-y-1">
							<Label htmlFor={`${id}-from`} className="text-xs">
								{t("rangeFrom")}
							</Label>
							<Input
								id={`${id}-from`}
								type="date"
								className="h-8"
								value={draft.from}
								max={draft.to}
								aria-invalid={problem !== null}
								aria-describedby={
									problem ? `${id}-problem` : undefined
								}
								onChange={(event) =>
									changeDraft({
										...draft,
										from: event.target.value,
									})
								}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor={`${id}-to`} className="text-xs">
								{t("rangeTo")}
							</Label>
							<Input
								id={`${id}-to`}
								type="date"
								className="h-8"
								value={draft.to}
								min={draft.from}
								aria-invalid={problem !== null}
								aria-describedby={
									problem ? `${id}-problem` : undefined
								}
								onChange={(event) =>
									changeDraft({
										...draft,
										to: event.target.value,
									})
								}
							/>
						</div>
					</div>
					{problem ? (
						<p
							id={`${id}-problem`}
							className="text-destructive text-xs"
						>
							{problem === "tooLong"
								? t("rangeTooLong", {
										days: MAX_TIME_REPORT_SPAN_DAYS,
									})
								: t("rangeInvalid")}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * One Filter button with the active count on it, opening every filter of the
 * report. The project and person lists come from the period's report, so they
 * stay put while other filters narrow the table.
 *
 * A project report (`project` given) also filters by one of the project's
 * work items and can read a custom range instead of `month`.
 */
export function TimeReportFilters({
	filters,
	onChange,
	showProjectFilter,
	projects,
	people,
	project,
	month,
}: {
	filters: ReportFilters;
	onChange: (filters: ReportFilters) => void;
	showProjectFilter: boolean;
	projects: readonly ReportOption[];
	people: readonly ReportOption[];
	project: { projectId: string; organizationId: string } | null;
	month: ReportMonth;
}) {
	const t = useTranslations("timeTracking.report.filters");
	const count = activeFilterCount(filters);
	const billableLabels: Record<BillableFilter, string> = {
		all: t("all"),
		billable: t("billableOnly"),
		"non-billable": t("nonBillableOnly"),
	};

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button type="button" variant="outline" size="sm">
					<ListFilterIcon aria-hidden="true" />
					{t("filter")}
					{count > 0 ? (
						<span className="rounded-sm bg-primary/[0.12] px-1.5 font-medium text-primary-active text-xs tabular-nums dark:bg-primary/[0.20]">
							<span aria-hidden="true">{count}</span>
							<span className="sr-only">
								{t("activeCount", { count })}
							</span>
						</span>
					) : null}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 space-y-3">
				{project ? (
					<PeriodFilter
						// Clearing the filters returns to the month, so the
						// fields start over from what is applied.
						key={filters.range ? "custom" : "month"}
						filters={filters}
						month={month}
						onChange={onChange}
					/>
				) : null}
				{showProjectFilter ? (
					<FilterField
						label={t("project")}
						value={filters.projectId ?? ANY}
						onValueChange={(value) =>
							onChange({
								...filters,
								projectId: value === ANY ? null : value,
							})
						}
					>
						<SelectItem value={ANY}>{t("allProjects")}</SelectItem>
						{projects.map((project) => (
							<SelectItem key={project.id} value={project.id}>
								{project.name}
							</SelectItem>
						))}
					</FilterField>
				) : null}
				<FilterField
					label={t("person")}
					value={filters.userId ?? ANY}
					onValueChange={(value) =>
						onChange({
							...filters,
							userId: value === ANY ? null : value,
						})
					}
				>
					<SelectItem value={ANY}>{t("everyone")}</SelectItem>
					{people.map((person) => (
						<SelectItem key={person.id} value={person.id}>
							{person.name}
						</SelectItem>
					))}
				</FilterField>
				{project ? (
					<div className="space-y-1.5">
						<span className="font-medium text-xs">
							{t("workItem")}
						</span>
						<WorkItemPicker
							projectId={project.projectId}
							organizationId={project.organizationId}
							value={filters.story}
							onChange={(story) =>
								onChange({ ...filters, story })
							}
						/>
					</div>
				) : null}
				<FilterField
					label={t("billable")}
					value={filters.billable}
					onValueChange={(value) => {
						if (isBillableFilter(value)) {
							onChange({ ...filters, billable: value });
						}
					}}
				>
					{BILLABLE_FILTERS.map((filter) => (
						<SelectItem key={filter} value={filter}>
							{billableLabels[filter]}
						</SelectItem>
					))}
				</FilterField>
				<FilterField
					label={t("activity")}
					value={filters.activity ?? ANY}
					onValueChange={(value) =>
						onChange({
							...filters,
							activity: isTimeActivity(value) ? value : null,
						})
					}
				>
					<SelectItem value={ANY}>{t("allActivities")}</SelectItem>
					{TIME_ACTIVITIES.map((activity) => (
						<SelectItem key={activity.value} value={activity.value}>
							{activity.label}
						</SelectItem>
					))}
				</FilterField>
				<FilterField
					label={t("projectType")}
					value={filters.billingModel ?? ANY}
					onValueChange={(value) =>
						onChange({
							...filters,
							billingModel: isProjectBillingModel(value)
								? value
								: null,
						})
					}
				>
					<SelectItem value={ANY}>{t("allTypes")}</SelectItem>
					{PROJECT_BILLING_MODEL_VALUES.map((model) => (
						<SelectItem key={model} value={model}>
							{PROJECT_BILLING_MODEL_LABELS[model]}
						</SelectItem>
					))}
				</FilterField>
				<div className="flex justify-end">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={count === 0}
						onClick={() => onChange(NO_REPORT_FILTERS)}
					>
						{t("clear")}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
