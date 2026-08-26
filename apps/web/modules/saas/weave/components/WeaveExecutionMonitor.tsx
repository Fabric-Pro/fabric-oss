"use client";

/**
 * WeaveExecutionMonitor - Real-time execution monitoring via SSE
 *
 * Connects to the weave execution SSE stream for live updates.
 * Falls back to polling if SSE is unavailable.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Progress } from "@ui/components/progress";
import { cn } from "@ui/lib";
import {
	BotIcon,
	CheckCircleIcon,
	CircleIcon,
	ClockIcon,
	ExternalLinkIcon,
	FastForwardIcon,
	ListTodoIcon,
	Loader2Icon,
	MonitorIcon,
	PauseCircleIcon,
	RefreshCwIcon,
	SearchIcon,
	ShieldIcon,
	TerminalIcon,
	XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	getExecutionChannelLabel,
	getExecutionProviderLabel,
} from "../../projects/lib/implementation-session-labels";
import { CheckpointReviewModal } from "./CheckpointReviewModal";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { WeaveExecutionSummary } from "./WeaveExecutionSummary";

interface WeaveExecutionMonitorProps {
	projectId: string;
	storyId?: string;
	executionId?: string;
}

interface ExecutionStep {
	id: string;
	text: string;
	agent: string;
	status: "pending" | "in_progress" | "completed" | "failed";
	requiresReview?: boolean;
	reviewType?: string;
}

interface CheckpointData {
	approvalId: string;
	stepId?: string;
	checkboxText?: string;
	agent?: string;
	reviewType?: string;
	result?: unknown;
	data?: unknown;
}

interface ExecutionStatus {
	id: string;
	workflowId: string;
	runId: string;
	status: string;
	currentStep: number;
	totalSteps: number;
	currentAgent?: string;
	checkboxes: ExecutionStep[] | null;
	sandboxSessionId?: string | null;
	artifacts?: unknown | null;
	error?: string | null;
	startedAt?: string | Date | null;
	completedAt?: string | Date | null;
	plan?: {
		checkboxes: ExecutionStep[];
	};
	workflowStatus?: {
		status: string;
		currentStep: number;
		totalSteps: number;
		currentAgent?: string;
	};
	checkpoint?: CheckpointData | null;
	implementationSession?: {
		id: string;
		status: string;
		executionChannel: string;
		provider: string;
		providerSessionId?: string | null;
		providerMetadata?: unknown;
		externalUrl?: string | null;
		externalStatus?: string | null;
		workingDirectory?: string | null;
		targetBranch?: string | null;
		pullRequestUrl?: string | null;
		repositoryOwner?: string | null;
		repositoryName?: string | null;
		createdAt: string;
	} | null;
}

function normalizeExecutionSteps(value: unknown): ExecutionStep[] | null {
	if (!Array.isArray(value)) {
		return null;
	}

	return value
		.filter(
			(step): step is Record<string, unknown> =>
				typeof step === "object" && step !== null,
		)
		.map((step, index) => ({
			id: typeof step.id === "string" ? step.id : String(index),
			text: typeof step.text === "string" ? step.text : "",
			agent: typeof step.agent === "string" ? step.agent : "",
			status:
				step.status === "in_progress" ||
				step.status === "completed" ||
				step.status === "failed"
					? step.status
					: "pending",
			requiresReview:
				typeof step.requiresReview === "boolean"
					? step.requiresReview
					: undefined,
			reviewType:
				typeof step.reviewType === "string"
					? step.reviewType
					: undefined,
		}));
}

const AGENT_ICONS: Record<string, React.ReactNode> = {
	loom: <BotIcon className="size-4" />,
	tapestry: <TerminalIcon className="size-4" />,
	thread: <TerminalIcon className="size-4" />,
	spindle: <SearchIcon className="size-4" />,
	weft: <CheckCircleIcon className="size-4" />,
	warp: <ShieldIcon className="size-4" />,
	shuttle: <TerminalIcon className="size-4" />,
};

interface LogEntry {
	timestamp: number;
	message: string;
	type: "info" | "agent" | "tool" | "error" | "checkpoint";
}

export function WeaveExecutionMonitor({
	projectId: _projectId,
	storyId: _storyId,
	executionId: initialExecutionId,
}: WeaveExecutionMonitorProps) {
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const [selectedExecutionId, setSelectedExecutionId] = useState<
		string | undefined
	>(initialExecutionId);
	const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
	const [isCheckpointModalOpen, setIsCheckpointModalOpen] = useState(false);
	const [streamConnected, setStreamConnected] = useState(false);
	const [sseProgress, setSseProgress] = useState<Record<
		string,
		unknown
	> | null>(null);
	const eventSourceRef = useRef<EventSource | null>(null);
	const logScrollRef = useRef<HTMLDivElement>(null);

	const addLog = useCallback(
		(message: string, type: LogEntry["type"] = "info") => {
			setLiveLogs((prev) => {
				const entry: LogEntry = {
					timestamp: Date.now(),
					message,
					type,
				};
				const next = [...prev, entry];
				return next.length > 200 ? next.slice(-200) : next;
			});
		},
		[],
	);

	// Sync executionId prop with local state when it changes
	useEffect(() => {
		if (initialExecutionId !== selectedExecutionId) {
			setSelectedExecutionId(initialExecutionId);
			setLiveLogs([]);
			setSseProgress(null);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the prop changes, not when local state catches up
	}, [initialExecutionId]);

	// SSE stream connection
	useEffect(() => {
		if (!selectedExecutionId) {
			return;
		}

		const orgParam = organizationId
			? `&organizationId=${encodeURIComponent(organizationId)}`
			: "";
		const url = `/api/weave/stream?executionId=${encodeURIComponent(selectedExecutionId)}${orgParam}`;
		const es = new EventSource(url);
		eventSourceRef.current = es;

		es.addEventListener("weave.connected", (_e) => {
			setStreamConnected(true);
			addLog("Connected to execution stream", "info");
		});

		es.addEventListener("weave.progress", (e) => {
			try {
				const data = JSON.parse(e.data);
				setSseProgress(data);

				if (data.currentAgent) {
					addLog(`Agent active: ${data.currentAgent}`, "agent");
				}

				if (data.checkpoint) {
					addLog(
						"Checkpoint reached â€” awaiting approval",
						"checkpoint",
					);
				}
			} catch {
				// Invalid data
			}
		});

		es.addEventListener("weave.tool_start", (e) => {
			try {
				const data = JSON.parse(e.data);
				const toolCall = data.toolCall as
					| { name?: string; serverName?: string }
					| undefined;
				if (toolCall?.name) {
					addLog(
						`Tool call: ${toolCall.name}${toolCall.serverName ? ` (${toolCall.serverName})` : ""}`,
						"tool",
					);
				}
			} catch {
				// Ignore
			}
		});

		es.addEventListener("weave.tool_call_completed", (e) => {
			try {
				const data = JSON.parse(e.data);
				if (data.toolName) {
					addLog(
						`Tool completed: ${data.toolName} [${data.status || "ok"}]`,
						"tool",
					);
				}
			} catch {
				// Ignore
			}
		});

		es.addEventListener("weave.step_started", (e) => {
			try {
				const data = JSON.parse(e.data);
				if (data.stepDescription || data.description) {
					addLog(
						`Step started: ${data.stepDescription || data.description}`,
						"info",
					);
				}
			} catch {
				// Ignore
			}
		});

		es.addEventListener("weave.step_completed", (e) => {
			try {
				const data = JSON.parse(e.data);
				if (data.stepDescription || data.description) {
					addLog(
						`Step completed: ${data.stepDescription || data.description}`,
						"info",
					);
				}
			} catch {
				// Ignore
			}
		});

		es.addEventListener("weave.completed", () => {
			addLog("Execution completed successfully", "info");
			es.close();
			setStreamConnected(false);
		});

		es.addEventListener("weave.failed", (e) => {
			try {
				const data = JSON.parse(e.data);
				addLog(
					`Execution failed: ${data.error || "Unknown error"}`,
					"error",
				);
			} catch {
				addLog("Execution failed", "error");
			}
			es.close();
			setStreamConnected(false);
		});

		es.addEventListener("weave.cancelled", () => {
			addLog("Execution cancelled", "info");
			es.close();
			setStreamConnected(false);
		});

		es.addEventListener("weave.timeout", () => {
			addLog("Stream timeout â€” switch to polling", "info");
			es.close();
			setStreamConnected(false);
		});

		es.onerror = () => {
			setStreamConnected(false);
		};

		return () => {
			es.close();
			eventSourceRef.current = null;
			setStreamConnected(false);
		};
	}, [selectedExecutionId, addLog]);

	// Auto-scroll logs
	useEffect(() => {
		if (logScrollRef.current) {
			logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
		}
	}, [liveLogs]);

	// Fetch execution status (polling fallback when SSE not connected)
	const { data: execution, isLoading } = useQuery<ExecutionStatus | null>({
		queryKey: ["weave-execution", selectedExecutionId],
		queryFn: async () => {
			if (!selectedExecutionId) {
				return null;
			}
			const result = await orpcClient.weave.executions.get({
				executionId: selectedExecutionId,
				organizationId: organizationId ?? null,
			});
			const normalizedCheckboxes =
				normalizeExecutionSteps(result.checkboxes) ??
				normalizeExecutionSteps(result.plan?.checkboxes);
			const workflowStatus =
				result.workflowStatus &&
				typeof result.workflowStatus === "object"
					? (result.workflowStatus as unknown as Record<
							string,
							unknown
						>)
					: null;

			return {
				id: result.id,
				workflowId: result.workflowId,
				runId: result.runId,
				status:
					typeof workflowStatus?.status === "string"
						? workflowStatus.status
						: result.status,
				currentStep: Number(
					(typeof workflowStatus?.currentStep === "number"
						? workflowStatus.currentStep
						: result.currentStep) ?? 0,
				),
				totalSteps: Number(
					(typeof workflowStatus?.totalSteps === "number"
						? workflowStatus.totalSteps
						: normalizedCheckboxes?.length) ?? 0,
				),
				currentAgent:
					typeof workflowStatus?.currentAgent === "string"
						? workflowStatus.currentAgent
						: undefined,
				checkboxes: normalizedCheckboxes,
				sandboxSessionId: result.sandboxSessionId ?? null,
				artifacts: result.artifacts ?? null,
				error: result.error ?? null,
				plan: result.plan
					? { checkboxes: normalizedCheckboxes ?? [] }
					: undefined,
				workflowStatus: workflowStatus
					? {
							status:
								typeof workflowStatus.status === "string"
									? workflowStatus.status
									: result.status,
							currentStep: Number(
								workflowStatus.currentStep ?? 0,
							),
							totalSteps: Number(
								workflowStatus.totalSteps ??
									normalizedCheckboxes?.length ??
									0,
							),
							currentAgent:
								typeof workflowStatus.currentAgent === "string"
									? workflowStatus.currentAgent
									: undefined,
						}
					: undefined,
				implementationSession: result.implementationSession
					? {
							id: result.implementationSession.id,
							status: result.implementationSession.status,
							executionChannel:
								result.implementationSession.executionChannel,
							provider: result.implementationSession.provider,
							providerSessionId:
								result.implementationSession
									.providerSessionId ?? null,
							providerMetadata:
								result.implementationSession.providerMetadata ??
								null,
							externalUrl:
								result.implementationSession.externalUrl ??
								null,
							externalStatus:
								result.implementationSession.externalStatus ??
								null,
							workingDirectory:
								result.implementationSession.workingDirectory ??
								null,
							targetBranch:
								result.implementationSession.targetBranch ??
								null,
							pullRequestUrl:
								result.implementationSession.pullRequestUrl ??
								null,
							repositoryOwner:
								result.implementationSession.repositoryOwner ??
								null,
							repositoryName:
								result.implementationSession.repositoryName ??
								null,
							createdAt: new Date(
								result.implementationSession.createdAt,
							).toISOString(),
						}
					: null,
				checkpoint: result.checkpoint
					? (() => {
							const checkpoint =
								result.checkpoint as unknown as Record<
									string,
									unknown
								> & {
									approvalId: string;
									stepId?: string;
								};
							return {
								approvalId: String(checkpoint.approvalId),
								stepId:
									checkpoint.stepId != null
										? String(checkpoint.stepId)
										: undefined,
								checkboxText:
									checkpoint.checkboxText != null
										? String(checkpoint.checkboxText)
										: undefined,
								agent:
									checkpoint.agent != null
										? String(checkpoint.agent)
										: undefined,
								reviewType:
									checkpoint.reviewType != null
										? String(checkpoint.reviewType)
										: undefined,
								result: checkpoint.result,
								data: checkpoint.data,
							};
						})()
					: null,
			};
		},
		enabled: !!selectedExecutionId,
		refetchInterval: () => {
			// Use slower polling when SSE is connected
			if (streamConnected) {
				return 10000;
			}
			return 3000;
		},
	});

	// Merge SSE progress into execution data
	const mergedExecution = execution
		? {
				...execution,
				status:
					typeof sseProgress?.status === "string"
						? (sseProgress.status as string)
						: execution.status,
				currentAgent:
					typeof sseProgress?.currentAgent === "string"
						? (sseProgress.currentAgent as string)
						: execution.currentAgent,
				currentStep:
					typeof sseProgress?.currentStep === "number"
						? (sseProgress.currentStep as number)
						: execution.currentStep,
				checkboxes: sseProgress?.checkboxes
					? (normalizeExecutionSteps(sseProgress.checkboxes) ??
						execution.checkboxes)
					: execution.checkboxes,
				checkpoint: sseProgress?.checkpoint
					? (sseProgress.checkpoint as CheckpointData)
					: execution.checkpoint,
			}
		: null;

	const [isAutoApproveActive, setIsAutoApproveActive] = useState(false);

	const autoApproveAllMutation = useMutation({
		mutationFn: async () => {
			if (!selectedExecutionId) {
				throw new Error("No execution selected");
			}
			return await orpcClient.weave.executions.autoApproveAll({
				executionId: selectedExecutionId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			setIsAutoApproveActive(true);
			toast.success(
				"Auto-approve enabled â€” all checkpoints will be approved automatically",
			);
			queryClient.invalidateQueries({
				queryKey: ["weave-execution", selectedExecutionId],
			});
		},
		onError: (error) => {
			toast.error(`Failed to enable auto-approve: ${error.message}`);
		},
	});

	const retryFromStepMutation = useMutation({
		mutationFn: async (stepId: string) => {
			if (!selectedExecutionId) {
				throw new Error("No execution selected");
			}
			return await orpcClient.weave.executions.retryFromStep({
				executionId: selectedExecutionId,
				stepId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success(
				"Retry signal sent â€” execution will resume from the failed step",
			);
			queryClient.invalidateQueries({
				queryKey: ["weave-execution", selectedExecutionId],
			});
		},
		onError: (error) => {
			toast.error(`Failed to retry: ${error.message}`);
		},
	});

	const revokeAutoApproveMutation = useMutation({
		mutationFn: async () => {
			if (!selectedExecutionId) {
				throw new Error("No execution selected");
			}
			return await orpcClient.weave.executions.revokeAutoApprove({
				executionId: selectedExecutionId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			setIsAutoApproveActive(false);
			toast.success(
				"Auto-approve revoked â€” future checkpoints will require human review",
			);
			queryClient.invalidateQueries({
				queryKey: ["weave-execution", selectedExecutionId],
			});
		},
		onError: (error) => {
			toast.error(`Failed to revoke auto-approve: ${error.message}`);
		},
	});

	const cancelExecutionMutation = useMutation({
		mutationFn: async () => {
			if (!selectedExecutionId) {
				throw new Error("No execution selected");
			}
			return await orpcClient.weave.executions.cancel({
				executionId: selectedExecutionId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success("Execution cancelled");
			queryClient.invalidateQueries({
				queryKey: ["weave-execution", selectedExecutionId],
			});
			// The plan is restored to APPROVED on cancel â€” refresh the list.
			queryClient.invalidateQueries({ queryKey: ["weave-plans"] });
		},
		onError: (error) => {
			toast.error(`Failed to cancel execution: ${error.message}`);
		},
	});

	if (!selectedExecutionId) {
		return (
			<div className="flex flex-col items-center justify-center h-full py-12 text-center">
				<TerminalIcon className="size-12 text-muted-foreground mb-4" />
				<h3 className="text-lg font-medium mb-2">
					No Execution Selected
				</h3>
				<p className="text-sm text-muted-foreground max-w-sm">
					Select an execution from the Plans tab or start a new plan
					to monitor agent activity in real-time.
				</p>
			</div>
		);
	}

	if (isLoading && !mergedExecution) {
		return (
			<div className="flex items-center justify-center h-full">
				<Loader2Icon className="size-8 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!mergedExecution) {
		return (
			<div className="flex flex-col items-center justify-center h-full py-12 text-center">
				<XCircleIcon className="size-12 text-destructive mb-4" />
				<h3 className="text-lg font-medium mb-2">
					Execution Not Found
				</h3>
				<p className="text-sm text-muted-foreground">
					The selected execution could not be loaded.
				</p>
			</div>
		);
	}

	const rawCheckboxes =
		mergedExecution.checkboxes ?? mergedExecution.plan?.checkboxes ?? [];
	const checkboxes: ExecutionStep[] = Array.isArray(rawCheckboxes)
		? (rawCheckboxes as ExecutionStep[])
		: [];
	const progress =
		checkboxes.length > 0
			? (checkboxes.filter((c) => c.status === "completed").length /
					checkboxes.length) *
				100
			: 0;

	const isRunning =
		mergedExecution.status === "RUNNING" ||
		mergedExecution.status === "CHECKPOINT";
	const isCheckpoint = mergedExecution.status === "CHECKPOINT";
	const isCancellable =
		mergedExecution.status === "RUNNING" ||
		mergedExecution.status === "PAUSED" ||
		mergedExecution.status === "CHECKPOINT";
	const isFailedLike =
		mergedExecution.status === "FAILED" ||
		mergedExecution.status === "TERMINATED_STALE";
	const runtimeLinkTitle =
		mergedExecution.implementationSession?.provider === "BACKGROUND_AGENTS"
			? "Open Background Agents session"
			: mergedExecution.implementationSession?.provider === "KANBAN_LOCAL"
				? "Open Fabric Kanban"
				: "Open implementation runtime";
	const runtimeLinkUnavailableTitle =
		mergedExecution.implementationSession?.provider === "KANBAN_LOCAL"
			? "Fabric Kanban"
			: mergedExecution.implementationSession?.provider ===
					"BACKGROUND_AGENTS"
				? "Background Agents"
				: "Implementation runtime";

	return (
		<div className="flex flex-col overflow-hidden space-y-4 max-h-[calc(85vh-12rem)]">
			{/* Status Header */}
			<Card className="p-4 shrink-0">
				<div className="flex items-center justify-between mb-4">
					<div className="flex items-center gap-3">
						<div
							className={cn(
								"size-10 rounded-full flex items-center justify-center",
								mergedExecution.status === "COMPLETED" &&
									"bg-secondary/10 text-secondary",
								isFailedLike &&
									"bg-destructive/10 text-destructive",
								isRunning &&
									"bg-primary/10 text-primary animate-pulse",
								isCheckpoint &&
									"bg-highlight/10 text-highlight",
							)}
						>
							{isRunning ? (
								<Loader2Icon className="size-5 animate-spin" />
							) : mergedExecution.status === "COMPLETED" ? (
								<CheckCircleIcon className="size-5" />
							) : isFailedLike ? (
								<XCircleIcon className="size-5" />
							) : (
								<ClockIcon className="size-5" />
							)}
						</div>
						<div>
							<h3 className="font-semibold">
								Execution #{mergedExecution.id.slice(-6)}
							</h3>
							<div className="flex items-center gap-2 text-sm text-muted-foreground">
								<Badge
									variant="outline"
									className={cn(
										mergedExecution.status ===
											"COMPLETED" &&
											"border-secondary text-secondary",
										isFailedLike &&
											"border-destructive text-destructive",
										isRunning &&
											"border-primary text-primary",
										isCheckpoint &&
											"border-highlight text-highlight",
									)}
								>
									{mergedExecution.status}
								</Badge>
								{mergedExecution.currentAgent && (
									<span>
										Agent: {mergedExecution.currentAgent}
									</span>
								)}
								{streamConnected && (
									<span className="flex items-center gap-1 text-xs text-secondary">
										<span className="size-1.5 rounded-full bg-secondary animate-pulse" />
										Live
									</span>
								)}
							</div>
						</div>
					</div>

					{isCancellable && (
						<div className="flex items-center gap-2">
							{isCheckpoint && (
								<Button
									variant="outline"
									className="gap-2"
									onClick={() =>
										setIsCheckpointModalOpen(true)
									}
								>
									<PauseCircleIcon className="size-4" />
									Review
								</Button>
							)}
							{(isCheckpoint ||
								(isRunning && isAutoApproveActive)) &&
								(isAutoApproveActive ? (
									<Button
										variant="outline"
										className="gap-2"
										onClick={() =>
											revokeAutoApproveMutation.mutate()
										}
										disabled={
											revokeAutoApproveMutation.isPending
										}
									>
										{revokeAutoApproveMutation.isPending ? (
											<Loader2Icon className="size-4 animate-spin" />
										) : (
											<ShieldIcon className="size-4" />
										)}
										Restore Review
									</Button>
								) : (
									<AlertDialog>
										<AlertDialogTrigger asChild>
											<Button
												className="gap-2"
												variant="outline"
												disabled={
													autoApproveAllMutation.isPending
												}
											>
												{autoApproveAllMutation.isPending ? (
													<Loader2Icon className="size-4 animate-spin" />
												) : (
													<FastForwardIcon className="size-4" />
												)}
												Approve All
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													Auto-approve all
													checkpoints?
												</AlertDialogTitle>
												<AlertDialogDescription>
													This will automatically
													approve the current
													checkpoint and all future
													checkpoints in this
													execution. High-risk steps
													will no longer pause for
													review. You can revoke this
													at any time.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>
													Cancel
												</AlertDialogCancel>
												<AlertDialogAction
													onClick={() =>
														autoApproveAllMutation.mutate()
													}
												>
													Approve All
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								))}
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button
										variant="outline"
										className="gap-2 text-destructive hover:text-destructive"
										disabled={
											cancelExecutionMutation.isPending
										}
									>
										{cancelExecutionMutation.isPending ? (
											<Loader2Icon className="size-4 animate-spin" />
										) : (
											<XCircleIcon className="size-4" />
										)}
										Cancel run
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>
											Cancel this run?
										</AlertDialogTitle>
										<AlertDialogDescription>
											This stops the agents and ends the
											execution. The plan returns to
											Approved so you can run it again.
											This cannot be undone.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>
											Keep running
										</AlertDialogCancel>
										<AlertDialogAction
											variant="destructive"
											onClick={() =>
												cancelExecutionMutation.mutate()
											}
										>
											Cancel run
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</div>
					)}
				</div>

				<div className="space-y-2">
					<div className="flex items-center justify-between text-sm">
						<span className="text-muted-foreground">Progress</span>
						<span>
							{
								checkboxes.filter(
									(c) => c.status === "completed",
								).length
							}{" "}
							/ {checkboxes.length} steps
						</span>
					</div>
					<Progress value={progress} className="h-2" />
				</div>

				{/* Execution Timeline */}
				{checkboxes.length > 0 &&
					checkboxes.some(
						(c) =>
							c.status === "completed" ||
							c.status === "in_progress",
					) && (
						<ExecutionTimeline
							steps={checkboxes}
							executionStartedAt={mergedExecution.startedAt}
						/>
					)}

				{/* Completion Summary */}
				{(mergedExecution.status === "COMPLETED" ||
					mergedExecution.status === "FAILED" ||
					mergedExecution.status === "CANCELLED" ||
					mergedExecution.status === "TERMINATED_STALE") && (
					<WeaveExecutionSummary
						status={
							mergedExecution.status as
								| "COMPLETED"
								| "FAILED"
								| "CANCELLED"
								| "TERMINATED_STALE"
						}
						artifacts={mergedExecution.artifacts}
						startedAt={mergedExecution.startedAt}
						completedAt={mergedExecution.completedAt}
						stepsCompleted={
							checkboxes.filter((c) => c.status === "completed")
								.length
						}
						stepsTotal={checkboxes.length}
						error={mergedExecution.error}
						implementationSession={
							mergedExecution.implementationSession
						}
					/>
				)}

				{mergedExecution.implementationSession && (
					<div className="mt-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-3">
						<div className="flex items-start justify-between gap-3">
							<div>
								<p className="font-medium text-sm text-foreground">
									Implementation Session Handoff
								</p>
								<p className="text-xs text-muted-foreground mt-0.5">
									Weave handed implementation off for{" "}
									{getExecutionChannelLabel(
										mergedExecution.implementationSession
											.executionChannel,
									).toLowerCase()}{" "}
									through{" "}
									{getExecutionProviderLabel(
										mergedExecution.implementationSession
											.provider,
									)}
									.
								</p>
							</div>
							<Badge variant="outline">
								{mergedExecution.implementationSession.status}
							</Badge>
						</div>
						<div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
							<Badge variant="secondary">
								{getExecutionChannelLabel(
									mergedExecution.implementationSession
										.executionChannel,
								)}
							</Badge>
							<Badge variant="secondary">
								{getExecutionProviderLabel(
									mergedExecution.implementationSession
										.provider,
								)}
							</Badge>
							{mergedExecution.implementationSession
								.externalStatus && (
								<Badge variant="outline">
									Runtime:{" "}
									{
										mergedExecution.implementationSession
											.externalStatus
									}
								</Badge>
							)}
							{mergedExecution.implementationSession
								.targetBranch && (
								<Badge variant="outline">
									Branch:{" "}
									{
										mergedExecution.implementationSession
											.targetBranch
									}
								</Badge>
							)}
							{mergedExecution.implementationSession
								.workingDirectory && (
								<Badge variant="outline">
									Repo root:{" "}
									{
										mergedExecution.implementationSession
											.workingDirectory
									}
								</Badge>
							)}
						</div>
						<div className="mt-3 flex flex-wrap gap-2">
							{mergedExecution.implementationSession
								.externalUrl && (
								<a
									href={
										mergedExecution.implementationSession
											.externalUrl
									}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
								>
									Open runtime
									<ExternalLinkIcon className="size-3" />
								</a>
							)}
							{mergedExecution.implementationSession
								.pullRequestUrl && (
								<a
									href={
										mergedExecution.implementationSession
											.pullRequestUrl
									}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
								>
									Open pull request
									<ExternalLinkIcon className="size-3" />
								</a>
							)}
						</div>
					</div>
				)}

				{/* Coding Session Link */}
				{mergedExecution.sandboxSessionId &&
					(process.env.NEXT_PUBLIC_BACKGROUND_AGENTS_URL ? (
						<a
							href={`${process.env.NEXT_PUBLIC_BACKGROUND_AGENTS_URL}/session/${mergedExecution.sandboxSessionId}`}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-3 mt-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-sm transition-colors hover:bg-muted/50"
						>
							<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
								<MonitorIcon className="size-4 text-primary" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="font-medium text-foreground text-sm">
									{runtimeLinkTitle}
								</p>
								<p className="truncate text-xs text-muted-foreground">
									Open the live implementation session
								</p>
							</div>
							<ExternalLinkIcon className="size-3.5 text-muted-foreground" />
						</a>
					) : (
						<div className="flex items-center gap-3 mt-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-sm">
							<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
								<MonitorIcon className="size-4 text-muted-foreground" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="font-medium text-muted-foreground text-sm">
									{runtimeLinkUnavailableTitle}
								</p>
								<p className="truncate text-xs text-muted-foreground">
									Link unavailable for this Weave execution
								</p>
							</div>
						</div>
					))}
			</Card>

			{/* Agent Grid */}
			<div className="grid grid-cols-2 gap-2 shrink-0">
				{[
					{ id: "loom", name: "Loom", role: "Orchestrator" },
					{ id: "thread", name: "Thread", role: "Code Analysis" },
					{ id: "spindle", name: "Spindle", role: "Research" },
					{ id: "shuttle", name: "Shuttle", role: "Implementation" },
					{ id: "weft", name: "Weft", role: "Quality Review" },
					{ id: "warp", name: "Warp", role: "Security Audit" },
				].map((agent) => {
					const isActive =
						mergedExecution.currentAgent === agent.id ||
						mergedExecution.currentAgent === `weave_${agent.id}`;
					const isCompleted =
						agent.id === "loom" ||
						checkboxes.some(
							(c) =>
								c.agent === agent.id &&
								c.status === "completed",
						);

					return (
						<div
							key={agent.id}
							className={cn(
								"flex items-center gap-2 p-2 rounded-lg border transition-colors",
								isActive &&
									"border-primary bg-primary/5 shadow-sm",
								isCompleted && !isActive && "opacity-60",
								!isActive && !isCompleted && "opacity-40",
							)}
						>
							<div
								className={cn(
									"size-8 rounded-full flex items-center justify-center text-primary-foreground",
									agent.id === "loom" && "bg-primary/80",
									agent.id === "thread" && "bg-secondary/80",
									agent.id === "spindle" && "bg-highlight/80",
									agent.id === "shuttle" && "bg-primary/60",
									agent.id === "weft" && "bg-highlight/60",
									agent.id === "warp" && "bg-destructive/80",
									isActive && "animate-pulse",
								)}
							>
								{AGENT_ICONS[agent.id]}
							</div>
							<div className="flex-1 min-w-0">
								<p className="text-sm font-medium truncate">
									{agent.name}
								</p>
								<p className="text-xs text-muted-foreground truncate">
									{agent.role}
								</p>
							</div>
							{isActive && (
								<Loader2Icon className="size-4 animate-spin text-primary" />
							)}
						</div>
					);
				})}
			</div>

			{/* Steps & Logs */}
			<div className="flex-1 grid grid-cols-2 grid-rows-[1fr] gap-4 min-h-0 overflow-hidden">
				<Card className="p-4 overflow-hidden flex flex-col min-h-0">
					<h4 className="font-medium mb-3 flex items-center gap-2 shrink-0">
						<ListTodoIcon className="size-4" />
						Execution Steps
					</h4>
					<div className="flex-1 overflow-y-auto min-h-0">
						<div className="space-y-2 pr-1">
							{checkboxes.map((step, index) => (
								<div
									key={step.id}
									className={cn(
										"flex items-start gap-2 p-2 rounded-lg text-sm",
										step.status === "completed" &&
											"bg-secondary/5",
										step.status === "in_progress" &&
											"bg-primary/5 border border-primary/20",
										step.status === "failed" &&
											"bg-destructive/5",
										index === mergedExecution.currentStep &&
											"ring-1 ring-primary",
									)}
								>
									<div className="mt-0.5">
										{step.status === "completed" ? (
											<CheckCircleIcon className="size-4 text-secondary" />
										) : step.status === "in_progress" ? (
											<Loader2Icon className="size-4 animate-spin text-primary" />
										) : step.status === "failed" ? (
											<XCircleIcon className="size-4 text-destructive" />
										) : (
											<CircleIcon className="size-4 text-muted-foreground" />
										)}
									</div>
									<div className="flex-1">
										<p
											className={cn(
												"font-medium",
												step.status === "completed" &&
													"text-muted-foreground line-through",
											)}
										>
											{step.text.slice(0, 60)}
											{step.text.length > 60 && "..."}
										</p>
										<div className="flex items-center gap-2 mt-1">
											<Badge
												variant="outline"
												className="text-xs"
											>
												{step.agent}
											</Badge>
											{step.requiresReview && (
												<Badge
													variant="outline"
													className="text-xs border-highlight text-highlight"
												>
													Review Required
												</Badge>
											)}
											{step.status === "failed" && (
												<Button
													variant="ghost"
													size="sm"
													className="h-6 px-2 text-xs text-destructive hover:text-destructive"
													disabled={
														retryFromStepMutation.isPending
													}
													onClick={() =>
														retryFromStepMutation.mutate(
															step.id,
														)
													}
												>
													<RefreshCwIcon className="mr-1 size-3" />
													Retry from here
												</Button>
											)}
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				</Card>

				<Card className="p-4 overflow-hidden flex flex-col min-h-0 bg-muted/50">
					<div className="flex items-center justify-between mb-3 shrink-0">
						<h4 className="font-medium flex items-center gap-2">
							<TerminalIcon className="size-4" />
							Status Log
						</h4>
						{streamConnected ? (
							<span className="flex items-center gap-1 text-xs text-secondary">
								<span className="size-1.5 rounded-full bg-secondary animate-pulse" />
								Streaming
							</span>
						) : (
							<span className="text-xs text-muted-foreground">
								Polling
							</span>
						)}
					</div>
					<div
						ref={logScrollRef}
						className="flex-1 overflow-y-auto min-h-0"
					>
						<div className="space-y-1 font-mono text-xs pr-1">
							{liveLogs.length > 0 ? (
								liveLogs.map((log, i) => (
									<div
										key={i}
										className={cn(
											log.type === "error" &&
												"text-destructive",
											log.type === "agent" &&
												"text-primary",
											log.type === "tool" &&
												"text-secondary",
											log.type === "checkpoint" &&
												"text-highlight",
											log.type === "info" &&
												"text-muted-foreground",
										)}
									>
										<span className="opacity-50">
											[
											{new Date(
												log.timestamp,
											).toLocaleTimeString()}
											]
										</span>{" "}
										{log.message}
									</div>
								))
							) : (
								<div className="text-muted-foreground italic">
									Waiting for execution to start...
								</div>
							)}
						</div>
					</div>
				</Card>
			</div>

			{/* Checkpoint Review Modal */}
			{mergedExecution && (
				<CheckpointReviewModal
					isOpen={isCheckpointModalOpen}
					onClose={() => setIsCheckpointModalOpen(false)}
					executionId={mergedExecution.id}
					workflowId={mergedExecution.workflowId}
					runId={mergedExecution.runId}
					checkpoint={mergedExecution.checkpoint}
				/>
			)}
		</div>
	);
}
