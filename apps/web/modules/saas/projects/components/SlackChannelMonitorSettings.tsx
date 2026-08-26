"use client";

/**
 * SlackChannelMonitorSettings
 *
 * Project settings card for linking Slack channels to the event-driven Slack
 * Channel Monitor. Each linked channel feeds Slack messages through the same
 * proposal pipeline as Teams, producing PendingBacklogProposal rows with
 * `source: SLACK_CHANNEL` for human review.
 *
 * Unlike Teams (polling-based with a scan interval), Slack is event-driven
 * via the Events API webhook, so the "advanced" controls are debounce and
 * max-hold windows that govern when buffered messages are flushed for
 * analysis. Track 3 of the parent plan delivers the matching procedures
 * under `orpcClient.projects.slackChannelMonitor.*`.
 */

import { InlineJobProgress } from "@saas/jobs/components/InlineJobProgress";
import {
	findJobForSource,
	useProjectJobProgress,
} from "@saas/jobs/hooks/use-project-job-progress";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
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
	ChevronDownIcon,
	ChevronRightIcon,
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
import {
	getSlackChannelMonitorClient,
	type LinkedSlackChannel,
} from "../lib/slack-channel-monitor-client";
import { getSlackHuddleIngestClient } from "../lib/slack-huddle-ingest-client";
import { SlackChannelPickerDialog } from "./SlackChannelPickerDialog";

// Debounce options — how long to wait after the last signal before flushing
// the queued messages for analysis. Lower values surface proposals faster but
// fragment thread context.
const DEBOUNCE_OPTIONS = [
	{ value: "10000", label: "10 seconds" },
	{ value: "30000", label: "30 seconds" },
	{ value: "60000", label: "1 minute" },
	{ value: "180000", label: "3 minutes" },
	{ value: "300000", label: "5 minutes" },
];

// Max-hold options — the longest the workflow will keep buffering before it
// flushes regardless of new activity. Bounds staleness for chatty channels.
const MAX_HOLD_OPTIONS = [
	{ value: "120000", label: "2 minutes" },
	{ value: "300000", label: "5 minutes" },
	{ value: "600000", label: "10 minutes" },
	{ value: "1800000", label: "30 minutes" },
];

const DEFAULT_DEBOUNCE_MS = 30_000;
const DEFAULT_MAX_HOLD_MS = 300_000;
const FAILURE_THRESHOLD = 5;
/**
 * How long a failure stays visible on the row. Recency stands in for a reset:
 * the counter only clears on a successful cursor write, which a quiet channel
 * may never reach.
 */
const FAILURE_VISIBLE_MS = 24 * 60 * 60 * 1000;

// Poll cadence for the huddle-notes ingest workflow. Independent of the
// channel monitor's debounce/max-hold (which govern the event-driven flush).
const HUDDLE_INTERVAL_OPTIONS = [
	{ value: "15", label: "Every 15 minutes" },
	{ value: "30", label: "Every 30 minutes" },
	{ value: "60", label: "Every hour" },
];

const DEFAULT_HUDDLE_INTERVAL_MIN = 15;

// Slack returns `missing_scope` (or a message mentioning the scope) when the
// connection predates the `files:read`/`canvases:read` grant. Decision #7:
// surface a reconnect toast — no banner/CTA/gating.
function isMissingScopeError(error: unknown): boolean {
	const message =
		error instanceof Error ? error.message : String(error ?? "");
	return /scope/i.test(message);
}

type Props = {
	projectId: string;
	organizationId: string | null;
	project: {
		slackChannelMonitorEnabled?: boolean;
		slackChannelMonitorDebounceMs?: number | null;
		slackChannelMonitorMaxHoldMs?: number | null;
		slackChannelMonitorLastRun?: Date | string | null;
		slackHuddleIngestEnabled?: boolean;
		slackHuddleIngestIntervalMin?: number | null;
		slackHuddleIngestLastRun?: Date | string | null;
	};
};

