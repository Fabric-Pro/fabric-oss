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
	HashIcon,
	RefreshCwIcon,
	UsersIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import { TeamsChatSelectorDialog } from "../TeamsChatSelectorDialog";
import { useProjectMeetings } from "./use-project-meetings";

// =============================================================================
// Public types
// =============================================================================

const DAYS_BACK_VALUES = [7, 14, 30, 60, 90] as const;
export type DaysBack = (typeof DAYS_BACK_VALUES)[number];

export type SelectedMeeting = { joinUrl: string; startTime?: string };
export type SelectedChannel = { projectContextId: string };
export type ReviewSourcesResult = {
	selectedMeetings: SelectedMeeting[];
	selectedChannels: SelectedChannel[];
	daysBack: DaysBack;
};

// =============================================================================
// Internal types (meetings)
// =============================================================================

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

type LinkedChannelRow = {
	projectContextId: string;
	kind: "groupChat" | "channel";
	name: string;
	subtitle: string;
};

type Status = "idle" | "confirmed" | "skipped" | "hidden";

type TeamsIntegrationMetadata = {
	provider?: string;
	chatType?: string;
	chatId?: string;
	chatTopic?: string;
	teamId?: string;
	channelId?: string;
	teamName?: string;
	chatName?: string;
};

const DATE_RANGE_OPTIONS: { value: DaysBack; label: string }[] =
	DAYS_BACK_VALUES.map((value) => ({ value, label: `Last ${value} days` }));

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

// =============================================================================
// ReviewSourcesSelector (parent)
// =============================================================================

type Props = {
	projectId: string;
	organizationId: string | null;
	onConfirm: (result: ReviewSourcesResult) => void;
	onCancel: () => void;
};

