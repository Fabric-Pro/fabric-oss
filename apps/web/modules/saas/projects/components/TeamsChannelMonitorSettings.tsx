"use client";

/**
 * TeamsChannelMonitorSettings
 *
 * Project settings card for linking Microsoft Teams channels to the scheduled
 * Teams Channel Monitor and configuring its cadence. Each linked channel has
 * its threads scanned periodically; mature threads are fed to the backlog
 * analyzer, producing PendingBacklogProposal rows for review.
 */

import { InlineJobProgress } from "@saas/jobs/components/InlineJobProgress";
import {
	findJobForSource,
	useProjectJobProgress,
} from "@saas/jobs/hooks/use-project-job-progress";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	DestructiveTooltip,
	type DestructiveTooltipCopy,
} from "@ui/components/destructive-tooltip";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangleIcon,
	ClockIcon,
	HashIcon,
	LinkIcon,
	Loader2Icon,
	PlusIcon,
	RefreshCwIcon,
	UnlinkIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { TeamsChannelPickerDialog } from "./TeamsChannelPickerDialog";

const MONITOR_INTERVALS = [
	{ value: "60", label: "Every hour" },
	{ value: "180", label: "Every 3 hours" },
	{ value: "360", label: "Every 6 hours" },
	{ value: "720", label: "Every 12 hours" },
	{ value: "1440", label: "Daily" },
];

const QUIET_WINDOWS = [
	{ value: "30", label: "30 minutes" },
	{ value: "60", label: "1 hour" },
	{ value: "120", label: "2 hours" },
	{ value: "240", label: "4 hours" },
];

const FAILURE_THRESHOLD = 5;
/**
 * How long a failure stays visible on the row. Recency stands in for a reset:
 * the counter only clears on a successful cursor write, which a quiet channel
 * may never reach.
 */
const FAILURE_VISIBLE_MS = 24 * 60 * 60 * 1000;

type Props = {
	projectId: string;
	organizationId: string | null;
	project: {
		teamsChannelMonitorEnabled?: boolean;
		teamsChannelMonitorIntervalMin?: number | null;
		teamsChannelMonitorQuietWindowMin?: number | null;
		teamsChannelMonitorLastRun?: Date | string | null;
	};
};

type LinkedChannel = {
	id: string;
	projectId: string;
	teamId: string;
	channelId: string;
	teamName: string | null;
	channelName: string | null;
	channelWebUrl: string | null;
	linkedAt: string | Date;
	lastMessageCreatedAt: string | Date | null;
	lastMessageId: string | null;
	consecutiveFailures: number;
	lastErrorMessage: string | null;
	lastErrorAt: string | Date | null;
	userId: string | null;
	organizationId: string | null;
	_count: {
		seenMessages: number;
	};
};

