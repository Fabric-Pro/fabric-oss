"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import {
	AlertTriangleIcon,
	CheckCircleIcon,
	CircleXIcon,
	ClockIcon,
	CodeIcon,
	ExternalLinkIcon,
	FlaskConicalIcon,
	GitBranchIcon,
	GitPullRequestIcon,
	Loader2Icon,
	MessageSquareIcon,
	MessagesSquareIcon,
	MonitorIcon,
	PlayIcon,
	SendIcon,
	SquareIcon,
	WorkflowIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	getExecutionChannelLabel,
	getExecutionProviderLabel,
	getFabricAgentConnectionLabel,
} from "../../lib/implementation-session-labels";
import {
	asProviderMetadata,
	formatPrimaryTaskLabel,
} from "../../lib/implementation-session-runtime";
import { asSpikeRunView } from "../../lib/spike-runs";
import { SpikeRunCard } from "./SpikeRunCard";

type Props = {
	codingRunId: string;
	organizationId?: string | null;
	onCancel?: () => void;
	onFollowUpSent?: () => void;
	/** Needed to render the spike DEMO_READY actions (accept / discard). */
	projectId?: string | null;
};

export function CodingRunTimeline({
	codingRunId,
	organizationId,
	onCancel,
	onFollowUpSent,
	projectId,
}: Props) {
	const [followUpMessage, setFollowUpMessage] = useState("");
	const queryClient = useQueryClient();

	const { data: run, isLoading } = useQuery({
		queryKey: ["codingRun", codingRunId],
		queryFn: () =>
			orpcClient.codingRuns.get({
				id: codingRunId,
				organizationId: organizationId ?? null,
			}),
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			// DEMO_READY only changes through a person accepting or
			// discarding, which invalidates this query explicitly.
			if (
				status &&
				["COMPLETED", "FAILED", "CANCELLED", "DEMO_READY"].includes(
					status,
				)
			) {
				return false;
			}
			return 3000;
		},
	});

	const isRunActive =
		run?.status &&
		[
			"QUEUED",
			"STARTING",
			"RUNNING",
			"AWAITING_REVIEW",
			"PR_OPENED",
		].includes(run.status);

	const { data: liveStatus } = useQuery({
		queryKey: ["codingRunLiveStatus", codingRunId],
		queryFn: async () =>
			orpcClient.codingRuns.pollLiveStatus
				? await orpcClient.codingRuns.pollLiveStatus({
						id: codingRunId,
						organizationId: organizationId ?? null,
					})
				: null,
		enabled: !!run && !!isRunActive,
		refetchInterval: (query) => {
			const providerStatus = query.state.data?.liveStatus?.providerStatus;
			if (
				providerStatus &&
				["completed", "failed", "stopped", "archived"].includes(
					providerStatus,
				)
			) {
				return false;
			}
			return 5000;
		},
	});

	const sendFollowUp = useMutation({
		mutationFn: async (message: string) => {
			return orpcClient.codingRuns.sendFollowUp({
				id: codingRunId,
				message,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			setFollowUpMessage("");
			queryClient.invalidateQueries({
				queryKey: ["codingRun", codingRunId],
			});
			onFollowUpSent?.();
		},
		onError: (err) => {
			toast.error(
				err instanceof Error ? err.message : "Failed to send message",
			);
		},
	});

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Loader2Icon className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!run) {
		return (
			<p className="py-4 text-center text-sm text-muted-foreground">
				Implementation session not found
			</p>
		);
	}

	const isActive = [
		"QUEUED",
		"STARTING",
		"RUNNING",
		"AWAITING_REVIEW",
		"PR_OPENED",
	].includes(run.status);
	const isCompleted = run.status === "COMPLETED";
	const spikeRun = asSpikeRunView(run);
	const isSpike = spikeRun?.kind === "SPIKE";
	const spikeStoryId =
		spikeRun?.storyId ??
		(run as { storyId?: string | null }).storyId ??
		null;
	const spikeProjectId =
		projectId ?? (run as { projectId?: string | null }).projectId ?? null;
	const pullRequestUrl =
		run.pullRequestUrl ?? liveStatus?.liveStatus?.pullRequestUrl ?? null;
	const pullRequestNumber =
		run.pullRequestNumber ??
		(pullRequestUrl
			? Number.parseInt(
					pullRequestUrl.match(/\/pull\/(\d+)/)?.[1] ?? "",
					10,
				) || null
			: null);
	const hasPR =
		Boolean(pullRequestUrl) &&
		(["PR_OPENED", "AWAITING_REVIEW", "COMPLETED"].includes(run.status) ||
			Boolean(liveStatus?.liveStatus?.hasPullRequest));
	const backgroundAgentsUrl = process.env.NEXT_PUBLIC_BACKGROUND_AGENTS_URL;
	const sessionUrl =
		run.externalUrl ||
		(run.providerSessionId && backgroundAgentsUrl
			? `${backgroundAgentsUrl}/session/${run.providerSessionId}`
			: null);
	const eventCount = run.events?.length ?? 0;
	const _metadata = asProviderMetadata(run.providerMetadata);
	const connectionLabel = getFabricAgentConnectionLabel(
		typeof _metadata?.llmConnection === "string"
			? _metadata.llmConnection
			: null,
	);
	const worktreePath =
		typeof _metadata?.worktreePath === "string"
			? _metadata.worktreePath
			: run.workingDirectory || null;
	const activeBranch =
		liveStatus?.liveStatus?.branchName ||
		(typeof _metadata?.branch === "string" ? _metadata.branch : null) ||
		run.pullRequestBranch ||
		run.targetBranch ||
		null;
	const isFabricAgentsSession =
		run.provider === "BACKGROUND_AGENTS" ||
		Boolean(sessionUrl?.startsWith("fabric-agent://"));
	const isDeepLink = Boolean(sessionUrl?.startsWith("fabric-agent://"));
	const primaryTaskLabel = formatPrimaryTaskLabel(run.storyTask);
	const failureReason = extractRunFailureReason(
		run.events,
		liveStatus?.liveStatus?.error,
		_metadata,
	);
	const progressSteps = computeExecutionProgressSteps({
		status: run.status,
		hasSession: Boolean(run.providerSessionId || sessionUrl),
		hasPR: Boolean(hasPR),
		isSpike,
	});

	return (
		<div className="space-y-4">
			<div className="rounded-2xl border border-border/60 bg-muted/[0.28] p-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="space-y-2">
						<p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
							Current status
						</p>
						<div className="flex items-center gap-2.5">
							<StatusIcon status={run.status} />
							<span className="text-sm font-semibold text-foreground">
								{formatStatus(run.status)}
							</span>
						</div>
						<div className="flex flex-wrap items-center gap-2 pt-1">
							{isSpike && (
								<Badge
									variant="outline"
									className="rounded-full border-primary/20 bg-primary/5 px-2.5 py-1 text-[11px] text-primary"
								>
									<FlaskConicalIcon className="mr-1 size-3" />
									Spike
								</Badge>
							)}
							<Badge
								variant="outline"
								className="rounded-full px-2.5 py-1 text-[11px]"
							>
								{getExecutionChannelLabel(run.executionChannel)}
							</Badge>
							<Badge
								variant="outline"
								className="rounded-full px-2.5 py-1 text-[11px]"
							>
								{getExecutionProviderLabel(run.provider)}
							</Badge>
							{connectionLabel && (
								<Badge
									variant="outline"
									className="rounded-full border-primary/20 bg-primary/5 px-2.5 py-1 text-[11px] text-primary"
								>
									{connectionLabel}
								</Badge>
							)}
							{run.storyTask && (
								<Badge
									variant="outline"
									className="rounded-full px-2.5 py-1 text-[11px]"
								>
									Primary task: {run.storyTask.identifier}
								</Badge>
							)}
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{isActive && (
							<Badge
								variant="secondary"
								className="rounded-full px-2.5 py-1 text-[11px]"
							>
								Live
							</Badge>
						)}
						{liveStatus?.liveStatus && (
							<Badge
								variant="outline"
								className="rounded-full border-primary/30 bg-primary/5 px-2.5 py-1 text-[11px] text-primary"
							>
								Agent:{" "}
								{liveStatus.liveStatus.sessionState ??
									liveStatus.liveStatus.providerStatus}
							</Badge>
						)}
						<Badge
							variant="outline"
							className="rounded-full px-2.5 py-1 text-[11px]"
						>
							{eventCount} {eventCount === 1 ? "event" : "events"}
						</Badge>
					</div>
				</div>
			</div>

			{isSpike && spikeRun && spikeStoryId && spikeProjectId && (
				<SpikeRunCard
					run={spikeRun}
					projectId={spikeProjectId}
					storyId={spikeStoryId}
				/>
			)}

			{(run.status === "FAILED" ||
				run.status === "TERMINATED_STALE" ||
				liveStatus?.liveStatus?.providerStatus === "failed") && (
				<div
					role="alert"
					className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4"
				>
					<div className="flex items-start gap-3">
						<div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
							<AlertTriangleIcon className="size-4" />
						</div>
						<div className="min-w-0 flex-1">
							<p className="text-[11px] font-medium uppercase tracking-[0.16em] text-destructive">
								Execution failure details
							</p>
							<p className="mt-1 break-words text-sm text-foreground/90">
								{failureReason ||
									(run.status === "TERMINATED_STALE"
										? "The coding run exceeded the maximum allowed duration and was stopped."
										: "The coding agent session reported a failure. Check the session in Fabric Agents or retry.")}
							</p>
						</div>
					</div>
				</div>
			)}

			<section
				className="rounded-2xl border border-border/60 bg-background p-4"
				aria-label="Execution progress"
			>
				<div className="flex items-center justify-between gap-2">
					<p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
						Task &amp; execution progress
					</p>
					{activeBranch && (
						<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground">
							<GitBranchIcon className="size-3 text-primary" />
							{activeBranch}
						</span>
					)}
				</div>
				<ol className="mt-3 grid gap-2 sm:grid-cols-4">
					{progressSteps.map((step) => (
						<li
							key={step.key}
							className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
								step.state === "completed"
									? "border-primary/25 bg-primary/[0.04] text-foreground"
									: step.state === "active"
										? "border-primary/40 bg-primary/[0.08] font-medium text-foreground"
										: step.state === "failed"
											? "border-destructive/30 bg-destructive/5 text-destructive"
											: "border-border/50 bg-muted/20 text-muted-foreground"
							}`}
						>
							{step.state === "completed" ? (
								<CheckCircleIcon className="size-3.5 shrink-0 text-success" />
							) : step.state === "active" ? (
								<Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
							) : step.state === "failed" ? (
								<CircleXIcon className="size-3.5 shrink-0 text-destructive" />
							) : (
								<ClockIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
							)}
							<span className="truncate">{step.label}</span>
						</li>
					))}
				</ol>
			</section>

			{primaryTaskLabel && (
				<div className="rounded-2xl border border-highlight/20 bg-highlight/5 p-4">
					<div className="flex items-start gap-3">
						<div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-highlight/10 text-highlight">
							<WorkflowIcon className="size-4" />
						</div>
						<div className="min-w-0 flex-1">
							<p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
								Primary task focus
							</p>
							<p className="mt-1 text-sm font-semibold text-foreground">
								{primaryTaskLabel}
							</p>
							<p className="mt-1 text-xs leading-5 text-muted-foreground">
								This implementation session was launched from a
								task and should prioritize this task before
								broader feature follow-through.
							</p>
						</div>
					</div>
				</div>
			)}

			{(run.status === "AWAITING_REVIEW" ||
				liveStatus?.liveStatus?.providerStatus === "paused") &&
				run.provider === "BACKGROUND_AGENTS" && (
					<div className="rounded-2xl border border-highlight/30 bg-highlight/5 p-4">
						<div className="flex items-start gap-3">
							<div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-highlight/10 text-highlight">
								<MessagesSquareIcon className="size-4" />
							</div>
							<div className="min-w-0 flex-1 space-y-3">
								<div>
									<p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
										Agent awaiting input
									</p>
									<p className="mt-1 text-sm text-foreground/80">
										The agent has paused and is waiting for
										your review or instructions before
										continuing.
									</p>
								</div>
								<div className="flex gap-2">
									<Textarea
										placeholder="Reply to the agent…"
										value={followUpMessage}
										onChange={(e) =>
											setFollowUpMessage(e.target.value)
										}
										rows={2}
										className="resize-none text-sm"
										onKeyDown={(e) => {
											if (
												e.key === "Enter" &&
												(e.metaKey || e.ctrlKey) &&
												followUpMessage.trim()
											) {
												e.preventDefault();
												sendFollowUp.mutate(
													followUpMessage.trim(),
												);
											}
										}}
									/>
									<Button
										type="button"
										size="icon"
										variant="outline"
										className="mt-auto shrink-0"
										disabled={
											!followUpMessage.trim() ||
											sendFollowUp.isPending
										}
										onClick={() =>
											sendFollowUp.mutate(
												followUpMessage.trim(),
											)
										}
										aria-label="Send reply"
									>
										{sendFollowUp.isPending ? (
											<Loader2Icon className="size-4 animate-spin" />
										) : (
											<MessageSquareIcon className="size-4" />
										)}
									</Button>
								</div>
								<p className="text-[11px] text-muted-foreground">
									⌘↵ to send
								</p>
							</div>
						</div>
					</div>
				)}

			<div className="grid gap-3 sm:grid-cols-2">
				{sessionUrl && (
					<a
						href={sessionUrl}
						target={isDeepLink ? undefined : "_blank"}
						rel={isDeepLink ? undefined : "noopener noreferrer"}
						className="flex min-h-14 items-center gap-3 rounded-xl border border-primary/30 bg-primary/[0.04] px-4 py-3 text-sm transition-colors hover:bg-primary/[0.08]"
					>
						<div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
							<MonitorIcon className="size-4 text-primary" />
						</div>
						<div className="min-w-0 flex-1">
							<p className="font-medium text-foreground">
								{isFabricAgentsSession
									? "Open in Fabric Agents"
									: "Open session"}
							</p>
							<p className="truncate text-xs text-muted-foreground">
								{isFabricAgentsSession
									? "Jump into the live Fabric Agents session"
									: "Open the live execution session"}
							</p>
						</div>
						<ExternalLinkIcon className="size-3.5 text-muted-foreground" />
					</a>
				)}

				{hasPR && pullRequestUrl && (
					<a
						href={pullRequestUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="flex min-h-14 items-center gap-3 rounded-xl border border-border/60 bg-background px-4 py-3 text-sm transition-colors hover:bg-muted/40"
					>
						<div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
							<GitPullRequestIcon className="size-4 text-primary" />
						</div>
						<div className="min-w-0 flex-1">
							<p className="font-medium text-foreground">
								{pullRequestNumber
									? `Pull Request #${pullRequestNumber}`
									: "Pull Request"}
							</p>
							<p className="truncate text-xs text-muted-foreground">
								Open the generated pull request
							</p>
						</div>
						<ExternalLinkIcon className="size-3.5 text-muted-foreground" />
					</a>
				)}
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				<MetadataTile
					icon={GitBranchIcon}
					label="Worktree & branch"
					value={activeBranch || "Unknown"}
					hint={
						worktreePath
							? worktreePath
							: run.repositoryOwner && run.repositoryName
								? `${run.repositoryOwner}/${run.repositoryName}`
								: "Repository context"
					}
				/>
				<MetadataTile
					icon={CodeIcon}
					label="Provider session"
					value={run.providerSessionId || "Pending"}
					hint={
						connectionLabel
							? `${getExecutionProviderLabel(run.provider)} · ${connectionLabel}`
							: "Runtime session identifier"
					}
				/>
			</div>

			{run.events && run.events.length > 0 && (
				<div className="space-y-2">
					<p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
						Activity
					</p>
					<div className="max-h-[260px] divide-y divide-border/40 overflow-y-auto rounded-2xl border border-border/60 bg-background">
						{collapseEvents(run.events).map(
							(event, index, events) => {
								const detail = formatEventPayloadDetail(
									event.payload,
								);
								return (
									<div
										key={event.id}
										className="flex items-start gap-3 px-4 py-3 text-xs"
									>
										<div className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
											{index === events.length - 1 &&
											isActive ? (
												<Loader2Icon className="size-3 animate-spin text-primary" />
											) : (
												<EventIcon
													eventType={event.eventType}
													className="size-3 text-muted-foreground"
												/>
											)}
										</div>
										<div className="min-w-0 flex-1">
											<span className="text-foreground/80">
												{formatEventType(
													event.eventType,
												)}
												{event.count > 1 && (
													<span className="ml-1 text-muted-foreground/50">
														({event.count}x)
													</span>
												)}
											</span>
											{detail && (
												<p className="mt-0.5 break-words text-[11px] text-muted-foreground">
													{detail}
												</p>
											)}
										</div>
										<span className="shrink-0 tabular-nums text-muted-foreground/60">
											{new Date(
												event.createdAt,
											).toLocaleTimeString([], {
												hour: "2-digit",
												minute: "2-digit",
											})}
										</span>
									</div>
								);
							},
						)}
					</div>
				</div>
			)}

			{isActive && onCancel && (
				<Button
					variant="outline"
					size="sm"
					type="button"
					autoLoading={false}
					className="w-full rounded-xl"
					onClick={onCancel}
				>
					<SquareIcon className="mr-2 size-3.5" />
					Cancel Session
				</Button>
			)}

			{isCompleted && run.pullRequestUrl && (
				<Button
					variant="outline"
					size="sm"
					className="w-full rounded-xl"
					asChild
				>
					<a
						href={run.pullRequestUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						<GitPullRequestIcon className="mr-2 size-3.5" />
						View Pull Request
					</a>
				</Button>
			)}
		</div>
	);
}