export function ReviewSourcesSelector({
	projectId,
	organizationId,
	onConfirm,
	onCancel,
}: Props) {
	const [daysBack, setDaysBack] = useState<DaysBack>(30);
	const [selectedMeetings, setSelectedMeetings] = useState<SelectedMeeting[]>(
		[],
	);
	const [selectedChannels, setSelectedChannels] = useState<SelectedChannel[]>(
		[],
	);

	const [status, setStatus] = useState<Status>("idle");

	useEffect(() => {
		if (status === "confirmed" || status === "skipped") {
			const timer = setTimeout(() => setStatus("hidden"), 2000);
			return () => clearTimeout(timer);
		}
	}, [status]);

	if (status === "hidden") {
		return null;
	}

	if (status === "skipped") {
		return (
			<div className="rounded-lg border border-muted bg-muted/30 p-3">
				<p className="text-sm text-muted-foreground">
					Review sources selection skipped
				</p>
			</div>
		);
	}

	if (status === "confirmed") {
		return (
			<div className="rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/30 p-3 space-y-1.5">
				<div className="flex items-center gap-2">
					<CheckCircle2Icon className="size-4 text-success dark:text-green-400" />
					<p className="text-sm font-medium">
						{selectedMeetings.length} meeting(s) and{" "}
						{selectedChannels.length} channel/chat(s) selected
					</p>
				</div>
			</div>
		);
	}

	const selectedLabel =
		DATE_RANGE_OPTIONS.find((o) => o.value === daysBack)?.label ??
		"Last 30 days";

	const canConfirm =
		selectedMeetings.length > 0 || selectedChannels.length > 0;

	return (
		<div className="rounded-lg border p-4 space-y-4 max-w-full">
			{/* Header with shared date range selector */}
			<div className="flex items-center justify-between gap-2">
				<p className="text-sm font-medium">Select sources to review:</p>
				<Select
					value={String(daysBack)}
					onValueChange={(v) => setDaysBack(Number(v) as DaysBack)}
				>
					<SelectTrigger className="h-7 w-[150px] text-xs">
						<CalendarIcon className="size-3 mr-1.5" />
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{DATE_RANGE_OPTIONS.map((option) => (
							<SelectItem
								key={option.value}
								value={String(option.value)}
								className="text-xs"
							>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<MeetingsSection
				projectId={projectId}
				organizationId={organizationId}
				daysBack={daysBack}
				rangeLabel={selectedLabel}
				onSelectionChange={setSelectedMeetings}
			/>

			<ChannelsSection
				projectId={projectId}
				organizationId={organizationId}
				onSelectionChange={setSelectedChannels}
			/>

			<div className="flex items-center gap-2 pt-1">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="sm"
							disabled={!canConfirm}
							onClick={() => {
								setStatus("confirmed");
								onConfirm({
									selectedMeetings,
									selectedChannels,
									daysBack,
								});
							}}
						>
							Confirm (
							{selectedMeetings.length + selectedChannels.length}{" "}
							selected)
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						Use the selected meetings and channels as context for
						the backlog analysis
					</TooltipContent>
				</Tooltip>
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						setStatus("skipped");
						onCancel();
					}}
				>
					Skip
				</Button>
			</div>
		</div>
	);
}

// =============================================================================
// MeetingsSection
// =============================================================================

function MeetingsSection({
	projectId,
	organizationId,
	daysBack,
	rangeLabel,
	onSelectionChange,
}: {
	projectId: string;
	organizationId: string | null;
	daysBack: DaysBack;
	rangeLabel: string;
	onSelectionChange: (s: SelectedMeeting[]) => void;
}) {
	const { meetings, isLoading, isFetching, isError, error, refresh } =
		useProjectMeetings({ projectId, organizationId, daysBack });
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
		new Set(),
	);
	const tStories = useTranslations("tooltips.stories");

	// Reset the local selection whenever the date range changes (a different
	// range yields a different meeting set). Cache-served re-renders of the same
	// range keep the current selection. onSelectionChange is the parent's stable
	// setState, so this effect runs on mount + each daysBack change only.
	useEffect(() => {
		setSelected(new Set());
		setExpandedGroups(new Set());
		onSelectionChange([]);
	}, [daysBack, onSelectionChange]);

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

	const toggleMeeting = useCallback(
		(meetingId: string) => {
			const next = new Set(selected);
			if (next.has(meetingId)) {
				next.delete(meetingId);
			} else {
				next.add(meetingId);
			}
			setSelected(next);
			onSelectionChange(
				meetings
					.filter((m) => next.has(m.id))
					.map((m) => ({
						joinUrl: m.joinUrl,
						startTime: m.startTime ?? undefined,
					})),
			);
		},
		[selected, meetings, onSelectionChange],
	);

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

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-semibold">Meetings</h3>
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
			</div>
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
				</div>
			) : groups.length === 0 ? (
				<p className="text-xs text-muted-foreground">
					No meetings with transcripts found in the{" "}
					{rangeLabel.toLowerCase()}.
				</p>
			) : (
				<div className="space-y-1.5 max-h-[240px] overflow-y-auto">
					{groups.map((group) => {
						const isRecurring = group.instances.length > 1;
						const isExpanded = expandedGroups.has(group.joinUrl);
						const latestInstance = group.instances[0];
						const isHeaderSelected = selected.has(
							latestInstance?.id ?? "",
						);
						return (
							<div
								key={group.joinUrl}
								className="rounded-md border transition-colors"
							>
								{/* biome-ignore lint/a11y/useKeyWithClickEvents: Checkbox handles keyboard */}
								{/* biome-ignore lint/a11y/noStaticElementInteractions: wrapper delegates */}
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
								{isRecurring && isExpanded && (
									<div className="border-t px-2.5 py-1.5 bg-muted/30">
										<div className="space-y-0.5">
											{group.instances.map((instance) => {
												const isInstanceSelected =
													selected.has(instance.id);
												return (
													// biome-ignore lint/a11y/useKeyWithClickEvents: Checkbox handles keyboard
													// biome-ignore lint/a11y/noStaticElementInteractions: wrapper delegates
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
		</div>
	);
}

// =============================================================================
// ChannelsSection
// =============================================================================

function ChannelsSection({
	projectId,
	organizationId,
	onSelectionChange,
}: {
	projectId: string;
	organizationId: string | null;
	onSelectionChange: (s: SelectedChannel[]) => void;
}) {
	const [rows, setRows] = useState<LinkedChannelRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());

	const fetchRows = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);
			const result = await orpcClient.projects.contexts.list({
				projectId,
				organizationId,
				type: "INTEGRATION",
			});
			const parsed: LinkedChannelRow[] = [];
			for (const ctx of result.contexts ?? []) {
				const meta = (ctx.metadata ?? {}) as TeamsIntegrationMetadata;
				if (meta.provider !== "MICROSOFT_TEAMS") {
					continue;
				}
				if (
					meta.chatType === "channel" &&
					meta.teamId &&
					meta.channelId
				) {
					parsed.push({
						projectContextId: ctx.id,
						kind: "channel",
						name:
							meta.chatName || meta.chatTopic || "Teams channel",
						subtitle: meta.teamName ?? "Team channel",
					});
				} else if (meta.chatId) {
					parsed.push({
						projectContextId: ctx.id,
						kind: "groupChat",
						name: meta.chatTopic || "Teams group chat",
						subtitle: "Group chat",
					});
				}
			}
			setRows(parsed);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Failed to load linked channels",
			);
		} finally {
			setLoading(false);
		}
	}, [projectId, organizationId]);

	useEffect(() => {
		fetchRows();
	}, [fetchRows]);

	const toggle = useCallback(
		(id: string) => {
			const next = new Set(selected);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			setSelected(next);
			onSelectionChange(
				Array.from(next).map((projectContextId) => ({
					projectContextId,
				})),
			);
		},
		[selected, onSelectionChange],
	);

	return (
		<div className="space-y-2">
			<h3 className="text-sm font-semibold">
				Teams channels &amp; group chats
			</h3>
			{loading ? (
				<div className="space-y-2">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : error ? (
				<div className="space-y-2">
					<p className="text-xs text-destructive">{error}</p>
					<Button size="sm" variant="outline" onClick={fetchRows}>
						Retry
					</Button>
				</div>
			) : rows.length === 0 ? (
				<ChannelsEmptyState
					projectId={projectId}
					onChannelsLinked={fetchRows}
				/>
			) : (
				<div className="space-y-1.5 max-h-[240px] overflow-y-auto">
					{rows.map((row) => {
						const isSelected = selected.has(row.projectContextId);
						return (
							// biome-ignore lint/a11y/useKeyWithClickEvents: Checkbox handles keyboard
							// biome-ignore lint/a11y/noStaticElementInteractions: wrapper delegates
							<div
								key={row.projectContextId}
								className="flex items-start gap-3 p-2.5 rounded-md border cursor-pointer hover:bg-muted/50"
								onClick={() => toggle(row.projectContextId)}
							>
								<Checkbox
									checked={isSelected}
									onCheckedChange={() =>
										toggle(row.projectContextId)
									}
									onPointerDown={(e) => e.stopPropagation()}
									onClick={(e) => e.stopPropagation()}
									className="mt-0.5"
								/>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-1.5">
										{row.kind === "channel" ? (
											<HashIcon className="size-3.5 text-muted-foreground" />
										) : (
											<UsersIcon className="size-3.5 text-muted-foreground" />
										)}
										<p className="text-sm font-medium truncate">
											{row.name}
										</p>
									</div>
									<p className="text-xs text-muted-foreground mt-0.5">
										{row.subtitle}
									</p>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

// =============================================================================
// ChannelsEmptyState
// =============================================================================

function ChannelsEmptyState({
	projectId,
	onChannelsLinked,
}: {
	projectId: string;
	onChannelsLinked: () => void;
}) {
	const [dialogOpen, setDialogOpen] = useState(false);
	return (
		<>
			<div className="rounded-md border border-dashed p-3 space-y-2">
				<p className="text-xs text-muted-foreground">
					No Teams channels or group chats are linked to this project.
				</p>
				<Button
					size="sm"
					variant="outline"
					onClick={() => setDialogOpen(true)}
				>
					Link a channel or chat
				</Button>
			</div>
			{dialogOpen && (
				<TeamsChatSelectorDialog
					projectId={projectId}
					open={dialogOpen}
					onOpenChange={(open) => {
						setDialogOpen(open);
						if (!open) {
							onChannelsLinked();
						}
					}}
				/>
			)}
		</>
	);
}
