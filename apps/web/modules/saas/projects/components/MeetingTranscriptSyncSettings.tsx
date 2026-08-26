"use client";

/**
 * MeetingTranscriptSyncSettings
 *
 * Project settings card for linking Microsoft Teams meetings and syncing
 * their transcripts as project context. Supports auto-sync with
 * configurable intervals.
 */

import { LINKED_MEETINGS_QUERY_KEY } from "@saas/meeting-digest/hooks/use-linked-meeting-join-urls";
import { LinkedMeetingSelector } from "@saas/meetings/components";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
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
	CheckCircle2Icon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleDashedIcon,
	ClockIcon,
	FileTextIcon,
	InfoIcon,
	LinkIcon,
	Loader2Icon,
	PlusIcon,
	RefreshCwIcon,
	UnlinkIcon,
	VideoIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const AUTO_SYNC_INTERVALS = [
	{ value: "60", label: "Every hour" },
	{ value: "180", label: "Every 3 hours" },
	{ value: "360", label: "Every 6 hours" },
	{ value: "720", label: "Every 12 hours" },
	{ value: "1440", label: "Daily" },
];

type Props = {
	projectId: string;
	organizationId: string | null;
	project: {
		meetingTranscriptSyncEnabled?: boolean;
		meetingTranscriptSyncIntervalMin?: number | null;
		meetingTranscriptSyncLastRun?: Date | string | null;
		meetingTranscriptAutoAnalyzeEnabled?: boolean;
	};
};

type LinkedMeeting = {
	id: string;
	projectId: string;
	joinUrl: string;
	subject: string | null;
	organizer: string | null;
	linkedAt: string | Date;
	userId: string | null;
	organizationId: string | null;
	_count: {
		transcripts: number;
	};
};

type SyncedTranscript = {
	id: string;
	projectId: string;
	linkedMeetingId: string;
	meetingId: string;
	transcriptId: string;
	meetingSubject: string | null;
	meetingDate: string | Date | null;
	contextId: string | null;
	summary: string | null;
	keywords: string[];
	speakerNames: string[];
	contentLength: number | null;
	wasSummarized: boolean;
	// Auto-analysis scan-status lifecycle (DEC-03 / FR-10). Optional so the UI
	// tolerates an older payload that predates these columns.
	analysisStatus?: "NOT_SCANNED" | "IN_PROGRESS" | "SCANNED" | "FAILED";
	analysisError?: string | null;
	analysisFailedAt?: string | Date | null;
	analyzedAt?: string | Date | null;
	analyzedProposalId?: string | null;
	syncedAt: string | Date;
	userId: string | null;
	organizationId: string | null;
};

// Microsoft Teams icon component — decorative; visible "Teams" label always
// rendered alongside (avoids a duplicate accessible name).
function TeamsIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M19.098 7.753h-2.712c.105.333.162.687.162 1.054v5.628a2.61 2.61 0 0 1-2.61 2.61h-4.26a4.165 4.165 0 0 0 4.06 3.25h1.97a4.165 4.165 0 0 0 4.165-4.165V8.528a.775.775 0 0 0-.775-.775zM17.16 6.624a1.886 1.886 0 1 0 0-3.772 1.886 1.886 0 0 0 0 3.772zM13.938 8.807a1.974 1.974 0 0 0-1.974-1.974H5.67a1.974 1.974 0 0 0-1.974 1.974v5.628a1.974 1.974 0 0 0 1.974 1.974h6.294a1.974 1.974 0 0 0 1.974-1.974V8.807zM13.287 5.447a2.571 2.571 0 1 0-5.142 0 2.571 2.571 0 0 0 5.142 0z" />
		</svg>
	);
}

function formatDate(dateStr: string | Date | null): string {
	if (!dateStr) {
		return "Unknown date";
	}
	return new Date(dateStr).toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
	});
}

const SCAN_STATUS_PILL_BASE =
	"inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium";

/**
 * Per-transcript auto-analysis scan-status indicator (DEC-03 / FR-10):
 * Not scanned / Analyzing / Scanned / Failed. Tokens only; the spinner is
 * motion-safe and icons are decorative (the visible label carries the meaning).
 */