function MetadataTile({
	icon: Icon,
	label,
	value,
	hint,
}: {
	icon: typeof WorkflowIcon;
	label: string;
	value: string;
	hint?: string;
}) {
	return (
		<div className="rounded-xl border border-border/60 bg-background px-4 py-3">
			<div className="flex items-start gap-3">
				<div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
					<Icon className="size-4" />
				</div>
				<div className="min-w-0 flex-1">
					<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
						{label}
					</p>
					<p className="mt-1 break-words text-sm font-medium text-foreground">
						{value}
					</p>
					{hint && (
						<p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
							{hint}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

type ProgressStepState = "pending" | "active" | "completed" | "failed";

function computeExecutionProgressSteps(input: {
	status: string;
	hasSession: boolean;
	hasPR: boolean;
	isSpike: boolean;
}): Array<{ key: string; label: string; state: ProgressStepState }> {
	const isFailed =
		input.status === "FAILED" ||
		input.status === "CANCELLED" ||
		input.status === "TERMINATED_STALE";
	const isDone =
		input.status === "COMPLETED" || input.status === "DEMO_READY";

	const step1: ProgressStepState =
		input.hasSession || isDone
			? "completed"
			: isFailed
				? "failed"
				: "active";

	const step2: ProgressStepState =
		input.hasPR || isDone
			? "completed"
			: isFailed && input.hasSession
				? "failed"
				: input.hasSession &&
						(input.status === "RUNNING" ||
							input.status === "AWAITING_REVIEW")
					? "active"
					: "pending";

	const step3: ProgressStepState = input.isSpike
		? isDone
			? "completed"
			: "pending"
		: input.hasPR
			? "completed"
			: "pending";

	const step4: ProgressStepState = isDone
		? "completed"
		: isFailed
			? "failed"
			: input.status === "PR_OPENED"
				? "active"
				: "pending";

	return [
		{ key: "worktree", label: "1. Worktree & session", state: step1 },
		{ key: "implement", label: "2. Implementing task", state: step2 },
		{
			key: "deliverable",
			label: input.isSpike ? "3. Spike branch" : "3. Pull request",
			state: step3,
		},
		{ key: "complete", label: "4. Completed", state: step4 },
	];
}

function StatusIcon({ status }: { status: string }) {
	switch (status) {
		case "QUEUED":
		case "STARTING":
		case "RUNNING":
			return <Loader2Icon className="size-4 animate-spin text-primary" />;
		case "AWAITING_REVIEW":
			return <MessagesSquareIcon className="size-4 text-highlight" />;
		case "PR_OPENED":
			return <GitPullRequestIcon className="size-4 text-primary" />;
		case "DEMO_READY":
			return <FlaskConicalIcon className="size-4 text-secondary" />;
		case "COMPLETED":
			return <CheckCircleIcon className="size-4 text-success" />;
		case "FAILED":
			return <CircleXIcon className="size-4 text-destructive" />;
		case "CANCELLED":
			return <CircleXIcon className="size-4 text-muted-foreground" />;
		default:
			return <ClockIcon className="size-4 text-muted-foreground" />;
	}
}

function formatStatus(status: string): string {
	switch (status) {
		case "QUEUED":
			return "Queued";
		case "STARTING":
			return "Starting agent...";
		case "RUNNING":
			return "Agent is working...";
		case "AWAITING_REVIEW":
			return "Awaiting review";
		case "PR_OPENED":
			return "Pull request opened";
		case "DEMO_READY":
			return "Demo ready — try it and accept or discard";
		case "COMPLETED":
			return "Completed";
		case "FAILED":
			return "Failed";
		case "CANCELLED":
			return "Cancelled";
		default:
			return status;
	}
}

const EVENT_LABELS: Record<string, string> = {
	workflow_started: "Run started",
	prompt_built: "Implementation prompt prepared",
	session_created: "Agent session created",
	prompt_sent: "Prompt sent to agent",
	poll_status: "Checked agent status",
	poll_error: "Status check failed",
	review_required: "Agent paused — awaiting your input",
	pr_opened: "Pull request opened",
	spike_artifacts_synced: "Spike demo and findings synced",
	spike_demo_ready: "Spike demo ready",
	spike_accepted: "Spike findings accepted",
	spike_discarded: "Spike discarded",
	workflow_completed: "Run completed",
	workflow_failed: "Run failed",
	workflow_error: "Run encountered an error",
	workflow_cancelled: "Run cancelled",
	spike_sync_failed: "Spike artifact sync failed",
	fallback_poll_error: "Status check failed",
	follow_up_sent: "Follow-up message sent",
};

function formatEventType(eventType: string): string {
	return EVENT_LABELS[eventType] ?? eventType.replace(/_/g, " ");
}

function asPayloadRecord(
	payload: unknown,
): Record<string, unknown> | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return undefined;
	}
	return payload as Record<string, unknown>;
}

function extractRunFailureReason(
	events: EventEntry[] | undefined,
	liveError?: string | null,
	metadata?: Record<string, unknown> | null,
): string | null {
	if (typeof liveError === "string" && liveError.trim()) {
		return liveError.trim();
	}
	if (typeof metadata?.lastError === "string" && metadata.lastError.trim()) {
		return metadata.lastError.trim();
	}
	if (typeof metadata?.error === "string" && metadata.error.trim()) {
		return metadata.error.trim();
	}
	if (!Array.isArray(events)) {
		return null;
	}
	for (let i = events.length - 1; i >= 0; i--) {
		const evt = events[i];
		if (!evt || evt.eventType === "fallback_poll_error") {
			continue;
		}
		const payload = asPayloadRecord(evt.payload);
		const err = payload?.error;
		if (typeof err === "string" && err.trim()) {
			return err.trim();
		}
	}
	return null;
}

function formatEventPayloadDetail(payload: unknown): string | null {
	const rec = asPayloadRecord(payload);
	if (!rec) {
		return null;
	}
	if (typeof rec.error === "string" && rec.error.trim()) {
		return rec.error.trim();
	}
	if (typeof rec.pullRequestUrl === "string" && rec.pullRequestUrl.trim()) {
		return rec.pullRequestUrl.trim();
	}
	if (typeof rec.branchName === "string" && rec.branchName.trim()) {
		return `Branch: ${rec.branchName.trim()}`;
	}
	return null;
}

function EventIcon({
	eventType,
	className,
}: {
	eventType: string;
	className?: string;
}) {
	switch (eventType) {
		case "workflow_started":
			return <PlayIcon className={className} />;
		case "prompt_built":
		case "prompt_sent":
			return <SendIcon className={className} />;
		case "session_created":
			return <MonitorIcon className={className} />;
		case "poll_status":
			return <ClockIcon className={className} />;
		case "review_required":
			return <MessagesSquareIcon className={className} />;
		case "poll_error":
		case "workflow_error":
			return <AlertTriangleIcon className={className} />;
		case "pr_opened":
			return <GitPullRequestIcon className={className} />;
		case "workflow_completed":
			return <CheckCircleIcon className={className} />;
		case "workflow_failed":
		case "workflow_cancelled":
			return <CircleXIcon className={className} />;
		default:
			return <CodeIcon className={className} />;
	}
}

type EventEntry = {
	id: string;
	eventType: string;
	payload?: unknown;
	createdAt: string | Date;
};

type CollapsedEvent = EventEntry & { count: number };

function collapseEvents(events: EventEntry[]): CollapsedEvent[] {
	const result: CollapsedEvent[] = [];
	for (const event of events) {
		const last = result[result.length - 1];
		if (
			last &&
			event.eventType === "poll_status" &&
			last.eventType === "poll_status"
		) {
			last.count += 1;
			last.createdAt = event.createdAt;
		} else {
			result.push({ ...event, count: 1 });
		}
	}
	return result;
}
