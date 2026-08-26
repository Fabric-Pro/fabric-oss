"use client";

import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { formatDistanceToNow } from "date-fns";
import { AlertCircle, ClipboardListIcon } from "lucide-react";

// AI Elements for consistent UI rendering
import {
	Queue,
	QueueItem,
	QueueItemContent,
	QueueItemDescription,
	QueueItemIndicator,
	QueueList,
	QueueSection,
	QueueSectionContent,
	QueueSectionLabel,
	QueueSectionTrigger,
} from "../../../../components/ai-elements/queue";

interface AgentTaskListProps {
	organizationId?: string;
	agentId?: string;
	status?: string;
}

interface OrchestratorExecutionSummary {
	id: string;
	userMessage?: string;
	routingDecision?: {
		agentName?: string;
	};
	plan?: {
		description?: string;
	};
	status?: "running" | "complete" | "error" | "cancelled";
	startedAt?: string;
	completedAt?: string;
	error?: string;
}

interface ConversationMetadata {
	mode?: string;
	executions?: OrchestratorExecutionSummary[];
}

interface HistoryItem {
	id: string;
	agentId: string;
	status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
	stage: string;
	createdAt: string;
	completedAt?: string;
	error?: string;
	source: "agent_task" | "orchestrator_execution" | "conversation";
	sourceLabel: string;
	title?: string;
}

function normalizeStatus(status: string | undefined): HistoryItem["status"] {
	switch ((status || "").toLowerCase()) {
		case "pending":
			return "PENDING";
		case "running":
		case "in_progress":
		case "executing":
		case "working":
			return "RUNNING";
		case "completed":
		case "complete":
		case "success":
			return "COMPLETED";
		case "failed":
		case "error":
			return "FAILED";
		case "cancelled":
		case "canceled":
			return "CANCELLED";
		default:
			return "COMPLETED";
	}
}

function parseConversationMetadata(
	metadata: unknown,
): ConversationMetadata | null {
	if (!metadata || typeof metadata !== "object") {
		return null;
	}

	return metadata as ConversationMetadata;
}

function toHistoryItemsFromConversation(conversation: {
	id: string;
	agentId: string;
	title: string | null;
	createdAt: string;
	updatedAt: string;
	lastMessage: string | null;
	metadata: unknown;
}): HistoryItem[] {
	const metadata = parseConversationMetadata(conversation.metadata);
	const mode = metadata?.mode;
	const executions = Array.isArray(metadata?.executions)
		? metadata.executions
		: [];

	if (executions.length > 0) {
		return executions.map((execution) => ({
			id: `${conversation.id}:${execution.id}`,
			agentId:
				execution.routingDecision?.agentName || conversation.agentId,
			status: normalizeStatus(execution.status),
			stage:
				execution.plan?.description ||
				(mode === "orchestrator"
					? "Orchestrator execution"
					: "Conversation execution"),
			createdAt: execution.startedAt || conversation.createdAt,
			completedAt: execution.completedAt,
			error: execution.error,
			source: "orchestrator_execution",
			sourceLabel: "Conversation Execution",
			title:
				execution.userMessage ||
				conversation.title ||
				conversation.lastMessage ||
				undefined,
		}));
	}

	if (mode === "direct") {
		return [
			{
				id: `conversation:${conversation.id}`,
				agentId: conversation.agentId,
				status: "COMPLETED",
				stage: "Direct conversation",
				createdAt: conversation.updatedAt,
				source: "conversation",
				sourceLabel: "Conversation",
				title:
					conversation.title || conversation.lastMessage || undefined,
			},
		];
	}

	return [];
}