export function SlackChannelMonitorSettings({
	projectId,
	organizationId,
	project,
}: Props) {
	const queryClient = useQueryClient();
	const runningJobs = useProjectJobProgress(projectId);
	const { confirm } = useConfirmationAlert();
	const t = useTranslations("tooltips.projectSettings");
	// Reuse the Teams unlink copy translation — semantically identical action.
	// A Slack-specific entry can be added later if product wants distinct copy.
	const unlinkCopy = t.raw("unlinkTeamsChannel") as DestructiveTooltipCopy;
	const [pickerOpen, setPickerOpen] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [debounceValue, setDebounceValue] = useState(
		String(project.slackChannelMonitorDebounceMs ?? DEFAULT_DEBOUNCE_MS),
	);
	const [maxHoldValue, setMaxHoldValue] = useState(
		String(project.slackChannelMonitorMaxHoldMs ?? DEFAULT_MAX_HOLD_MS),
	);
	const [localEnabled, setLocalEnabled] = useState(
		project.slackChannelMonitorEnabled === true,
	);
	const [huddleEnabled, setHuddleEnabled] = useState(
		project.slackHuddleIngestEnabled === true,
	);
	const [huddleIntervalValue, setHuddleIntervalValue] = useState(
		String(
			project.slackHuddleIngestIntervalMin ?? DEFAULT_HUDDLE_INTERVAL_MIN,
		),
	);
	const [huddleAdvancedOpen, setHuddleAdvancedOpen] = useState(false);

	useEffect(() => {
		if (project.slackChannelMonitorDebounceMs != null) {
			setDebounceValue(String(project.slackChannelMonitorDebounceMs));
		}
	}, [project.slackChannelMonitorDebounceMs]);

	useEffect(() => {
		if (project.slackChannelMonitorMaxHoldMs != null) {
			setMaxHoldValue(String(project.slackChannelMonitorMaxHoldMs));
		}
	}, [project.slackChannelMonitorMaxHoldMs]);

	useEffect(() => {
		setLocalEnabled(project.slackChannelMonitorEnabled === true);
	}, [project.slackChannelMonitorEnabled]);

	useEffect(() => {
		setHuddleEnabled(project.slackHuddleIngestEnabled === true);
	}, [project.slackHuddleIngestEnabled]);

	useEffect(() => {
		if (project.slackHuddleIngestIntervalMin != null) {
			setHuddleIntervalValue(
				String(project.slackHuddleIngestIntervalMin),
			);
		}
	}, [project.slackHuddleIngestIntervalMin]);

	const linkedChannelsQuery = useQuery({
		queryKey: ["slack-channel-monitor-linked", projectId, organizationId],
		queryFn: async () => {
			const client = getSlackChannelMonitorClient();
			const result = await client.listLinkedChannels({
				projectId,
				organizationId,
			});
			return result ?? [];
		},
	});

	const linkedChannels = linkedChannelsQuery.data ?? [];
	const hasLinkedChannels = linkedChannels.length > 0;

	const invalidateLinked = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey: [
				"slack-channel-monitor-linked",
				projectId,
				organizationId,
			],
		});
		queryClient.invalidateQueries({
			queryKey: [
				"slack-channel-monitor-pending-proposals-count",
				projectId,
				organizationId,
			],
		});
	}, [queryClient, projectId, organizationId]);

	const unlinkMutation = useMutation({
		mutationFn: async (linkedChannelId: string) => {
			const client = getSlackChannelMonitorClient();
			return await client.unlinkChannel({
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
		(channel: LinkedSlackChannel) => {
			const label = channel.channelName ?? "this channel";
			confirm({
				title: "Unlink channel",
				message: `Remove #${label} from the monitor? Seen-message history will be deleted. Existing proposals are kept.`,
				destructive: true,
				confirmLabel: "Unlink",
				onConfirm: async () => {
					await unlinkMutation.mutateAsync(channel.id);
				},
			});
		},
		[confirm, unlinkMutation],
	);

	const enableMutation = useMutation({
		mutationFn: async (payload: {
			debounceMs: number;
			maxHoldMs: number;
		}) => {
			const client = getSlackChannelMonitorClient();
			return await client.enable({
				projectId,
				organizationId,
				debounceMs: payload.debounceMs,
				maxHoldMs: payload.maxHoldMs,
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

	const disableMutation = useMutation({
		mutationFn: async () => {
			const client = getSlackChannelMonitorClient();
			return await client.disable({
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

	// Poll for lastRun updates after a manual trigger — same pattern as Teams.
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
			const client = getSlackChannelMonitorClient();
			return await client.triggerMonitor({
				projectId,
				organizationId,
			});
		},
		onSuccess: () => {
			toast.success("Monitor run started");
			invalidateLinked();

			const lastRunBefore = project.slackChannelMonitorLastRun
				? new Date(project.slackChannelMonitorLastRun).getTime()
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
						slackChannelMonitorLastRun?: Date | string | null;
					};
				}>(
					orpc.projects.get.queryKey({
						input: { id: projectId, organizationId },
					}),
				);
				const lastRunAfter = data?.project?.slackChannelMonitorLastRun
					? new Date(
							data.project.slackChannelMonitorLastRun,
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

	// ── Huddle-notes ingest (decision #5: independent opt-in) ────────────────
	const invalidateProject = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey: orpc.projects.get.queryKey({
				input: { id: projectId, organizationId },
			}),
		});
	}, [queryClient, projectId, organizationId]);

	const huddleEnableMutation = useMutation({
		mutationFn: async (intervalMinutes: number) => {
			const client = getSlackHuddleIngestClient();
			return await client.enable({
				projectId,
				organizationId,
				intervalMinutes,
			});
		},
		onSuccess: () => {
			setHuddleEnabled(true);
			toast.success("Huddle notes ingest enabled");
			invalidateProject();
		},
		onError: (error) => {
			if (isMissingScopeError(error)) {
				toast.error("Reconnect Slack to grant huddle-notes access", {
					description:
						"Your Slack connection predates the files:read / canvases:read scopes. Reconnect Slack to ingest huddle notes.",
				});
				return;
			}
			toast.error("Failed to enable huddle notes ingest", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const huddleDisableMutation = useMutation({
		mutationFn: async () => {
			const client = getSlackHuddleIngestClient();
			return await client.disable({ projectId, organizationId });
		},
		onSuccess: () => {
			setHuddleEnabled(false);
			toast.success("Huddle notes ingest disabled");
			invalidateProject();
		},
		onError: (error) => {
			toast.error("Failed to disable huddle notes ingest", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const huddleTriggerMutation = useMutation({
		mutationFn: async () => {
			const client = getSlackHuddleIngestClient();
			return await client.triggerNow({ projectId, organizationId });
		},
		onSuccess: () => {
			toast.success("Huddle notes ingest run started");
			invalidateProject();
		},
		onError: (error) => {
			if (isMissingScopeError(error)) {
				toast.error("Reconnect Slack to grant huddle-notes access", {
					description:
						"Your Slack connection predates the files:read / canvases:read scopes. Reconnect Slack to ingest huddle notes.",
				});
				return;
			}
			toast.error("Failed to start huddle notes ingest", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const handleHuddleToggle = useCallback(
		(enabled: boolean) => {
			if (enabled) {
				huddleEnableMutation.mutate(
					Number.parseInt(huddleIntervalValue, 10),
				);
			} else {
				huddleDisableMutation.mutate();
			}
		},
		[huddleEnableMutation, huddleDisableMutation, huddleIntervalValue],
	);

	const handleSaveHuddleInterval = useCallback(() => {
		huddleEnableMutation.mutate(Number.parseInt(huddleIntervalValue, 10));
	}, [huddleEnableMutation, huddleIntervalValue]);

	// Background poll for lastRun while the monitor is enabled. No reason to
	// hit the server every 30s when the user has the card open but nothing
	// is running.
	useEffect(() => {
		if (!localEnabled) {
			return;
		}
		const interval = setInterval(() => {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: { id: projectId, organizationId },
				}),
			});
		}, 30_000);
		return () => clearInterval(interval);
	}, [queryClient, projectId, organizationId, localEnabled]);

	const handleEnableToggle = useCallback(
		(enabled: boolean) => {
			if (enabled) {
				enableMutation.mutate({
					debounceMs: Number.parseInt(debounceValue, 10),
					maxHoldMs: Number.parseInt(maxHoldValue, 10),
				});
			} else {
				disableMutation.mutate();
			}
		},
		[enableMutation, disableMutation, debounceValue, maxHoldValue],
	);

	const handleSaveSchedule = useCallback(() => {
		enableMutation.mutate({
			debounceMs: Number.parseInt(debounceValue, 10),
			maxHoldMs: Number.parseInt(maxHoldValue, 10),
		});
	}, [enableMutation, debounceValue, maxHoldValue]);

	return (
		<>
			<Card className="border-foreground/10">
				<div className="space-y-4 p-4">
					{/* Header */}
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0 space-y-1.5">
							<span className="app-editorial-label">
								Slack Channel Monitor
							</span>
							<p className="text-sm text-muted-foreground">
								Watch linked Slack channels for discussions that
								suggest new features and queue them for review.
							</p>
						</div>
						{hasLinkedChannels && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => setPickerOpen(true)}
								aria-label="Link Slack channels"
							>
								<PlusIcon className="mr-2 size-4" />
								Link channels
							</Button>
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
								No Slack channels linked yet
							</p>
							<p className="mb-4 text-xs text-muted-foreground">
								Link a channel to start auto-proposing features
								from its discussions.
							</p>
							<Button
								variant="outline"
								onClick={() => setPickerOpen(true)}
							>
								<LinkIcon className="mr-2 size-4" />
								Link channels
							</Button>
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
												aria-label="Run Slack monitor now"
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
											Re-backfill from the last seen
											message and analyze any new threads.
										</TooltipContent>
									</Tooltip>
								</div>

								<div className="max-h-[260px] space-y-1.5 overflow-y-auto pr-1">
									{linkedChannels.map((channel) => {
										const displayLabel =
											channel.channelName ??
											"Unnamed channel";
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
										const seenCount =
											channel._count?.seenMessages ?? 0;
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
																	{seenCount}{" "}
																	thread
																	{seenCount !==
																	1
																		? "s"
																		: ""}{" "}
																	scanned
																</span>
																{project.slackChannelMonitorLastRun && (
																	<span className="flex items-center gap-1">
																		<ClockIcon className="size-3" />
																		Last run{" "}
																		{formatDistanceToNow(
																			new Date(
																				project.slackChannelMonitorLastRun,
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
																		"slackLinkedChannel",
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
															aria-label={`Unlink #${displayLabel}`}
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
											htmlFor="slack-monitor-auto-toggle"
											className="text-sm font-medium"
										>
											Auto-monitor
										</Label>
										<p className="text-xs text-muted-foreground">
											Watch linked channels in real time
											via the Slack Events API.
										</p>
									</div>
									<Switch
										id="slack-monitor-auto-toggle"
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
										{/* Advanced controls collapsed by default —
										    most users never change them. */}
										<button
											type="button"
											onClick={() =>
												setAdvancedOpen((prev) => !prev)
											}
											className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
											aria-expanded={advancedOpen}
											aria-controls="slack-monitor-advanced"
										>
											{advancedOpen ? (
												<ChevronDownIcon className="size-3" />
											) : (
												<ChevronRightIcon className="size-3" />
											)}
											Advanced
										</button>
										{advancedOpen && (
											<div
												id="slack-monitor-advanced"
												className="space-y-3"
											>
												<div className="grid gap-3 sm:grid-cols-2">
													<div className="space-y-1.5">
														<Label
															htmlFor="slack-monitor-debounce"
															className="text-xs font-medium text-muted-foreground"
														>
															Debounce window
														</Label>
														<Select
															value={
																debounceValue
															}
															onValueChange={
																setDebounceValue
															}
														>
															<SelectTrigger id="slack-monitor-debounce">
																<SelectValue />
															</SelectTrigger>
															<SelectContent>
																{DEBOUNCE_OPTIONS.map(
																	(opt) => (
																		<SelectItem
																			key={
																				opt.value
																			}
																			value={
																				opt.value
																			}
																		>
																			{
																				opt.label
																			}
																		</SelectItem>
																	),
																)}
															</SelectContent>
														</Select>
													</div>
													<div className="space-y-1.5">
														<Label
															htmlFor="slack-monitor-max-hold"
															className="text-xs font-medium text-muted-foreground"
														>
															Max hold
														</Label>
														<Select
															value={maxHoldValue}
															onValueChange={
																setMaxHoldValue
															}
														>
															<SelectTrigger id="slack-monitor-max-hold">
																<SelectValue />
															</SelectTrigger>
															<SelectContent>
																{MAX_HOLD_OPTIONS.map(
																	(opt) => (
																		<SelectItem
																			key={
																				opt.value
																			}
																			value={
																				opt.value
																			}
																		>
																			{
																				opt.label
																			}
																		</SelectItem>
																	),
																)}
															</SelectContent>
														</Select>
													</div>
												</div>
												<p className="text-xs text-muted-foreground">
													New messages are buffered
													until the channel is idle
													for the debounce window,
													then analyzed together. Max
													hold caps the longest
													possible buffer for chatty
													channels.
												</p>
											</div>
										)}
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
													"Save settings"
												)}
											</Button>
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
											{project.slackChannelMonitorLastRun && (
												<span className="flex items-center gap-1 text-xs text-muted-foreground">
													<ClockIcon className="size-3" />
													Last run:{" "}
													{formatDistanceToNow(
														new Date(
															project.slackChannelMonitorLastRun,
														),
														{ addSuffix: true },
													)}
												</span>
											)}
										</div>
									</div>
								)}
							</div>

							{/* Huddle-notes ingest — separate opt-in, reuses the
							    same linked channels (decision #5). */}
							<div className="space-y-3 rounded-lg border border-foreground/10 p-3">
								<div className="flex items-center justify-between gap-3">
									<div className="min-w-0">
										<Label
											htmlFor="slack-huddle-ingest-toggle"
											className="text-sm font-medium"
										>
											Ingest huddle notes
										</Label>
										<p className="text-xs text-muted-foreground">
											Ingest Slack huddle AI-notes from
											linked channels as AI Updates
											context.
										</p>
										<p className="mt-1 text-xs text-muted-foreground/80">
											Requires Slack AI notes (a paid
											Slack feature) enabled for the
											huddle.
										</p>
									</div>
									<Switch
										id="slack-huddle-ingest-toggle"
										checked={huddleEnabled}
										onCheckedChange={handleHuddleToggle}
										disabled={
											huddleEnableMutation.isPending ||
											huddleDisableMutation.isPending
										}
										aria-label="Ingest Slack huddle notes"
									/>
								</div>

								{huddleEnabled && (
									<div className="space-y-3">
										<button
											type="button"
											onClick={() =>
												setHuddleAdvancedOpen(
													(prev) => !prev,
												)
											}
											className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
											aria-expanded={huddleAdvancedOpen}
											aria-controls="slack-huddle-advanced"
										>
											{huddleAdvancedOpen ? (
												<ChevronDownIcon className="size-3" />
											) : (
												<ChevronRightIcon className="size-3" />
											)}
											Advanced
										</button>
										{huddleAdvancedOpen && (
											<div
												id="slack-huddle-advanced"
												className="space-y-1.5 sm:max-w-xs"
											>
												<Label
													htmlFor="slack-huddle-interval"
													className="text-xs font-medium text-muted-foreground"
												>
													Poll interval
												</Label>
												<Select
													value={huddleIntervalValue}
													onValueChange={
														setHuddleIntervalValue
													}
												>
													<SelectTrigger id="slack-huddle-interval">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{HUDDLE_INTERVAL_OPTIONS.map(
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
										)}
										<div className="flex flex-wrap items-center gap-2 pt-1">
											<Button
												size="sm"
												onClick={
													handleSaveHuddleInterval
												}
												disabled={
													huddleEnableMutation.isPending
												}
											>
												{huddleEnableMutation.isPending ? (
													<>
														<Loader2Icon className="mr-2 size-4 animate-spin" />
														Saving...
													</>
												) : (
													"Save settings"
												)}
											</Button>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														size="sm"
														variant="outline"
														onClick={() =>
															huddleTriggerMutation.mutate()
														}
														disabled={
															huddleTriggerMutation.isPending
														}
														aria-label="Run huddle notes ingest now"
													>
														{huddleTriggerMutation.isPending ? (
															<Loader2Icon className="mr-2 size-4 animate-spin" />
														) : (
															<RefreshCwIcon className="mr-2 size-4" />
														)}
														Ingest now
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													Pull any huddle AI-notes
													canvases posted since this
													was enabled into AI Updates
													context.
												</TooltipContent>
											</Tooltip>
											{project.slackHuddleIngestLastRun && (
												<span className="flex items-center gap-1 text-xs text-muted-foreground">
													<ClockIcon className="size-3" />
													Last run:{" "}
													{formatDistanceToNow(
														new Date(
															project.slackHuddleIngestLastRun,
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

			<SlackChannelPickerDialog
				projectId={projectId}
				organizationId={organizationId}
				open={pickerOpen}
				onOpenChange={setPickerOpen}
			/>
		</>
	);
}