function TranscriptScanStatusPill({
	transcript,
}: {
	transcript: SyncedTranscript;
}) {
	const status = transcript.analysisStatus ?? "NOT_SCANNED";

	if (status === "SCANNED") {
		return (
			<span
				className={`${SCAN_STATUS_PILL_BASE} border-secondary/30 bg-secondary/10 text-secondary`}
			>
				<CheckCircle2Icon className="size-3" aria-hidden="true" />
				Scanned
			</span>
		);
	}
	if (status === "IN_PROGRESS") {
		// text-foreground (not text-highlight): amber #d97706 on the /10 tint fails
		// AA contrast for this 10px label in light mode. The amber bg + border keep
		// the "in progress" identity; the spinner carries the motion cue.
		return (
			<span
				className={`${SCAN_STATUS_PILL_BASE} border-highlight/30 bg-highlight/10 text-foreground`}
			>
				<Loader2Icon
					className="size-3 motion-safe:animate-spin text-highlight"
					aria-hidden="true"
				/>
				Analyzing…
			</span>
		);
	}
	if (status === "FAILED") {
		const pill = (
			<span
				className={`${SCAN_STATUS_PILL_BASE} border-destructive/30 bg-destructive/10 text-destructive`}
			>
				<AlertTriangleIcon className="size-3" aria-hidden="true" />
				Failed
			</span>
		);
		const error = transcript.analysisError;
		if (!error) {
			return pill;
		}
		// Surface the failure reason in a keyboard- + SR-accessible Tooltip
		// (a `title` attr is mouse-hover only). The visible "Failed" label still
		// conveys the state on its own.
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className="inline-flex cursor-help"
						aria-label={`Analysis failed: ${error}`}
					>
						{pill}
					</button>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">{error}</TooltipContent>
			</Tooltip>
		);
	}
	return (
		<span
			className={`${SCAN_STATUS_PILL_BASE} border-foreground/10 bg-muted text-muted-foreground`}
		>
			<CircleDashedIcon className="size-3" aria-hidden="true" />
			Not scanned
		</span>
	);
}