function formatAgentLabel(agentId: string): string {
	if (agentId === "orchestrator" || agentId === "fabric-ai") {
		return "Fabric AI";
	}

	return agentId.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

/**
 * Agent Task List Component
 *
 * Displays agent execution tasks with status and progress.
 */
export function AgentTaskList({
	organizationId,
	agentId,
	status,
}: AgentTaskListProps) {
	const { data, isLoading, error } = useQuery({
		queryKey: ["agents", "history", { organizationId, agentId, status }],
		queryFn: async () => {
			const taskRequest = {
				limit: 50,
				offset: 0,
				...(organizationId ? { organizationId } : {}),
				...(agentId ? { agentId } : {}),
				...(status ? { status } : {}),
			};

			const conversationRequest = {
				limit: 100,
				offset: 0,
				status: "ACTIVE" as const,
				...(organizationId ? { organizationId } : {}),
				...(agentId ? { agentId } : {}),
			};

			const [tasksResult, conversationsResult] = await Promise.allSettled(
				[
					orpcClient.agents.tasks.list(taskRequest),
					orpcClient.agents.conversations.list(conversationRequest),
				],
			);

			if (tasksResult.status === "rejected") {
				throw tasksResult.reason;
			}

			const tasks = tasksResult.value;
			const conversations =
				conversationsResult.status === "fulfilled"
					? conversationsResult.value
					: { conversations: [], total: 0, hasMore: false };

			if (conversationsResult.status === "rejected") {
				console.warn(
					"[AgentTaskList] Failed to load conversation-backed history:",
					conversationsResult.reason,
				);
			}

			const taskItems: HistoryItem[] = tasks.map((task) => ({
				id: task.id,
				agentId: task.agentId,
				status: normalizeStatus(task.status),
				stage: task.stage || "Task execution",
				createdAt: String(task.createdAt),
				completedAt: task.completedAt
					? String(task.completedAt)
					: undefined,
				error: task.error ?? undefined,
				source: "agent_task",
				sourceLabel: "Task",
			}));

			const conversationItems = conversations.conversations.flatMap(
				(conversation) => toHistoryItemsFromConversation(conversation),
			);

			const combined = [...taskItems, ...conversationItems].sort(
				(a, b) =>
					new Date(b.createdAt).getTime() -
					new Date(a.createdAt).getTime(),
			);

			return status
				? combined.filter(
						(item) => item.status === normalizeStatus(status),
					)
				: combined;
		},
		refetchInterval: 5000, // Refresh every 5 seconds for real-time updates
	});

	if (error) {
		return (
			<Alert variant="error">
				<AlertCircle className="h-4 w-4" />
				<AlertTitle>Error</AlertTitle>
				<AlertDescription>
					Failed to load agent history. Please try again later.
				</AlertDescription>
			</Alert>
		);
	}

	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-8">
				<Spinner className="mr-2 size-4 text-primary" />
				<span className="text-sm text-muted-foreground">
					Loading execution history...
				</span>
			</div>
		);
	}

	if (!data || data.length === 0) {
		return (
			<Alert>
				<AlertCircle className="h-4 w-4" />
				<AlertTitle>No History Found</AlertTitle>
				<AlertDescription>
					No agent executions match your current filters.
				</AlertDescription>
			</Alert>
		);
	}

	const groupedTasks = data.reduce<Record<string, HistoryItem[]>>(
		(acc, item) => {
			if (!acc[item.status]) {
				acc[item.status] = [];
			}
			acc[item.status].push(item);
			return acc;
		},
		{},
	);

	const statusOrder = [
		"RUNNING",
		"PENDING",
		"COMPLETED",
		"FAILED",
		"CANCELLED",
	];
	const sortedStatuses = statusOrder.filter(
		(s) => groupedTasks[s]?.length > 0,
	);

	return (
		<Queue>
			{sortedStatuses.map((taskStatus) => {
				const tasks = groupedTasks[taskStatus];
				return (
					<QueueSection
						key={taskStatus}
						defaultOpen={
							taskStatus === "RUNNING" || taskStatus === "PENDING"
						}
					>
						<QueueSectionTrigger>
							<QueueSectionLabel
								label={taskStatus}
								count={tasks.length}
								icon={
									<ClipboardListIcon className="h-4 w-4 text-muted-foreground" />
								}
							/>
						</QueueSectionTrigger>
						<QueueSectionContent>
							<QueueList maxHeight="none">
								{tasks.map((task) => {
									const isCompleted =
										task.status === "COMPLETED";

									return (
										<QueueItem
											key={task.id}
											isCompleted={isCompleted}
										>
											<QueueItemIndicator
												isCompleted={isCompleted}
											/>
											<QueueItemContent>
												<div className="flex items-center gap-2 mb-1">
													<span className="font-medium text-sm">
														{formatAgentLabel(
															task.agentId,
														)}
													</span>
													<StatusBadge
														status={task.status}
													/>
													<Badge
														variant="outline"
														className="text-[10px]"
													>
														{task.sourceLabel}
													</Badge>
												</div>
												{task.title && (
													<div className="mb-1 text-xs text-muted-foreground line-clamp-2">
														{task.title}
													</div>
												)}
												<QueueItemDescription>
													Stage: {task.stage}
												</QueueItemDescription>
												<div className="flex items-center gap-2 mt-1">
													<span className="text-xs text-muted-foreground">
														Started{" "}
														{formatDistanceToNow(
															new Date(
																task.createdAt,
															),
															{ addSuffix: true },
														)}
													</span>
													{task.completedAt && (
														<span className="text-xs text-muted-foreground">
															• Completed{" "}
															{formatDistanceToNow(
																new Date(
																	task.completedAt,
																),
																{
																	addSuffix: true,
																},
															)}
														</span>
													)}
												</div>
												{task.error && (
													<Alert
														variant="error"
														className="mt-2 py-2"
													>
														<AlertCircle className="h-3 w-3" />
														<AlertDescription className="text-xs">
															{task.error}
														</AlertDescription>
													</Alert>
												)}
											</QueueItemContent>
										</QueueItem>
									);
								})}
							</QueueList>
						</QueueSectionContent>
					</QueueSection>
				);
			})}
		</Queue>
	);
}

function StatusBadge({ status }: { status: string }) {
	const variants: Record<string, "default" | "secondary" | "destructive"> = {
		PENDING: "secondary",
		RUNNING: "default",
		COMPLETED: "default",
		FAILED: "destructive",
		CANCELLED: "secondary",
	};

	return (
		<Badge variant={variants[status] || "secondary"} className="text-xs">
			{status}
		</Badge>
	);
}