export function TeamsChannelMonitorSettings({
	projectId,
	organizationId,
	project,
}: Props) {
	const queryClient = useQueryClient();
	const runningJobs = useProjectJobProgress(projectId);
	const { confirm } = useConfirmationAlert();
	const t = useTranslations("tooltips.projectSettings");
	const unlinkCopy = t.raw("unlinkTeamsChannel") as DestructiveTooltipCopy;
	const [pickerOpen, setPickerOpen] = useState(false);
	const [intervalValue, setIntervalValue] = useState(
		String(project.teamsChannelMonitorIntervalMin ?? 360),
	);
	const [quietWindowValue, setQuietWindowValue] = useState(
		String(project.teamsChannelMonitorQuietWindowMin ?? 60),
	);
	const [localEnabled, setLocalEnabled] = useState(
		project.teamsChannelMonitorEnabled === true,
	);

	useEffect(() => {
		if (project.teamsChannelMonitorIntervalMin != null) {
			setIntervalValue(String(project.teamsChannelMonitorIntervalMin));
		}
	}, [project.teamsChannelMonitorIntervalMin]);

	useEffect(() => {
		if (project.teamsChannelMonitorQuietWindowMin != null) {
			setQuietWindowValue(
				String(project.teamsChannelMonitorQuietWindowMin),
			);
		}
	}, [project.teamsChannelMonitorQuietWindowMin]);

	useEffect(() => {
		setLocalEnabled(project.teamsChannelMonitorEnabled === true);
	}, [project.teamsChannelMonitorEnabled]);

	// Fetch linked channels
	const linkedChannelsQuery = useQuery({
		queryKey: ["teams-channel-monitor-linked", projectId, organizationId],
		queryFn: async () => {
			const result =
				await orpcClient.projects.teamsChannelMonitor.listLinkedChannels(
					{
						projectId,
						organizationId,
					},
				);
			return (result ?? []) as LinkedChannel[];
		},
	});

	const linkedChannels = linkedChannelsQuery.data ?? [];
	const hasLinkedChannels = linkedChannels.length > 0;

	const invalidateLinked = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey: [
				"teams-channel-monitor-linked",
				projectId,
				organizationId,
			],
		});
		queryClient.invalidateQueries({
			queryKey: [
				"teams-channel-monitor-pending-proposals-count",
				projectId,
				organizationId,
			],
		});
	}, [queryClient, projectId, organizationId]);

	// Unlink mutation (wrapped in confirmation dialog)
	const unlinkMutation = useMutation({
		mutationFn: async (linkedChannelId: string) => {
			return await orpcClient.projects.teamsChannelMonitor.unlinkChannel({
				projectId,
				organizationId,
				linkedChannelId,
			});
		},
		onSuccess: () => {
			toast.success("Channel unlinked");
			invalidateLinked();
		},
		onError: (error) => {
			toast.error("Failed to unlink channel", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const requestUnlink = useCallback(
		(channel: LinkedChannel) => {
			const label =
				channel.teamName && channel.channelName
					? `${channel.teamName} - ${channel.channelName}`
					: (channel.channelName ?? "this channel");
			confirm({
				title: "Unlink channel",
				message: `Remove ${label} from the monitor? Seen-message history will be deleted. Existing proposals are kept.`,
				destructive: true,
				confirmLabel: "Unlink",
				onConfirm: async () => {
					await unlinkMutation.mutateAsync(channel.id);
				},
			});
		},
		[confirm, unlinkMutation],
	);

	// Enable mutation
	const enableMutation = useMutation({
		mutationFn: async (payload: {
			intervalMinutes: number;
			quietWindowMinutes: number;
		}) => {
			return await orpcClient.projects.teamsChannelMonitor.enable({
				projectId,
				organizationId,
				intervalMinutes: payload.intervalMinutes,
				quietWindowMinutes: payload.quietWindowMinutes,
			});
		},
		onSuccess: () => {
			setLocalEnabled(true);
			toast.success("Channel monitor enabled");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: { id: projectId, organizationId },
				}),
			});
			invalidateLinked();
		},
		onError: (error) => {
			toast.error("Failed to enable monitor", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	// Disable mutation
	const disableMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.teamsChannelMonitor.disable({
				projectId,
				organizationId,
			});
		},
		onSuccess: () => {
			setLocalEnabled(false);
			toast.success("Channel monitor disabled");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: { id: projectId, organizationId },
				}),
			});
		},
		onError: (error) => {
			toast.error("Failed to disable monitor", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	// Poll for lastRun updates after a manual trigger
	const runPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	useEffect(() => {
		return () => {
			if (runPollRef.current) {
				clearInterval(runPollRef.current);
			}
		};
	}, []);

	const triggerMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.teamsChannelMonitor.triggerMonitor(
				{
					projectId,
					organizationId,
				},
			);
		},
		onSuccess: () => {
			toast.success("Monitor run started");
			invalidateLinked();

			const lastRunBefore = project.teamsChannelMonitorLastRun
				? new Date(project.teamsChannelMonitorLastRun).getTime()
				: 0;
			let elapsed = 0;
			if (runPollRef.current) {
				clearInterval(runPollRef.current);
			}
			runPollRef.current = setInterval(async () => {
				elapsed += 2000;
				await queryClient.invalidateQueries({
					queryKey: orpc.projects.get.queryKey({
						input: { id: projectId, organizationId },
					}),
				});
				const data = queryClient.getQueryData<{
					project?: {
						teamsChannelMonitorLastRun?: Date | string | null;
					};
				}>(
					orpc.projects.get.queryKey({
						input: { id: projectId, organizationId },
					}),
				);
				const lastRunAfter = data?.project?.teamsChannelMonitorLastRun
					? new Date(
							data.project.teamsChannelMonitorLastRun,
						).getTime()
					: 0;
				if (lastRunAfter > lastRunBefore || elapsed >= 30000) {
					if (runPollRef.current) {
						clearInterval(runPollRef.current);
					}
					runPollRef.current = null;
				}
			}, 2000);
		},
		onError: (error) => {
			toast.error("Failed to trigger monitor", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	// Also poll every 30s for lastRun while the settings card is mounted — mirrors
	// the meeting-transcript-sync pattern so users see state changes while they
	// keep the page open.
	useEffect(() => {
		const interval = setInterval(() => {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: { id: projectId, organizationId },
				}),
			});
		}, 30_000);
		return () => clearInterval(interval);
	}, [queryClient, projectId, organizationId]);

	const handleEnableToggle = useCallback(
		(enabled: boolean) => {
			if (enabled) {
				enableMutation.mutate({
					intervalMinutes: Number.parseInt(intervalValue, 10),
					quietWindowMinutes: Number.parseInt(quietWindowValue, 10),
				});
			} else {
				disableMutation.mutate();
			}
		},
		[enableMutation, disableMutation, intervalValue, quietWindowValue],
	);

	const handleSaveSchedule = useCallback(() => {
		enableMutation.mutate({
			intervalMinutes: Number.parseInt(intervalValue, 10),
			quietWindowMinutes: Number.parseInt(quietWindowValue, 10),
		});
	}, [enableMutation, intervalValue, quietWindowValue]);

	return (
		<>
			<Card className="border-foreground/10">
				<div className="space-y-4 p-4">
					{/* Header */}
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0 space-y-1.5">
							<span className="app-editorial-label">
								Teams Channel Monitor
							</span>
							<p className="text-sm text-muted-foreground">
								Scan linked Teams channels for discussions that
								suggest new features and queue them for review.
							</p>
						</div>
						{hasLinkedChannels && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setPickerOpen(true)}
									>
										<PlusIcon className="mr-2 size-4" />
										Link channels
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("teamsMonitorLinkChannels")}
								</TooltipContent>
							</Tooltip>
						)}
					</div>

					{linkedChannelsQuery.isLoading ? (
						<div className="flex items-center justify-center py-8 text-muted-foreground">
							<Loader2Icon className="mr-2 size-5 animate-spin" />
							Loading...
						</div>
					) : !hasLinkedChannels ? (
						<div className="rounded-lg border border-dashed border-foreground/20 p-8 text-center">
							<HashIcon className="mx-auto mb-3 size-10 text-muted-foreground" />
							<p className="mb-2 text-sm text-muted-foreground">
								No Teams channels linked yet
							</p>
							<p className="mb-4 text-xs text-muted-foreground">
								Link a channel to start auto-proposing features
								from its discussions.
							</p>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										onClick={() => setPickerOpen(true)}
									>
										<LinkIcon className="mr-2 size-4" />
										Link channels
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("teamsMonitorLinkChannels")}
								</TooltipContent>
							</Tooltip>
						</div>
					) : (
						<div className="space-y-4">
							{/* Linked channels list */}
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<h4 className="text-sm font-medium text-muted-foreground">
										Linked channels ({linkedChannels.length}
										)
									</h4>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												onClick={() =>
													triggerMutation.mutate()
												}
												disabled={
													triggerMutation.isPending
												}
												aria-label="Run monitor now"
											>
												{triggerMutation.isPending ? (
													<Loader2Icon className="mr-2 size-4 animate-spin" />
												) : (
													<RefreshCwIcon className="mr-2 size-4" />
												)}
												Monitor now
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("teamsMonitorRunNow")}
										</TooltipContent>
									</Tooltip>
								</div>

								<div className="max-h-[260px] space-y-1.5 overflow-y-auto pr-1">
									{linkedChannels.map((channel) => {
										const displayLabel =
											channel.teamName &&
											channel.channelName
												? `${channel.teamName} - ${channel.channelName}`
												: (channel.channelName ??
													"Unnamed channel");
										// Surface a failure as soon as one happens —
										// gating the box on the threshold meant a hard
										// auth failure, which the Job Hub reports
										// immediately, left this row looking perfectly
										// healthy.
										//
										// Bounded by recency because
										// `consecutiveFailures` is only reset by a
										// successful cursor write, which a quiet
										// channel may not reach for a long time (the
										// Slack live monitor never does). Without this
										// a single old blip would pin a red box on a
										// working channel forever. Past the threshold
										// it shows regardless — that many failures is
										// not a blip.
										const failureIsRecent =
											channel.lastErrorAt != null &&
											Date.now() -
												new Date(
													channel.lastErrorAt,
												).getTime() <
												FAILURE_VISIBLE_MS;
										const needsRelink =
											channel.consecutiveFailures >=
											FAILURE_THRESHOLD;
										const hasFailures =
											needsRelink ||
											(channel.consecutiveFailures > 0 &&
												failureIsRecent);
										return (
											<div
												key={channel.id}
												className="rounded-lg border border-foreground/10 p-3"
											>
												<div className="flex items-start justify-between gap-3">
													<div className="flex min-w-0 items-center gap-3">
														<HashIcon className="size-4 shrink-0 text-muted-foreground" />
														<div className="min-w-0">
															<p className="truncate text-sm font-medium">
																{displayLabel}
															</p>
															<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
																<span>
																	{
																		channel
																			._count
																			.seenMessages
																	}{" "}
																	thread
																	{channel
																		._count
																		.seenMessages !==
																	1
																		? "s"
																		: ""}{" "}
																	scanned
																</span>
																{project.teamsChannelMonitorLastRun && (
																	<span className="flex items-center gap-1">
																		<ClockIcon className="size-3" />
																		Last run{" "}
																		{formatDistanceToNow(
																			new Date(
																				project.teamsChannelMonitorLastRun,
																			),
																			{
																				addSuffix: true,
																			},
																		)}
																	</span>
																)}
																{/* Live counts for this channel's
																    in-flight scan, so basic status is
																    visible without opening the Job Hub. */}
																<InlineJobProgress
																	job={findJobForSource(
																		runningJobs,
																		"teamsLinkedChannel",
																		channel.id,
																	)}
																/>
															</div>
														</div>
													</div>
													<DestructiveTooltip
														copy={unlinkCopy}
													>
														<Button
															variant="ghost"
															size="icon"
															onClick={() =>
																requestUnlink(
																	channel,
																)
															}
															disabled={
																unlinkMutation.isPending
															}
															aria-label={`Unlink ${displayLabel}`}
														>
															<UnlinkIcon className="size-4 text-muted-foreground" />
														</Button>
													</DestructiveTooltip>
												</div>
												{hasFailures && (
													<div
														role="status"
														className="mt-2 flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
													>
														<AlertTriangleIcon
															aria-hidden="true"
															className="mt-0.5 size-3.5 shrink-0"
														/>
														<span>
															{channel.lastErrorMessage ??
																"Last run failed."}
															{needsRelink && (
																<span className="mt-1 block font-medium">
																	Repeated
																	failures —
																	please
																	re-link this
																	channel.
																</span>
															)}
														</span>
													</div>
												)}
											</div>
										);
									})}
								</div>
							</div>

							{/* Auto-monitor controls */}
							<div className="space-y-3 rounded-lg border border-foreground/10 p-3">
								<div className="flex items-center justify-between">
									<div>
										<Label
											htmlFor="teams-monitor-auto-toggle"
											className="text-sm font-medium"
										>
											Auto-monitor
										</Label>
										<p className="text-xs text-muted-foreground">
											Scan linked channels on a schedule.
										</p>
									</div>
									<Switch
										id="teams-monitor-auto-toggle"
										checked={localEnabled}
										onCheckedChange={handleEnableToggle}
										disabled={
											enableMutation.isPending ||
											disableMutation.isPending
										}
									/>
								</div>

								{localEnabled && (
									<div className="space-y-3">
										<div className="grid gap-3 sm:grid-cols-2">
											<div className="space-y-1.5">
												<Label
													htmlFor="teams-monitor-interval"
													className="text-xs font-medium text-muted-foreground"
												>
													Scan interval
												</Label>
												<Select
													value={intervalValue}
													onValueChange={
														setIntervalValue
													}
												>
													<SelectTrigger id="teams-monitor-interval">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{MONITOR_INTERVALS.map(
															(opt) => (
																<SelectItem
																	key={
																		opt.value
																	}
																	value={
																		opt.value
																	}
																>
																	{opt.label}
																</SelectItem>
															),
														)}
													</SelectContent>
												</Select>
											</div>
											<div className="space-y-1.5">
												<Label
													htmlFor="teams-monitor-quiet-window"
													className="text-xs font-medium text-muted-foreground"
												>
													Quiet window
												</Label>
												<Select
													value={quietWindowValue}
													onValueChange={
														setQuietWindowValue
													}
												>
													<SelectTrigger id="teams-monitor-quiet-window">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{QUIET_WINDOWS.map(
															(opt) => (
																<SelectItem
																	key={
																		opt.value
																	}
																	value={
																		opt.value
																	}
																>
																	{opt.label}
																</SelectItem>
															),
														)}
													</SelectContent>
												</Select>
											</div>
										</div>
										<p className="text-xs text-muted-foreground">
											A thread must be idle this long
											before we analyze it, so we capture
											the full discussion instead of the
											first message.
										</p>
										<div className="flex flex-wrap items-center gap-2 pt-1">
											<Button
												size="sm"
												onClick={handleSaveSchedule}
												disabled={
													enableMutation.isPending
												}
											>
												{enableMutation.isPending ? (
													<>
														<Loader2Icon className="mr-2 size-4 animate-spin" />
														Saving...
													</>
												) : (
													"Save schedule"
												)}
											</Button>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														size="sm"
														variant="outline"
														onClick={() =>
															disableMutation.mutate()
														}
														disabled={
															disableMutation.isPending
														}
													>
														Disable
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{t("teamsMonitorDisable")}
												</TooltipContent>
											</Tooltip>
											{project.teamsChannelMonitorLastRun && (
												<span className="flex items-center gap-1 text-xs text-muted-foreground">
													<ClockIcon className="size-3" />
													Last run:{" "}
													{formatDistanceToNow(
														new Date(
															project.teamsChannelMonitorLastRun,
														),
														{ addSuffix: true },
													)}
												</span>
											)}
										</div>
									</div>
								)}
							</div>
						</div>
					)}
				</div>
			</Card>

			<TeamsChannelPickerDialog
				projectId={projectId}
				organizationId={organizationId}
				open={pickerOpen}
				onOpenChange={setPickerOpen}
			/>
		</>
	);
}