export function MeetingTranscriptSyncSettings({
	projectId,
	organizationId,
	project,
}: Props) {
	const queryClient = useQueryClient();
	const t = useTranslations("tooltips.projectSettings");
	const unlinkMeetingCopy = t.raw("unlinkMeeting") as {
		label: string;
		warning: string;
	};
	const { confirm } = useConfirmationAlert();
	// Which meeting is being unlinked, so the disabled state applies to that row
	// only. `unlinkMutation.isPending` is a single shared flag and was disabling
	// the unlink button on every row at once.
	const [unlinkingMeetingId, setUnlinkingMeetingId] = useState<string | null>(
		null,
	);
	const [selectorOpen, setSelectorOpen] = useState(false);
	const [autoSyncInterval, setAutoSyncInterval] = useState(
		String(project.meetingTranscriptSyncIntervalMin ?? 360),
	);
	const [expandedMeetings, setExpandedMeetings] = useState<Set<string>>(
		new Set(),
	);
	const [localSyncEnabled, setLocalSyncEnabled] = useState(
		project.meetingTranscriptSyncEnabled === true,
	);
	const [localAutoAnalyzeEnabled, setLocalAutoAnalyzeEnabled] = useState(
		project.meetingTranscriptAutoAnalyzeEnabled === true,
	);

	// Sync state from project prop
	useEffect(() => {
		if (project.meetingTranscriptSyncIntervalMin != null) {
			setAutoSyncInterval(
				String(project.meetingTranscriptSyncIntervalMin),
			);
		}
	}, [project.meetingTranscriptSyncIntervalMin]);

	useEffect(() => {
		setLocalSyncEnabled(project.meetingTranscriptSyncEnabled === true);
	}, [project.meetingTranscriptSyncEnabled]);

	useEffect(() => {
		setLocalAutoAnalyzeEnabled(
			project.meetingTranscriptAutoAnalyzeEnabled === true,
		);
	}, [project.meetingTranscriptAutoAnalyzeEnabled]);

	// Fetch linked meetings
	const { data: linkedMeetings, isLoading: linkedLoading } = useQuery({
		queryKey: [LINKED_MEETINGS_QUERY_KEY, projectId, organizationId],
		queryFn: async () => {
			const result =
				await orpcClient.projects.meetingTranscriptSync.listLinkedMeetings(
					{
						projectId,
						organizationId,
					},
				);
			return (result ?? []) as LinkedMeeting[];
		},
	});

	// Fetch synced transcripts
	const { data: transcripts } = useQuery({
		queryKey: [
			"meeting-transcript-sync-transcripts",
			projectId,
			organizationId,
		],
		queryFn: async () => {
			const result =
				await orpcClient.projects.meetingTranscriptSync.listTranscripts(
					{
						projectId,
						organizationId,
					},
				);
			return (result ?? []) as SyncedTranscript[];
		},
		enabled: (linkedMeetings?.length ?? 0) > 0,
	});

	// Group transcripts by linkedMeetingId
	const transcriptsByMeeting = useMemo(() => {
		const map = new Map<string, SyncedTranscript[]>();
		if (transcripts) {
			for (const t of transcripts) {
				const existing = map.get(t.linkedMeetingId) ?? [];
				existing.push(t);
				map.set(t.linkedMeetingId, existing);
			}
		}
		return map;
	}, [transcripts]);

	const existingJoinUrls = useMemo(
		() => (linkedMeetings ?? []).map((m) => m.joinUrl),
		[linkedMeetings],
	);

	const totalTranscripts = transcripts?.length ?? 0;
	const hasLinkedMeetings = (linkedMeetings?.length ?? 0) > 0;
	const autoSyncEnabled = localSyncEnabled;

	// Unlink meeting mutation
	const unlinkMutation = useMutation({
		mutationFn: async (linkedMeetingId: string) => {
			return await orpcClient.projects.meetingTranscriptSync.unlinkMeeting(
				{
					projectId,
					organizationId,
					linkedMeetingId,
				},
			);
		},
		onMutate: (linkedMeetingId: string) => {
			setUnlinkingMeetingId(linkedMeetingId);
		},
		onSettled: () => {
			setUnlinkingMeetingId(null);
		},
		onSuccess: () => {
			toast.success("Meeting unlinked");
			queryClient.invalidateQueries({
				queryKey: [
					LINKED_MEETINGS_QUERY_KEY,
					projectId,
					organizationId,
				],
			});
			queryClient.invalidateQueries({
				queryKey: [
					"meeting-transcript-sync-transcripts",
					projectId,
					organizationId,
				],
			});
		},
		onError: (error) => {
			toast.error("Failed to unlink meeting", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	// Unlink is not reversible by relinking: the procedure cascade-deletes the
	// synced transcripts, deletes the ProjectContext rows derived from them and
	// purges their Qdrant vectors. Copy is kept in step with the Digest tab's
	// dialog for the same action (#1905).
	const requestUnlink = useCallback(
		(meeting: { id: string; subject: string | null }) => {
			confirm({
				title: `Unlink ${meeting.subject ?? "this meeting"}?`,
				message:
					"This removes the meeting from the project and permanently deletes its synced transcripts and their indexed context. Project answers that cite this meeting will lose that source.",
				confirmLabel: "Unlink meeting",
				destructive: true,
				onConfirm: async () => {
					await unlinkMutation.mutateAsync(meeting.id);
				},
			});
		},
		[confirm, unlinkMutation],
	);

	// Enable auto-sync mutation
	const enableMutation = useMutation({
		mutationFn: async (intervalMinutes: number) => {
			return await orpcClient.projects.meetingTranscriptSync.enable({
				projectId,
				organizationId,
				intervalMinutes,
			});
		},
		onSuccess: () => {
			setLocalSyncEnabled(true);
			toast.success("Auto-sync enabled");
			queryClient.invalidateQueries({
				queryKey: [
					LINKED_MEETINGS_QUERY_KEY,
					projectId,
					organizationId,
				],
			});
		},
		onError: (error) => {
			toast.error("Failed to enable auto-sync", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	// Disable auto-sync mutation
	const disableMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.meetingTranscriptSync.disable({
				projectId,
				organizationId,
			});
		},
		onSuccess: () => {
			setLocalSyncEnabled(false);
			toast.success("Auto-sync disabled");
			queryClient.invalidateQueries({
				queryKey: [
					LINKED_MEETINGS_QUERY_KEY,
					projectId,
					organizationId,
				],
			});
		},
		onError: (error) => {
			toast.error("Failed to disable auto-sync", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	// Auto-create feature proposals mutation. Flips the project-level
	// `meetingTranscriptAutoAnalyzeEnabled` flag the auto-analysis hook
	// reads; it starts no Temporal workflow. The flag is surfaced via
	// `projects.get`, so invalidate that query to keep the persisted value
	// fresh across the page (the toggle reflects optimistic local state in
	// the meantime).
	const setAutoAnalyzeMutation = useMutation({
		mutationFn: async (enabled: boolean) => {
			return await orpcClient.projects.meetingTranscriptSync.setAutoAnalyze(
				{
					projectId,
					organizationId,
					enabled,
				},
			);
		},
		onSuccess: (_data, enabled) => {
			setLocalAutoAnalyzeEnabled(enabled);
			toast.success(
				enabled
					? "Auto-create proposals enabled"
					: "Auto-create proposals disabled",
			);
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: { id: projectId, organizationId },
				}),
			});
		},
		onError: (error) => {
			toast.error("Failed to update auto-create proposals", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	// Poll for "Last sync" timestamp update after triggering sync.
	// The Temporal workflow runs async, so we poll until the DB value changes.
	const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		return () => {
			if (syncPollRef.current) {
				clearInterval(syncPollRef.current);
			}
		};
	}, []);

	// Trigger sync now mutation
	const triggerSyncMutation = useMutation({
		mutationFn: async (daysBack?: number) => {
			return await orpcClient.projects.meetingTranscriptSync.triggerSync({
				projectId,
				organizationId,
				...(daysBack ? { daysBack } : {}),
			});
		},
		onSuccess: () => {
			toast.success("Transcript sync started");
			queryClient.invalidateQueries({
				queryKey: [
					"meeting-transcript-sync-transcripts",
					projectId,
					organizationId,
				],
			});

			// Poll project data every 2s until meetingTranscriptSyncLastRun changes (max 30s).
			const lastRunBefore = project.meetingTranscriptSyncLastRun
				? new Date(project.meetingTranscriptSyncLastRun).getTime()
				: 0;
			let elapsed = 0;

			if (syncPollRef.current) {
				clearInterval(syncPollRef.current);
			}
			syncPollRef.current = setInterval(async () => {
				elapsed += 2000;
				await queryClient.invalidateQueries({
					queryKey: orpc.projects.get.queryKey({
						input: { id: projectId, organizationId },
					}),
				});
				const data = queryClient.getQueryData<{
					project?: {
						meetingTranscriptSyncLastRun?: Date | string | null;
					};
				}>(
					orpc.projects.get.queryKey({
						input: { id: projectId, organizationId },
					}),
				);
				const lastRunAfter = data?.project?.meetingTranscriptSyncLastRun
					? new Date(
							data.project.meetingTranscriptSyncLastRun,
						).getTime()
					: 0;

				if (lastRunAfter > lastRunBefore || elapsed >= 30000) {
					if (syncPollRef.current) {
						clearInterval(syncPollRef.current);
					}
					syncPollRef.current = null;
				}
			}, 2000);
		},
		onError: (error) => {
			toast.error("Failed to trigger sync", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const handleAutoSyncToggle = useCallback(
		(enabled: boolean) => {
			if (enabled) {
				enableMutation.mutate(Number.parseInt(autoSyncInterval, 10));
			} else {
				disableMutation.mutate();
			}
		},
		[autoSyncInterval, enableMutation, disableMutation],
	);

	const handleAutoAnalyzeToggle = useCallback(
		(enabled: boolean) => {
			setAutoAnalyzeMutation.mutate(enabled);
		},
		[setAutoAnalyzeMutation],
	);

	const handleIntervalChange = useCallback(
		(value: string) => {
			setAutoSyncInterval(value);
			if (autoSyncEnabled) {
				enableMutation.mutate(Number.parseInt(value, 10));
			}
		},
		[autoSyncEnabled, enableMutation],
	);

	const toggleExpandedMeeting = useCallback((meetingId: string) => {
		setExpandedMeetings((prev) => {
			const next = new Set(prev);
			if (next.has(meetingId)) {
				next.delete(meetingId);
			} else {
				next.add(meetingId);
			}
			return next;
		});
	}, []);

	const handleLinked = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey: [LINKED_MEETINGS_QUERY_KEY, projectId, organizationId],
		});
	}, [queryClient, projectId, organizationId]);

	return (
		<>
			<Card className="overflow-hidden border-foreground/10">
				{/* Header */}
				<div className="flex items-start justify-between gap-3 p-4 sm:p-5">
					<div className="flex min-w-0 items-center gap-3">
						<div className="shrink-0 rounded-xl bg-primary/10 p-2.5">
							<VideoIcon className="size-5 text-primary" />
						</div>
						<div className="min-w-0">
							<h3 className="text-base font-semibold leading-tight">
								Meeting Transcript Sync
							</h3>
							<p className="mt-0.5 text-sm text-muted-foreground">
								Link Teams meetings and sync transcripts as
								project context
							</p>
						</div>
					</div>
					{hasLinkedMeetings && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="sm"
									className="shrink-0"
									onClick={() => setSelectorOpen(true)}
								>
									<PlusIcon className="mr-2 size-4" />
									Link meeting
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{t("linkMoreMeetings")}
							</TooltipContent>
						</Tooltip>
					)}
				</div>

				{linkedLoading ? (
					<div className="flex items-center justify-center gap-2 border-t border-foreground/10 py-10 text-muted-foreground">
						<Loader2Icon className="size-5 animate-spin" />
						Loading...
					</div>
				) : !hasLinkedMeetings ? (
					/* Empty state */
					<div className="border-t border-foreground/10 p-4 sm:p-5">
						<div className="rounded-xl border border-dashed border-foreground/20 p-8 text-center">
							<VideoIcon className="mx-auto mb-3 size-10 text-muted-foreground" />
							<p className="mb-2 text-sm text-muted-foreground">
								No meetings linked to this project
							</p>
							<p className="mb-4 text-xs text-muted-foreground">
								Link recurring meetings to automatically sync
								their transcripts as project context
							</p>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										onClick={() => setSelectorOpen(true)}
									>
										<LinkIcon className="mr-2 size-4" />
										Link meeting
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("linkMeetings")}
								</TooltipContent>
							</Tooltip>
						</div>
					</div>
				) : (
					<>
						{/* Linked meetings */}
						<div className="space-y-3 border-t border-foreground/10 p-4 sm:p-5">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<h4 className="text-sm font-semibold text-foreground">
										Linked Meetings
									</h4>
									<span className="inline-flex items-center justify-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
										{linkedMeetings?.length ?? 0}
									</span>
								</div>
								<div className="flex items-center">
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												onClick={() =>
													triggerSyncMutation.mutate(
														undefined,
													)
												}
												disabled={
													triggerSyncMutation.isPending
												}
												aria-label="Sync transcripts now"
												className="h-auto gap-2 px-2 py-1 text-primary hover:text-primary"
											>
												{triggerSyncMutation.isPending ? (
													<Loader2Icon className="size-4 animate-spin" />
												) : (
													<RefreshCwIcon className="size-4" />
												)}
												Sync now
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("syncTranscriptsNow")}
										</TooltipContent>
									</Tooltip>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												aria-label="Sync options"
												disabled={
													triggerSyncMutation.isPending
												}
												className="h-auto px-1 py-1 text-primary hover:text-primary"
											>
												<ChevronDownIcon className="size-4" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												onClick={() =>
													triggerSyncMutation.mutate(
														undefined,
													)
												}
											>
												Sync last 30 days
											</DropdownMenuItem>
											<DropdownMenuItem
												onClick={() =>
													triggerSyncMutation.mutate(
														90,
													)
												}
											>
												Backfill last 90 days
											</DropdownMenuItem>
											<DropdownMenuItem
												onClick={() =>
													triggerSyncMutation.mutate(
														180,
													)
												}
											>
												Backfill last 180 days
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</div>

							<div className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
								{linkedMeetings?.map((meeting) => {
									const meetingTranscripts =
										transcriptsByMeeting.get(meeting.id) ??
										[];
									const isExpanded = expandedMeetings.has(
										meeting.id,
									);
									// Compute last synced time from transcripts
									const latestSyncedAt =
										meetingTranscripts.length > 0
											? meetingTranscripts[0]?.syncedAt
											: null;

									return (
										<div
											key={meeting.id}
											className="rounded-xl border border-foreground/10 bg-card"
										>
											<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3">
												<div className="flex min-w-0 grow shrink-0 basis-[60%] items-center gap-3">
													<div className="shrink-0 rounded-lg bg-primary/10 p-2">
														<VideoIcon className="size-4 text-primary" />
													</div>
													<div className="min-w-0">
														<p
															className="truncate text-sm font-semibold"
															title={
																meeting.subject ??
																"Untitled meeting"
															}
														>
															{meeting.subject ??
																"Untitled meeting"}
														</p>
														<div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
															{meeting.organizer && (
																<>
																	<span
																		className="max-w-[200px] truncate"
																		title={
																			meeting.organizer
																		}
																	>
																		{
																			meeting.organizer
																		}
																	</span>
																	<span
																		aria-hidden
																	>
																		·
																	</span>
																</>
															)}
															<span className="flex items-center gap-1">
																<TeamsIcon className="size-3" />
																Teams
															</span>
															{latestSyncedAt && (
																<>
																	<span
																		aria-hidden
																	>
																		·
																	</span>
																	<span className="flex items-center gap-1">
																		<ClockIcon className="size-3" />
																		Synced{" "}
																		{formatDistanceToNow(
																			new Date(
																				latestSyncedAt,
																			),
																			{
																				addSuffix: true,
																			},
																		)}
																	</span>
																</>
															)}
														</div>
													</div>
												</div>
												<div className="flex shrink-0 items-center gap-1.5">
													{meeting._count
														.transcripts > 0 && (
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<button
																	type="button"
																	onClick={() =>
																		toggleExpandedMeeting(
																			meeting.id,
																		)
																	}
																	className="flex items-center gap-1.5 rounded-full border border-secondary/30 bg-secondary/10 px-2.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-secondary/20"
																	aria-label={`${isExpanded ? "Collapse" : "Expand"} transcripts for ${meeting.subject ?? "meeting"}`}
																>
																	<FileTextIcon className="size-3.5" />
																	{
																		meeting
																			._count
																			.transcripts
																	}{" "}
																	transcript
																	{meeting
																		._count
																		.transcripts !==
																	1
																		? "s"
																		: ""}
																	<ChevronRightIcon
																		className={`size-3.5 transition-transform duration-200 ${
																			isExpanded
																				? "rotate-90"
																				: ""
																		}`}
																	/>
																</button>
															</TooltipTrigger>
															<TooltipContent>
																{t(
																	"togglePerMeetingTranscripts",
																)}
															</TooltipContent>
														</Tooltip>
													)}
													<DestructiveTooltip
														copy={unlinkMeetingCopy}
													>
														<Button
															variant="ghost"
															size="icon"
															onClick={() =>
																requestUnlink(
																	meeting,
																)
															}
															disabled={
																unlinkingMeetingId ===
																meeting.id
															}
															aria-label={`Unlink ${meeting.subject ?? "meeting"}`}
														>
															<UnlinkIcon className="size-4 text-muted-foreground" />
														</Button>
													</DestructiveTooltip>
												</div>
											</div>

											{/* Expanded transcripts for this meeting */}
											{isExpanded &&
												meetingTranscripts.length >
													0 && (
													<div className="space-y-1.5 border-t border-foreground/10 bg-muted/30 px-3 py-2">
														{meetingTranscripts.map(
															(transcript) => (
																<div
																	key={
																		transcript.id
																	}
																	className="flex items-start gap-2 text-xs"
																>
																	<FileTextIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
																	<div className="min-w-0">
																		<div className="flex flex-wrap items-center gap-1.5">
																			<p className="text-muted-foreground">
																				{formatDate(
																					transcript.meetingDate,
																				)}
																			</p>
																			<TranscriptScanStatusPill
																				transcript={
																					transcript
																				}
																			/>
																		</div>
																		{transcript.summary && (
																			<p className="mt-0.5 line-clamp-2 text-foreground/70">
																				{
																					transcript.summary
																				}
																			</p>
																		)}
																		{transcript
																			.keywords
																			.length >
																			0 && (
																			<div className="mt-1 flex flex-wrap gap-1">
																				{transcript.keywords
																					.slice(
																						0,
																						5,
																					)
																					.map(
																						(
																							keyword,
																						) => (
																							<Badge
																								key={
																									keyword
																								}
																								variant="outline"
																								className="px-1 py-0 text-[10px]"
																							>
																								{
																									keyword
																								}
																							</Badge>
																						),
																					)}
																			</div>
																		)}
																	</div>
																</div>
															),
														)}
													</div>
												)}
										</div>
									);
								})}
							</div>
						</div>

						{/* Auto-sync + auto-create controls (grouped muted section) */}
						<div className="space-y-4 border-t border-foreground/10 bg-muted/40 p-4 sm:p-5">
							{/* Scheduled auto-sync */}
							<div className="space-y-3">
								<div className="flex items-center justify-between gap-3">
									<div>
										<Label
											htmlFor="meeting-transcript-auto-sync-toggle"
											className="text-sm font-semibold"
										>
											Scheduled auto-sync
										</Label>
										<p className="text-xs text-muted-foreground">
											Automatically pull new transcripts
											on a schedule
										</p>
									</div>
									<Switch
										id="meeting-transcript-auto-sync-toggle"
										checked={autoSyncEnabled}
										onCheckedChange={handleAutoSyncToggle}
										disabled={
											enableMutation.isPending ||
											disableMutation.isPending
										}
										aria-label="Scheduled auto-sync"
									/>
								</div>

								{autoSyncEnabled && (
									<div className="flex flex-wrap items-center gap-3">
										<Select
											value={autoSyncInterval}
											onValueChange={handleIntervalChange}
										>
											<SelectTrigger className="w-[160px] bg-background">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{AUTO_SYNC_INTERVALS.map(
													(opt) => (
														<SelectItem
															key={opt.value}
															value={opt.value}
														>
															{opt.label}
														</SelectItem>
													),
												)}
											</SelectContent>
										</Select>
										<div className="flex items-center gap-3 text-xs text-muted-foreground">
											{project.meetingTranscriptSyncLastRun && (
												<span className="flex items-center gap-1">
													<ClockIcon className="size-3" />
													Last sync:{" "}
													{formatDistanceToNow(
														new Date(
															project.meetingTranscriptSyncLastRun,
														),
														{ addSuffix: true },
													)}
												</span>
											)}
											{totalTranscripts > 0 && (
												<span className="flex items-center gap-1.5">
													<span
														className="size-1.5 rounded-full bg-secondary"
														aria-hidden
													/>
													{totalTranscripts}{" "}
													transcript
													{totalTranscripts !== 1
														? "s"
														: ""}{" "}
													synced
												</span>
											)}
										</div>
									</div>
								)}
							</div>

							<div className="border-t border-foreground/10" />

							{/*
							 * Auto-create feature proposals. Opt-in, gated on
							 * transcript sync (D1): a stored `true` is inert
							 * without sync because the auto-analysis hook
							 * checks BOTH flags. The toggle stays visible but
							 * disabled with an explanatory tooltip when sync
							 * is off so the dependency is discoverable. When
							 * disabled, the Switch is wrapped in a focusable
							 * span so the tooltip still opens on hover/focus
							 * (a disabled Radix Switch fires neither).
							 */}
							<div className="flex items-center justify-between gap-3">
								<div>
									<Label
										htmlFor="meeting-transcript-auto-analyze-toggle"
										className="text-sm font-semibold"
									>
										Auto-create proposals
									</Label>
									<p className="text-xs text-muted-foreground">
										When a transcript syncs, analyze it and
										add proposals to your Proposal Inbox
									</p>
								</div>
								{localSyncEnabled ? (
									<Switch
										id="meeting-transcript-auto-analyze-toggle"
										checked={localAutoAnalyzeEnabled}
										onCheckedChange={
											handleAutoAnalyzeToggle
										}
										disabled={
											setAutoAnalyzeMutation.isPending
										}
										aria-label="Auto-create proposals"
									/>
								) : (
									<Tooltip>
										<TooltipTrigger asChild>
											<span
												// biome-ignore lint/a11y/noNoninteractiveTabindex: the disabled switch fires no pointer/focus events, so the span is the focusable Tooltip trigger that surfaces the "enable sync first" reason to keyboard + AT users.
												tabIndex={0}
												className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
											>
												<Switch
													id="meeting-transcript-auto-analyze-toggle"
													checked={
														localAutoAnalyzeEnabled
													}
													disabled
													aria-label="Auto-create proposals"
													tabIndex={-1}
													className="pointer-events-none"
												/>
											</span>
										</TooltipTrigger>
										<TooltipContent>
											Enable transcript sync first
										</TooltipContent>
									</Tooltip>
								)}
							</div>

							{/* Footer note */}
							<p className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
								<InfoIcon className="size-3.5 shrink-0" />
								Syncs transcripts from the last 30 days for each
								linked meeting
							</p>
						</div>
					</>
				)}
			</Card>

			<LinkedMeetingSelector
				projectId={projectId}
				organizationId={organizationId}
				open={selectorOpen}
				onOpenChange={setSelectorOpen}
				onLinked={handleLinked}
				existingJoinUrls={existingJoinUrls}
			/>
		</>
	);
}
