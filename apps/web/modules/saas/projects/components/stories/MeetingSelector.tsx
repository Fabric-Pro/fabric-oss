"use client";

import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CalendarIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	RefreshCwIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useProjectMeetings } from "./use-project-meetings";

type Meeting = {
	id: string;
	subject: string;
	startTime: string | null;
	organizer: string;
	joinUrl: string;
};

type MeetingGroup = {
	subject: string;
	organizer: string;
	joinUrl: string;
	instances: Meeting[];
};

type DateRange = "7" | "14" | "30" | "60" | "90";

const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] = [
	{ value: "7", label: "Last 7 days" },
	{ value: "14", label: "Last 14 days" },
	{ value: "30", label: "Last 30 days" },
	{ value: "60", label: "Last 60 days" },
	{ value: "90", label: "Last 90 days" },
];

function formatDate(dateStr: string | null): string {
	if (!dateStr) {
		return "Unknown date";
	}
	return new Date(dateStr).toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

type SelectedMeeting = {
	joinUrl: string;
	startTime?: string;
};

type Props = {
	projectId: string;
	organizationId: string | null;
	onConfirm: (selectedMeetings: SelectedMeeting[]) => void;
	onCancel: () => void;
};

export function MeetingSelector({
	projectId,
	organizationId,
	onConfirm,
	onCancel,
}: Props) {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [confirmed, setConfirmed] = useState(false);
	const [confirmedMeetings, setConfirmedMeetings] = useState<Meeting[]>([]);
	const [skipped, setSkipped] = useState(false);
	const [hidden, setHidden] = useState(false);
	const [dateRange, setDateRange] = useState<DateRange>("30");
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
		new Set(),
	);
	const tStories = useTranslations("tooltips.stories");

	const { meetings, isLoading, isFetching, isError, error, refresh } =
		useProjectMeetings({
			projectId,
			organizationId,
			daysBack: Number(dateRange),
		});

	// Reset selection when the date range changes (a different range yields a
	// different meeting set). Cache-served re-renders keep the current selection.
	useEffect(() => {
		setSelected(new Set());
		setExpandedGroups(new Set());
	}, [dateRange]);

	// Group meetings by joinUrl (recurring meetings share the same joinUrl)
	const groups = useMemo(() => {
		const map = new Map<string, MeetingGroup>();
		for (const m of meetings) {
			const existing = map.get(m.joinUrl);
			if (existing) {
				existing.instances.push(m);
			} else {
				map.set(m.joinUrl, {
					subject: m.subject,
					organizer: m.organizer,
					joinUrl: m.joinUrl,
					instances: [m],
				});
			}
		}
		return Array.from(map.values());
	}, [meetings]);

	const toggleMeeting = useCallback((meetingId: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(meetingId)) {
				next.delete(meetingId);
			} else {
				next.add(meetingId);
			}
			return next;
		});
	}, []);

	const toggleGroupExpanded = useCallback((joinUrl: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(joinUrl)) {
				next.delete(joinUrl);
			} else {
				next.add(joinUrl);
			}
			return next;
		});
	}, []);

	// Auto-dismiss after skip or confirm
	useEffect(() => {
		if (skipped || confirmed) {
			const timer = setTimeout(() => setHidden(true), 2000);
			return () => clearTimeout(timer);
		}
	}, [skipped, confirmed]);

	if (hidden) {
		return null;
	}

	if (skipped) {
		return (
			<div className="rounded-lg border border-muted bg-muted/30 p-3">
				<p className="text-sm text-muted-foreground">
					Meeting selection skipped
				</p>
			</div>
		);
	}

	if (confirmed) {
		return (
			<div className="rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/30 p-3">
				<div className="flex items-center gap-2">
					<CheckCircle2Icon className="size-4 text-success dark:text-green-400" />
					<p className="text-sm font-medium">
						{confirmedMeetings.length} meeting(s) selected
					</p>
				</div>
				{confirmedMeetings.length > 0 && (
					<ul className="mt-1.5 space-y-0.5">
						{confirmedMeetings.map((m, i) => (
							<li
								key={i}
								className="text-xs text-muted-foreground flex items-center gap-1.5"
							>
								<CalendarIcon className="size-3 shrink-0" />
								{m.subject}
								{m.startTime && (
									<span className="text-muted-foreground/70">
										({formatDate(m.startTime)})
									</span>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		);
	}

	const selectedLabel =
		DATE_RANGE_OPTIONS.find((o) => o.value === dateRange)?.label ??
		"Last 30 days";

	return (
		<div className="rounded-lg border p-4 space-y-3 max-w-full">
			{/* Header with date range selector */}
			<div className="flex items-center justify-between gap-2">
				<p className="text-sm font-medium">
					Select meetings to analyze:
				</p>
				<div className="flex items-center gap-1.5">
					{!isLoading && !isError && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="size-6 text-muted-foreground"
									disabled={isFetching}
									onClick={() => refresh()}
									aria-label="Refresh meetings"
								>
									<RefreshCwIcon
										className={`size-3.5 ${isFetching ? "motion-safe:animate-spin" : ""}`}
									/>
								</Button>
							</TooltipTrigger>
							<TooltipContent>Refresh meetings</TooltipContent>
						</Tooltip>
					)}
					<Select
						value={dateRange}
						onValueChange={(v) => setDateRange(v as DateRange)}
					>
						<SelectTrigger className="h-7 w-[150px] text-xs">
							<CalendarIcon className="size-3 mr-1.5" />
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{DATE_RANGE_OPTIONS.map((option) => (
								<SelectItem
									key={option.value}
									value={option.value}
									className="text-xs"
								>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{/* Meeting list */}
			{isLoading ? (
				<div className="space-y-2">
					<Skeleton className="h-12 w-full" />
					<Skeleton className="h-12 w-full" />
					<Skeleton className="h-12 w-full" />
				</div>
			) : isError ? (
				<div className="space-y-2">
					<p className="text-xs text-destructive">
						{error?.message ?? "Failed to load meetings"}
					</p>
					<div className="flex items-center gap-2">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="sm"
									variant="outline"
									onClick={() => refresh()}
								>
									Retry
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{tStories("meetingSelectorRetry")}
							</TooltipContent>
						</Tooltip>
						<Button size="sm" variant="outline" onClick={onCancel}>
							Skip
						</Button>
					</div>
				</div>
			) : groups.length === 0 ? (
				<div className="space-y-1">
					<p className="text-xs text-muted-foreground">
						No meetings with transcripts found in the{" "}
						{selectedLabel.toLowerCase()}.
					</p>
					<p className="text-xs text-muted-foreground">
						Try expanding the date range using the selector above.
					</p>
				</div>
			) : (
				<div className="space-y-1.5 max-h-[300px] overflow-y-auto">
					{groups.map((group) => {
						const isRecurring = group.instances.length > 1;
						const isExpanded = expandedGroups.has(group.joinUrl);
						const latestInstance = group.instances[0];
						// For non-recurring: check if the single instance is selected
						// For recurring: header checkbox controls the latest instance
						const isHeaderSelected = selected.has(
							latestInstance?.id ?? "",
						);

						return (
							<div
								key={group.joinUrl}
								className="rounded-md border transition-colors"
							>
								{/* Group header */}
								{/* biome-ignore lint/a11y/useKeyWithClickEvents: Checkbox handles keyboard interaction */}
								{/* biome-ignore lint/a11y/noStaticElementInteractions: wrapper delegates to Checkbox */}
								<div
									className="flex items-start gap-3 p-2.5 cursor-pointer hover:bg-muted/50"
									onClick={() =>
										latestInstance &&
										toggleMeeting(latestInstance.id)
									}
								>
									<Checkbox
										checked={isHeaderSelected}
										onCheckedChange={() =>
											latestInstance &&
											toggleMeeting(latestInstance.id)
										}
										onPointerDown={(e) =>
											e.stopPropagation()
										}
										onClick={(e) => e.stopPropagation()}
										className="mt-0.5"
									/>
									<div className="flex-1 min-w-0">
										<p className="text-sm font-medium truncate">
											{group.subject}
										</p>
										<div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
											<CalendarIcon className="size-3" />
											<span>
												{formatDate(
													latestInstance?.startTime ??
														null,
												)}
											</span>
											<span>by {group.organizer}</span>
										</div>
									</div>
									{isRecurring && (
										<button
											type="button"
											className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded transition-colors shrink-0"
											onClick={(e) => {
												e.stopPropagation();
												toggleGroupExpanded(
													group.joinUrl,
												);
											}}
										>
											<span>
												{group.instances.length} dates
											</span>
											<ChevronDownIcon
												className={`size-3 transition-transform ${isExpanded ? "rotate-180" : ""}`}
											/>
										</button>
									)}
								</div>

								{/* Expanded date list for recurring meetings */}
								{isRecurring && isExpanded && (
									<div className="border-t px-2.5 py-1.5 bg-muted/30">
										<div className="space-y-0.5">
											{group.instances.map((instance) => {
												const isInstanceSelected =
													selected.has(instance.id);
												return (
													// biome-ignore lint/a11y/useKeyWithClickEvents: Checkbox handles keyboard interaction
													// biome-ignore lint/a11y/noStaticElementInteractions: wrapper delegates to Checkbox
													<div
														key={instance.id}
														className="flex items-center gap-2 text-xs text-muted-foreground py-1 pl-4 cursor-pointer hover:bg-muted/50 rounded"
														onClick={() =>
															toggleMeeting(
																instance.id,
															)
														}
													>
														<Checkbox
															checked={
																isInstanceSelected
															}
															onCheckedChange={() =>
																toggleMeeting(
																	instance.id,
																)
															}
															onPointerDown={(
																e,
															) =>
																e.stopPropagation()
															}
															onClick={(e) =>
																e.stopPropagation()
															}
															className="size-3.5"
														/>
														<CalendarIcon className="size-3 shrink-0" />
														<span>
															{formatDate(
																instance.startTime,
															)}
														</span>
													</div>
												);
											})}
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{/* Action buttons */}
			{!isLoading && !isError && (
				<div className="flex items-center gap-2">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								size="sm"
								onClick={() => {
									const selectedMeetings = meetings.filter(
										(m) => selected.has(m.id),
									);
									setConfirmedMeetings(selectedMeetings);
									setConfirmed(true);
									onConfirm(
										selectedMeetings.map((m) => ({
											joinUrl: m.joinUrl,
											startTime: m.startTime ?? undefined,
										})),
									);
								}}
								disabled={selected.size === 0}
							>
								Confirm ({selected.size} selected)
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{tStories("meetingSelectorLink")}
						</TooltipContent>
					</Tooltip>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							setSkipped(true);
							onCancel();
						}}
					>
						Skip
					</Button>
				</div>
			)}
			{isLoading && (
				<div className="flex items-center gap-2">
					<Button size="sm" disabled>
						Loading...
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							setSkipped(true);
							onCancel();
						}}
					>
						Skip
					</Button>
				</div>
			)}
		</div>
	);
}
