"use client";

/**
 * TeamsChatMonitorSettings
 *
 * Project settings card for linking Microsoft Teams group chats to the
 * scheduled Teams Chat Monitor and configuring its cadence. Each linked chat
 * is polled periodically; new messages are bundled into one synthetic thread
 * per tick and fed to the backlog analyzer, producing PendingBacklogProposal
 * rows for review.
 *
 * Mirrors `TeamsChannelMonitorSettings.tsx` 1:1 with chat-specific copy and
 * routes (chats have no team-channel hierarchy — flat list).
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
	LinkIcon,
	Loader2Icon,
	MessageSquareIcon,
	PlusIcon,
	RefreshCwIcon,
	UnlinkIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { TeamsChatPickerDialog } from "./TeamsChatPickerDialog";

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
		teamsChatMonitorEnabled?: boolean;
		teamsChatMonitorIntervalMin?: number | null;
		teamsChatMonitorQuietWindowMin?: number | null;
		teamsChatMonitorLastRun?: Date | string | null;
	};
};

type LinkedChat = {
	id: string;
	projectId: string;
	chatId: string;
	chatTopic: string | null;
	chatWebUrl: string | null;
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

export function TeamsChatMonitorSettings({
	projectId,
	organizationId,
	project,
}: Props) {
	const queryClient = useQueryClient();
	const runningJobs = useProjectJobProgress(projectId);
	const { confirm } = useConfirmationAlert();
	const t = useTranslations("tooltips.projectSettings");
	const unlinkCopy = t.raw("unlinkTeamsChat") as DestructiveTooltipCopy;
	const [pickerOpen, setPickerOpen] = useState(false);
	const [intervalValue, setIntervalValue] = useState(
		String(project.teamsChatMonitorIntervalMin ?? 360),
	);
	const [quietWindowValue, setQuietWindowValue] = useState(
		String(project.teamsChatMonitorQuietWindowMin ?? 60),
	);
	const [localEnabled, setLocalEnabled] = useState(
		project.teamsChatMonitorEnabled === true,
	);

	useEffect(() => {
		if (project.teamsChatMonitorIntervalMin != null) {
			setIntervalValue(String(project.teamsChatMonitorIntervalMin));
		}
	}, [project.teamsChatMonitorIntervalMin]);

	useEffect(() => {
		if (project.teamsChatMonitorQuietWindowMin != null) {
			setQuietWindowValue(String(project.teamsChatMonitorQuietWindowMin));
		}
	}, [project.teamsChatMonitorQuietWindowMin]);

	useEffect(() => {
		setLocalEnabled(project.teamsChatMonitorEnabled === true);
	}, [project.teamsChatMonitorEnabled]);

	const linkedChatsQuery = useQuery({
		queryKey: ["teams-chat-monitor-linked", projectId, organizationId],
		queryFn: async () => {
			const result =
				await orpcClient.projects.teamsChatMonitor.listLinkedChats({
					projectId,
					organizationId,
				});
			return (result ?? []) as LinkedChat[];
		},
	});

	const linkedChats = linkedChatsQuery.data ?? [];
	const hasLinkedChats = linkedChats.length > 0;

	const invalidateLinked = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey: ["teams-chat-monitor-linked", projectId, organizationId],
		});
		queryClient.invalidateQueries({
			queryKey: [
				"teams-chat-monitor-pending-proposals-count",
				projectId,
				organizationId,
			],
		});
	}, [queryClient, projectId, organizationId]);

	const unlinkMutation = useMutation({
		mutationFn: async (linkedChatId: string) => {
			return await orpcClient.projects.teamsChatMonitor.unlinkChat({
				projectId,
				organizationId,
				linkedChatId,
			});
		},
		onSuccess: () => {
			toast.success("Chat unlinked");
			invalidateLinked();
		},
		onError: (error) => {
			toast.error("Failed to unlink chat", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const requestUnlink = useCallback(
		(chat: LinkedChat) => {
			const label = chat.chatTopic ?? "this chat";
			confirm({
				title: "Unlink chat",
				message: `Remove ${label} from the monitor? Seen-message history will be deleted. Existing proposals are kept.`,
				destructive: true,
				confirmLabel: "Unlink",
				onConfirm: async () => {
					await unlinkMutation.mutateAsync(chat.id);
				},
			});
		},
		[confirm, unlinkMutation],
	);

	const enableMutation = useMutation({
		mutationFn: async (payload: {
			intervalMinutes: number;
			quietWindowMinutes: number;
		}) => {
			return await orpcClient.projects.teamsChatMonitor.enable({
				projectId,
				organizationId,
				intervalMinutes: payload.intervalMinutes,
				quietWindowMinutes: payload.quietWindowMinutes,
			});
		},
		onSuccess: () => {
			setLocalEnabled(true);
			toast.success("Chat monitor enabled");
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

	const disableMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.teamsChatMonitor.disable({
				projectId,
				organizationId,
			});
		},
		onSuccess: () => {
			setLocalEnabled(false);
			toast.success("Chat monitor disabled");
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
			return await orpcClient.projects.teamsChatMonitor.triggerMonitor({
				projectId,
				organizationId,
			});
		},
		onSuccess: () => {
			toast.success("Monitor run started");
			invalidateLinked();

			const lastRunBefore = project.teamsChatMonitorLastRun
				? new Date(project.teamsChatMonitorLastRun).getTime()
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
						teamsChatMonitorLastRun?: Date | string | null;
					};
				}>(
					orpc.projects.get.queryKey({
						input: { id: projectId, organizationId },
					}),
				);
				const lastRunAfter = data?.project?.teamsChatMonitorLastRun
					? new Date(data.project.teamsChatMonitorLastRun).getTime()
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
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0 space-y-1.5">
							<span className="app-editorial-label">
								Teams Chat Monitor
							</span>
							<p className="text-sm text-muted-foreground">
								Scan linked Teams group chats for conversations
								that suggest new features and queue them for
								review.
							</p>
						</div>
						{hasLinkedChats && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setPickerOpen(true)}
									>
										<PlusIcon className="mr-2 size-4" />
										Link chats
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("teamsMonitorLinkChats")}
								</TooltipContent>
							</Tooltip>
						)}
					</div>

					{linkedChatsQuery.isLoading ? (
						<div className="flex items-center justify-center py-8 text-muted-foreground">
							<Loader2Icon className="mr-2 size-5 animate-spin" />
							Loading...
						</div>
					) : !hasLinkedChats ? (
						<div className="rounded-lg border border-dashed border-foreground/20 p-8 text-center">
							<MessageSquareIcon className="mx-auto mb-3 size-10 text-muted-foreground" />
							<p className="mb-2 text-sm text-muted-foreground">
								No Teams chats linked yet
							</p>
							<p className="mb-4 text-xs text-muted-foreground">
								Link a group chat to start auto-proposing
								features from its discussions.
							</p>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										onClick={() => setPickerOpen(true)}
									>
										<LinkIcon className="mr-2 size-4" />
										Link chats
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("teamsMonitorLinkChats")}
								</TooltipContent>
							</Tooltip>
						</div>
					) : (
						<div className="space-y-4">
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<h4 className="text-sm font-medium text-muted-foreground">
										Linked chats ({linkedChats.length})
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
									{linkedChats.map((chat) => {
										const displayLabel =
											chat.chatTopic ?? "Group chat";
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
											chat.lastErrorAt != null &&
											Date.now() -
												new Date(
													chat.lastErrorAt,
												).getTime() <
												FAILURE_VISIBLE_MS;
										const needsRelink =
											chat.consecutiveFailures >=
											FAILURE_THRESHOLD;
										const hasFailures =
											needsRelink ||
											(chat.consecutiveFailures > 0 &&
												failureIsRecent);
										return (
											<div
												key={chat.id}
												className="rounded-lg border border-foreground/10 p-3"
											>
												<div className="flex items-start justify-between gap-3">
													<div className="flex min-w-0 items-center gap-3">
														<MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
														<div className="min-w-0">
															<p className="truncate text-sm font-medium">
																{displayLabel}
															</p>
															<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
																<span>
																	{
																		chat
																			._count
																			.seenMessages
																	}{" "}
																	message
																	{chat._count
																		.seenMessages !==
																	1
																		? "s"
																		: ""}{" "}
																	scanned
																</span>
																{project.teamsChatMonitorLastRun && (
																	<span className="flex items-center gap-1">
																		<ClockIcon className="size-3" />
																		Last run{" "}
																		{formatDistanceToNow(
																			new Date(
																				project.teamsChatMonitorLastRun,
																			),
																			{
																				addSuffix: true,
																			},
																		)}
																	</span>
																)}
																{/* Live counts for this chat's
																    in-flight scan, so basic status is
																    visible without opening the Job Hub. */}
																<InlineJobProgress
																	job={findJobForSource(
																		runningJobs,
																		"teamsLinkedChat",
																		chat.id,
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
																	chat,
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
															{chat.lastErrorMessage ??
																"Last run failed."}
															{needsRelink && (
																<span className="mt-1 block font-medium">
																	Repeated
																	failures —
																	please
																	re-link this
																	chat.
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

							<div className="space-y-3 rounded-lg border border-foreground/10 p-3">
								<div className="flex items-center justify-between">
									<div>
										<Label
											htmlFor="teams-chat-monitor-auto-toggle"
											className="text-sm font-medium"
										>
											Auto-monitor
										</Label>
										<p className="text-xs text-muted-foreground">
											Scan linked chats on a schedule.
										</p>
									</div>
									<Switch
										id="teams-chat-monitor-auto-toggle"
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
													htmlFor="teams-chat-monitor-interval"
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
													<SelectTrigger id="teams-chat-monitor-interval">
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
													htmlFor="teams-chat-monitor-quiet-window"
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
													<SelectTrigger id="teams-chat-monitor-quiet-window">
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
											A new message must be idle this long
											before we analyze it, so we capture
											the full conversation instead of the
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
											{project.teamsChatMonitorLastRun && (
												<span className="flex items-center gap-1 text-xs text-muted-foreground">
													<ClockIcon className="size-3" />
													Last run:{" "}
													{formatDistanceToNow(
														new Date(
															project.teamsChatMonitorLastRun,
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

			<TeamsChatPickerDialog
				projectId={projectId}
				organizationId={organizationId}
				open={pickerOpen}
				onOpenChange={setPickerOpen}
			/>
		</>
	);
}
