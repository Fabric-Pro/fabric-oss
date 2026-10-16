"use client";

import { useAgentLabel } from "@saas/agents/hooks/useAgentLabel";
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

const CONVERSATION_PAGE_SIZE = 100;
/** Pages read for the history: a longer history stops here rather than on every refresh. */
const CONVERSATION_PAGES = 5;

const CONVERSATION_CAP = CONVERSATION_PAGE_SIZE * CONVERSATION_PAGES;

/**
 * The caller's active conversations, newest first, a page at a time by cursor:
 * of one agent when one is chosen, otherwise of every agent in the
 * organization. A page that cannot be read ends the read with the pages already
 * read kept, and says so (`failed`); a history longer than the pages read says
 * so too (`capped`), so neither passes for the whole history.
 */
async function listConversations({
	organizationId,
	agentId,
}: {
	organizationId?: string;
	agentId?: string;
}) {
	const conversations = [];
	let cursor: string | undefined;
	for (let page = 0; page < CONVERSATION_PAGES; page++) {
		let result: Awaited<
			ReturnType<typeof orpcClient.agents.conversations.list>
		>;
		try {
			result = await orpcClient.agents.conversations.list({
				limit: CONVERSATION_PAGE_SIZE,
				status: "ACTIVE",
				...(organizationId ? { organizationId } : {}),
				...(agentId ? { agentId } : {}),
				...(cursor ? { cursor } : {}),
			});
		} catch (error) {
			console.warn(
				"[AgentTaskList] Failed to load conversation-backed history:",
				error,
			);
			return { conversations, failed: true, capped: false };
		}
		conversations.push(...result.conversations);
		cursor = result.nextCursor;
		if (!cursor) {
			return { conversations, failed: false, capped: false };
		}
	}
	return { conversations, failed: false, capped: true };
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
	const formatAgentLabel = useAgentLabel();
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

			const [tasks, { conversations, failed, capped }] =
				await Promise.all([
					orpcClient.agents.tasks.list(taskRequest),
					listConversations({ organizationId, agentId }),
				]);

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

			const conversationItems = conversations.flatMap((conversation) =>
				toHistoryItemsFromConversation(conversation),
			);

			const combined = [...taskItems, ...conversationItems].sort(
				(a, b) =>
					new Date(b.createdAt).getTime() -
					new Date(a.createdAt).getTime(),
			);

			return {
				items: status
					? combined.filter(
							(item) => item.status === normalizeStatus(status),
						)
					: combined,
				conversationsFailed: failed,
				conversationsCapped: capped,
			};
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

	const partialNotice = data?.conversationsFailed ? (
		<Alert variant="warning">
			<AlertCircle className="h-4 w-4" />
			<AlertDescription>
				Some conversations could not be loaded, so this history may be
				incomplete.
			</AlertDescription>
		</Alert>
	) : null;

	if (!data || data.items.length === 0) {
		// A history that failed to load is not an empty one.
		return (
			partialNotice ?? (
				<Alert>
					<AlertCircle className="h-4 w-4" />
					<AlertTitle>No History Found</AlertTitle>
					<AlertDescription>
						No agent executions match your current filters.
					</AlertDescription>
				</Alert>
			)
		);
	}

	const groupedTasks = data.items.reduce<Record<string, HistoryItem[]>>(
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
		<div className="space-y-3">
			{partialNotice}
			{data.conversationsCapped ? (
				<output className="block text-xs text-muted-foreground">
					Showing the first {CONVERSATION_CAP} conversations.
				</output>
			) : null}
			<Queue>
				{sortedStatuses.map((taskStatus) => {
					const tasks = groupedTasks[taskStatus];
					return (
						<QueueSection
							key={taskStatus}
							defaultOpen={
								taskStatus === "RUNNING" ||
								taskStatus === "PENDING"
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
																{
																	addSuffix: true,
																},
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
		</div>
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
