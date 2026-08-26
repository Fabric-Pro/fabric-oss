"use client";

import { pmDetectedTypeDisplayName } from "@repo/utils";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { XIcon } from "lucide-react";
import type {
	PmSyncLogFilters,
	PmSyncLogStatusFilter,
} from "./use-pm-sync-log";

type Props = {
	filters: PmSyncLogFilters;
	onChange: (filters: PmSyncLogFilters) => void;
};

const ALL = "__all__";

/**
 * PM tools the log can record — the same detectable set as the brand-icon
 * registry (`detectPMTypeFromUrl()`), rendered with their display names.
 */
const PM_TOOL_OPTIONS = [
	"azure-devops",
	"jira",
	"linear",
	"github",
	"gitlab",
	"trello",
	"asana",
	"notion",
	"monday",
	"clickup",
	"fizzy",
] as const;

const STATUS_OPTIONS: PmSyncLogStatusFilter[] = [
	"SUCCESS",
	"FAILURE",
	"CONFLICT",
];

const STATUS_LABELS: Record<PmSyncLogStatusFilter, string> = {
	SUCCESS: "Success",
	FAILURE: "Failure",
	CONFLICT: "Conflict",
};

/** Local date (yyyy-mm-dd) <-> Date helpers for the native date inputs. */
function toInputDate(value: Date | undefined): string {
	if (!value) {
		return "";
	}
	const year = value.getFullYear();
	const month = String(value.getMonth() + 1).padStart(2, "0");
	const day = String(value.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Parse a `yyyy-mm-dd` value into a local `Date`. For `boundary: "end"` the
 * time is set to the last millisecond of the day so the inclusive `lte` filter
 * in `listPmSyncLog` (`createdAt <= dateTo`) still matches same-day rows — a
 * plain midnight `dateTo` would otherwise exclude everything after 00:00.
 */
function fromInputDate(
	value: string,
	boundary: "start" | "end" = "start",
): Date | undefined {
	if (!value) {
		return undefined;
	}
	const time = boundary === "end" ? "23:59:59.999" : "00:00:00.000";
	const parsed = new Date(`${value}T${time}`);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function fieldLabelClass() {
	return "text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground";
}

export function SyncHistoryFilters({ filters, onChange }: Props) {
	const hasActiveFilters =
		Boolean(filters.pmTool) ||
		Boolean(filters.entityId) ||
		Boolean(filters.status) ||
		Boolean(filters.dateFrom) ||
		Boolean(filters.dateTo);

	const update = (patch: Partial<PmSyncLogFilters>) => {
		onChange({ ...filters, ...patch });
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
				<div className="flex flex-col gap-1.5">
					<label
						className={fieldLabelClass()}
						htmlFor="sync-date-from"
					>
						From
					</label>
					<Input
						id="sync-date-from"
						type="date"
						value={toInputDate(filters.dateFrom)}
						max={toInputDate(filters.dateTo)}
						onChange={(event) =>
							update({
								dateFrom: fromInputDate(event.target.value),
							})
						}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<label className={fieldLabelClass()} htmlFor="sync-date-to">
						To
					</label>
					<Input
						id="sync-date-to"
						type="date"
						value={toInputDate(filters.dateTo)}
						min={toInputDate(filters.dateFrom)}
						onChange={(event) =>
							update({
								dateTo: fromInputDate(
									event.target.value,
									"end",
								),
							})
						}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<span className={fieldLabelClass()} id="sync-pm-tool-label">
						PM tool
					</span>
					<Select
						value={filters.pmTool ?? ALL}
						onValueChange={(value) =>
							update({
								pmTool: value === ALL ? undefined : value,
							})
						}
					>
						<SelectTrigger aria-labelledby="sync-pm-tool-label">
							<SelectValue placeholder="All tools" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All tools</SelectItem>
							{PM_TOOL_OPTIONS.map((tool) => (
								<SelectItem key={tool} value={tool}>
									{pmDetectedTypeDisplayName(tool) ?? tool}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="flex flex-col gap-1.5">
					<span className={fieldLabelClass()} id="sync-status-label">
						Status
					</span>
					<Select
						value={filters.status ?? ALL}
						onValueChange={(value) =>
							update({
								status:
									value === ALL
										? undefined
										: (value as PmSyncLogStatusFilter),
							})
						}
					>
						<SelectTrigger aria-labelledby="sync-status-label">
							<SelectValue placeholder="All statuses" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All statuses</SelectItem>
							{STATUS_OPTIONS.map((status) => (
								<SelectItem key={status} value={status}>
									{STATUS_LABELS[status]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="flex flex-col gap-1.5">
					<label
						className={fieldLabelClass()}
						htmlFor="sync-entity-id"
					>
						Item
					</label>
					<Input
						id="sync-entity-id"
						type="text"
						inputMode="text"
						placeholder="Entity ID"
						value={filters.entityId ?? ""}
						onChange={(event) =>
							update({
								entityId: event.target.value.trim()
									? event.target.value.trim()
									: undefined,
							})
						}
					/>
				</div>
			</div>

			{hasActiveFilters && (
				<div className="flex justify-end">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-8 text-xs text-muted-foreground"
						onClick={() => onChange({})}
					>
						<XIcon className="mr-1 size-3.5" aria-hidden />
						Clear filters
					</Button>
				</div>
			)}
		</div>
	);
}
