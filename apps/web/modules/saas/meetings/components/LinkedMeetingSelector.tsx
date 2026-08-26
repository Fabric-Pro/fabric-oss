"use client";

/**
 * LinkedMeetingSelector
 *
 * Dialog for selecting calendar meetings to link to a project for
 * transcript syncing. Groups recurring meetings by joinUrl and allows
 * multi-select with a single confirm action.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
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
	CheckIcon,
	Loader2Icon,
	MinusIcon,
	UsersIcon,
	VideoIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

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
	latestDate: string | null;
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

type Props = {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onLinked: () => void;
	existingJoinUrls: string[];
};

export function LinkedMeetingSelector({
	projectId,
	organizationId,
	open,
	onOpenChange,
	onLinked,
	existingJoinUrls,
}: Props) {
	const t = useTranslations("tooltips.contextSources");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [dateRange, setDateRange] = useState<DateRange>("30");
	const [isLinking, setIsLinking] = useState(false);

	const existingUrlSet = useMemo(
		() => new Set(existingJoinUrls),
		[existingJoinUrls],
	);

	const {
		data: meetingsResult,
		isLoading,
		error,
		refetch,
	} = useQuery({
		queryKey: [
			"linked-meeting-selector-meetings",
			projectId,
			organizationId,
			dateRange,
		],
		queryFn: async () => {
			const result = await orpcClient.projects.backlog.listMeetings({
				projectId,
				organizationId,
				daysBack: Number(dateRange),
			});
			return {
				softError: result.error ?? null,
				meetings: (result.meetings ?? [])
					.filter((m) => !!m.joinUrl)
					.map((m) => ({
						id: m.id,
						subject: m.subject,
						startTime: m.startTime ?? null,
						organizer: m.organizer,
						joinUrl: m.joinUrl as string,
					})),
			};
		},
		enabled: open,
	});

	// Group meetings by joinUrl (recurring meetings share the same joinUrl)
	const groups = useMemo(() => {
		const meetings = meetingsResult?.meetings;
		if (!meetings) {
			return [];
		}
		const map = new Map<string, MeetingGroup>();
		for (const m of meetings) {
			const existing = map.get(m.joinUrl);
			if (existing) {
				existing.instances.push(m);
				// Track latest date
				if (
					m.startTime &&
					(!existing.latestDate || m.startTime > existing.latestDate)
				) {
					existing.latestDate = m.startTime;
				}
			} else {
				map.set(m.joinUrl, {
					subject: m.subject,
					organizer: m.organizer,
					joinUrl: m.joinUrl,
					instances: [m],
					latestDate: m.startTime,
				});
			}
		}
		return Array.from(map.values());
	}, [meetingsResult]);

	const toggleGroup = useCallback(
		(joinUrl: string) => {
			if (existingUrlSet.has(joinUrl)) {
				return;
			}
			setSelected((prev) => {
				const next = new Set(prev);
				if (next.has(joinUrl)) {
					next.delete(joinUrl);
				} else {
					next.add(joinUrl);
				}
				return next;
			});
		},
		[existingUrlSet],
	);

	const handleConfirm = useCallback(async () => {
		if (selected.size === 0) {
			return;
		}

		setIsLinking(true);
		let successCount = 0;
		let failCount = 0;

		for (const joinUrl of selected) {
			const group = groups.find((g) => g.joinUrl === joinUrl);
			try {
				await orpcClient.projects.meetingTranscriptSync.linkMeeting({
					projectId,
					organizationId,
					joinUrl,
					subject: group?.subject,
					organizer: group?.organizer,
				});
				successCount++;
			} catch (err) {
				console.error(`Failed to link meeting ${joinUrl}:`, err);
				failCount++;
			}
		}

		setIsLinking(false);

		if (failCount === 0) {
			toast.success(
				`${successCount} meeting${successCount !== 1 ? "s" : ""} linked`,
			);
		} else {
			toast.warning(`${successCount} linked, ${failCount} failed`);
		}

		setSelected(new Set());
		onLinked();
		onOpenChange(false);
	}, [selected, groups, projectId, organizationId, onLinked, onOpenChange]);

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (!nextOpen) {
				setSelected(new Set());
			}
			onOpenChange(nextOpen);
		},
		[onOpenChange],
	);

	// Selectable = not already linked. Powers the "all meetings" bulk affordance (DEC-02).
	const selectableJoinUrls = useMemo(
		() =>
			groups
				.filter((g) => !existingUrlSet.has(g.joinUrl))
				.map((g) => g.joinUrl),
		[groups, existingUrlSet],
	);
	const selectableCount = selectableJoinUrls.length;
	const allSelectableSelected =
		selectableCount > 0 && selectableJoinUrls.every((u) => selected.has(u));
	const someSelectableSelected = selected.size > 0 && !allSelectableSelected;

	const toggleSelectAll = useCallback(() => {
		setSelected((prev) => {
			const allSelected =
				selectableJoinUrls.length > 0 &&
				selectableJoinUrls.every((u) => prev.has(u));
			return allSelected
				? new Set<string>()
				: new Set(selectableJoinUrls);
		});
	}, [selectableJoinUrls]);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Link Meetings</DialogTitle>
					<DialogDescription>
						Select recurring meetings to link to this project.
						Transcripts from linked meetings will be synced
						automatically.
					</DialogDescription>
				</DialogHeader>

				{/* Date range selector */}
				<div className="flex items-center justify-between gap-2">
					<p className="text-sm text-muted-foreground">
						Showing meetings from:
					</p>
					<Select
						value={dateRange}
						onValueChange={(v) => setDateRange(v as DateRange)}
					>
						<SelectTrigger className="h-8 w-[150px] text-xs">
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

				{/* Bulk "all meetings" affordance (DEC-02): select every series in the current range at once. */}
				{!isLoading && !error && selectableCount > 0 && (
					<div className="flex items-center justify-between gap-2 px-1">
						<button
							type="button"
							onClick={toggleSelectAll}
							aria-pressed={allSelectableSelected}
							className="flex items-center gap-2 text-xs font-medium text-foreground"
						>
							{/* Decorative tri-state glyph (NOT a real Checkbox: a
							    Radix Checkbox renders a <button>, which is invalid
							    nested inside this <button>). State is conveyed by
							    aria-pressed + the "N of M selected" counter. */}
							<span
								aria-hidden="true"
								className={`flex size-4 items-center justify-center rounded-[4px] border ${
									allSelectableSelected ||
									someSelectableSelected
										? "border-primary bg-primary text-primary-foreground"
										: "border-foreground/40"
								}`}
							>
								{allSelectableSelected ? (
									<CheckIcon className="size-3" />
								) : someSelectableSelected ? (
									<MinusIcon className="size-3" />
								) : null}
							</span>
							Select all meetings
						</button>
						<span className="text-xs text-muted-foreground">
							{selected.size} of {selectableCount} selected
						</span>
					</div>
				)}

				{/* Meeting list */}
				<div className="max-h-[360px] overflow-y-auto space-y-1.5 pr-1">
					{isLoading ? (
						<div className="space-y-2 py-2">
							<Skeleton className="h-14 w-full" />
							<Skeleton className="h-14 w-full" />
							<Skeleton className="h-14 w-full" />
						</div>
					) : error ? (
						<div className="rounded-lg border border-dashed border-destructive/30 p-6 text-center space-y-3">
							<p className="text-sm text-destructive">
								{error instanceof Error
									? error.message
									: "Failed to load meetings"}
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() => refetch()}
							>
								Retry
							</Button>
						</div>
					) : meetingsResult?.softError ? (
						<div className="rounded-lg border border-dashed border-foreground/20 p-8 text-center">
							<VideoIcon className="size-8 mx-auto mb-3 text-muted-foreground" />
							<p className="text-sm text-muted-foreground">
								{meetingsResult.softError}
							</p>
						</div>
					) : groups.length === 0 ? (
						<div className="rounded-lg border border-dashed border-foreground/20 p-8 text-center">
							<VideoIcon className="size-8 mx-auto mb-3 text-muted-foreground" />
							<p className="text-sm text-muted-foreground">
								No meetings with join links found
							</p>
							<p className="text-xs text-muted-foreground mt-1">
								Try expanding the date range above.
							</p>
						</div>
					) : selectableCount === 0 ? (
						<div className="rounded-lg border border-dashed border-foreground/20 p-8 text-center">
							<VideoIcon className="size-8 mx-auto mb-3 text-muted-foreground" />
							<p className="text-sm text-muted-foreground">
								No additional meetings available to add
							</p>
							<p className="text-xs text-muted-foreground mt-1">
								Every meeting in this date range is already
								linked. Try expanding the date range above.
							</p>
						</div>
					) : (
						groups.map((group) => {
							const isExisting = existingUrlSet.has(
								group.joinUrl,
							);
							const isSelected =
								isExisting || selected.has(group.joinUrl);

							return (
								// biome-ignore lint/a11y/useKeyWithClickEvents: Checkbox handles keyboard interaction
								// biome-ignore lint/a11y/noStaticElementInteractions: wrapper delegates to Checkbox
								<div
									key={group.joinUrl}
									className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
										isExisting
											? "border-foreground/10 bg-muted/50 opacity-60 cursor-not-allowed"
											: isSelected
												? "border-primary/30 bg-primary/5 cursor-pointer"
												: "border-foreground/10 hover:bg-muted/30 cursor-pointer"
									}`}
									onClick={() => toggleGroup(group.joinUrl)}
								>
									<Checkbox
										checked={isSelected}
										onCheckedChange={() =>
											toggleGroup(group.joinUrl)
										}
										onPointerDown={(e) =>
											e.stopPropagation()
										}
										onClick={(e) => e.stopPropagation()}
										disabled={isExisting}
										className="mt-0.5"
										aria-label={`Select ${group.subject}`}
									/>
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<p className="text-sm font-medium truncate">
												{group.subject}
											</p>
											{isExisting && (
												<Badge
													variant="outline"
													className="text-[10px] shrink-0"
												>
													Linked
												</Badge>
											)}
										</div>
										<div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
											<span className="flex items-center gap-1">
												<UsersIcon className="size-3" />
												{group.organizer}
											</span>
											<span className="flex items-center gap-1">
												<CalendarIcon className="size-3" />
												{formatDate(group.latestDate)}
											</span>
											{group.instances.length > 1 && (
												<Badge
													variant="secondary"
													className="text-[10px]"
												>
													{group.instances.length}{" "}
													instances
												</Badge>
											)}
										</div>
									</div>
								</div>
							);
						})
					)}
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => handleOpenChange(false)}
						disabled={isLinking}
					>
						Cancel
					</Button>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								onClick={handleConfirm}
								disabled={
									selected.size === 0 ||
									isLinking ||
									selectableCount === 0
								}
							>
								{isLinking ? (
									<>
										<Loader2Icon className="size-4 mr-2 animate-spin" />
										Linking...
									</>
								) : (
									`Link ${selected.size} Meeting${selected.size !== 1 ? "s" : ""}`
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("linkMeetings")}</TooltipContent>
					</Tooltip>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
