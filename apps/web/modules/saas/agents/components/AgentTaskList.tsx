"use client";

import { useAgentLabel } from "@saas/agents/hooks/useAgentLabel";
import { isTaskAdmissionUnresolved } from "@saas/agents/lib/task-admission-status";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { SearchInput } from "@ui/components/search-input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	AlertCircle,
	ArrowDown,
	Calendar,
	CheckCircle2,
	Clock,
	Columns3,
	Loader2,
	Search,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

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
	admissionUnresolved?: boolean;
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
	const [sourceFilter, setSourceFilter] = useState<
		"ALL" | HistoryItem["source"]
	>("ALL");
	const [statusFilter, setStatusFilter] = useState<
		"ALL" | HistoryItem["status"]
	>("ALL");
	const [searchQuery, setSearchQuery] = useState("");

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
				admissionUnresolved:
					!task.runId &&
					isTaskAdmissionUnresolved(task.status, task.state),
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

	const filteredItems = useMemo(() => {
		if (!data?.items) {
			return [];
		}
		return data.items.filter((item) => {
			if (sourceFilter !== "ALL" && item.source !== sourceFilter) {
				return false;
			}
			if (statusFilter !== "ALL" && item.status !== statusFilter) {
				return false;
			}
			if (searchQuery.trim()) {
				const q = searchQuery.toLowerCase();
				const matchesTitle = item.title?.toLowerCase().includes(q);
				const matchesAgent = item.agentId.toLowerCase().includes(q);
				const matchesStage = item.stage.toLowerCase().includes(q);
				const matchesId = item.id.toLowerCase().includes(q);
				if (
					!matchesTitle &&
					!matchesAgent &&
					!matchesStage &&
					!matchesId
				) {
					return false;
				}
			}
			return true;
		});
	}, [data?.items, sourceFilter, statusFilter, searchQuery]);

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

	return (
		<div className="space-y-4">
			{partialNotice}
			{data.conversationsCapped ? (
				<output className="block text-xs text-muted-foreground">
					Showing the first {CONVERSATION_CAP} conversations.
				</output>
			) : null}

			{/* Databricks Runs filter bar */}
			<div className="flex flex-wrap items-center gap-2">
				{/* Segmented source selector: All | Tasks | Orchestrator | Conversations */}
				<div className="inline-flex items-center overflow-hidden rounded-[6px] border border-border bg-background">
					{(
						[
							{ value: "ALL", label: "All" },
							{ value: "agent_task", label: "Tasks" },
							{
								value: "orchestrator_execution",
								label: "Orchestrator",
							},
							{ value: "conversation", label: "Conversations" },
						] as const
					).map((option, idx) => {
						const active = sourceFilter === option.value;
						return (
							<button
								key={option.value}
								type="button"
								onClick={() => setSourceFilter(option.value)}
								aria-pressed={active}
								className={cn(
									"h-8 px-3 text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
									idx > 0 && "border-l border-border",
									active
										? "bg-primary/[0.10] text-primary-active dark:bg-primary/[0.18]"
										: "text-foreground hover:bg-muted/60",
								)}
							>
								{option.label}
							</button>
						);
					})}
				</div>

				{/* Time window chip */}
				<div className="inline-flex h-8 items-center gap-2 rounded-[6px] border border-border bg-background px-3 text-xs text-muted-foreground">
					<Calendar className="h-3.5 w-3.5 shrink-0" />
					<span>Last 48 hours</span>
				</div>

				{/* Status filter segmented pills */}
				<div className="inline-flex items-center overflow-hidden rounded-[6px] border border-border bg-background">
					{(
						[
							{ value: "ALL", label: "Run status: All" },
							{ value: "RUNNING", label: "Running" },
							{ value: "COMPLETED", label: "Succeeded" },
							{ value: "FAILED", label: "Failed" },
						] as const
					).map((option, idx) => {
						const active = statusFilter === option.value;
						return (
							<button
								key={option.value}
								type="button"
								onClick={() => setStatusFilter(option.value)}
								aria-pressed={active}
								className={cn(
									"h-8 px-2.5 text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
									idx > 0 && "border-l border-border",
									active
										? "bg-primary/[0.10] text-primary-active dark:bg-primary/[0.18]"
										: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
								)}
							>
								{option.label}
							</button>
						);
					})}
				</div>

				{/* Run ID / Name search */}
				<div className="relative w-full sm:w-56">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<SearchInput
						placeholder="Run ID or name"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="h-8 pl-8 text-xs"
					/>
				</div>
			</div>

			{/* Databricks Runs timeline chart panel */}
			<div className="rounded-lg border border-border bg-card px-4 py-3">
				<div className="relative h-24 w-full">
					{/* Top dashed gridline (1) */}
					<div className="flex items-center gap-2">
						<span className="w-4 text-right font-mono text-[10px] text-muted-foreground">
							1
						</span>
						<div className="flex-1 border-b border-dashed border-border" />
					</div>

					{/* Bar visualization area */}
					<div className="my-2 ml-6 flex h-12 items-end gap-1 overflow-hidden">
						{filteredItems.slice(0, 48).map((item) => {
							const barColor =
								item.status === "FAILED"
									? "bg-destructive"
									: item.status === "CANCELLED"
										? "bg-muted-foreground/50"
										: item.status === "RUNNING" ||
												item.status === "PENDING"
											? "bg-amber-500"
											: "bg-emerald-600 dark:bg-emerald-500";
							return (
								<div
									key={`bar-${item.id}`}
									title={`${formatAgentLabel(item.agentId)} — ${item.admissionUnresolved ? "Admission unresolved" : item.status}`}
									className={cn(
										"h-9 w-2 shrink-0 rounded-t-[2px] transition-opacity hover:opacity-80",
										barColor,
									)}
								/>
							);
						})}
					</div>

					{/* Bottom solid axis line (0) */}
					<div className="flex items-center gap-2">
						<span className="w-4 text-right font-mono text-[10px] text-muted-foreground">
							0
						</span>
						<div className="flex-1 border-b border-border" />
					</div>
				</div>

				{/* Legend: Failed | Skipped | Succeeded */}
				<div className="mt-2 flex flex-wrap items-center gap-4 pl-6 text-xs text-muted-foreground">
					<span className="inline-flex items-center gap-1.5">
						<span className="h-2.5 w-2.5 rounded-[2px] bg-destructive" />
						<span>Failed</span>
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span className="h-2.5 w-2.5 rounded-[2px] bg-muted-foreground/50" />
						<span>Skipped</span>
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span className="h-2.5 w-2.5 rounded-[2px] bg-emerald-600 dark:bg-emerald-500" />
						<span>Succeeded</span>
					</span>
				</div>
			</div>

			{/* Databricks DuBois Runs Table */}
			<div className="overflow-hidden rounded-lg border border-border bg-card">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent">
							<TableHead className="w-[14%]">
								<span className="inline-flex items-center gap-1">
									<span>Start time</span>
									<ArrowDown className="h-3 w-3 text-muted-foreground" />
								</span>
							</TableHead>
							<TableHead className="w-[26%]">Name</TableHead>
							<TableHead className="w-[14%]">Type</TableHead>
							<TableHead className="w-[18%]">
								Launched / Stage
							</TableHead>
							<TableHead className="w-[10%]">Duration</TableHead>
							<TableHead className="w-[10%]">Status</TableHead>
							<TableHead className="w-[8%]">Error code</TableHead>
							<TableHead className="w-9 text-right">
								<Columns3
									aria-hidden="true"
									className="ml-auto h-3.5 w-3.5 text-muted-foreground"
								/>
								<span className="sr-only">Error details</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{filteredItems.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={8}
									className="py-8 text-center text-xs text-muted-foreground"
								>
									No runs match your current filters.
								</TableCell>
							</TableRow>
						) : null}
						{filteredItems.map((task) => {
							const durationLabel = formatDuration(
								task.createdAt,
								task.completedAt,
								task.status,
							);
							return (
								<TableRow key={task.id}>
									<TableCell className="py-2.5 text-xs text-muted-foreground whitespace-nowrap">
										{formatDistanceToNow(
											new Date(task.createdAt),
											{ addSuffix: true },
										)}
									</TableCell>
									<TableCell className="py-2.5">
										<div className="min-w-0">
											<div className="truncate text-[13px] font-medium text-foreground">
												{formatAgentLabel(task.agentId)}
											</div>
											{task.title && (
												<div className="truncate text-xs text-muted-foreground">
													{task.title}
												</div>
											)}
										</div>
									</TableCell>
									<TableCell className="py-2.5 text-xs text-muted-foreground whitespace-nowrap">
										{task.sourceLabel}
									</TableCell>
									<TableCell className="py-2.5 text-xs text-muted-foreground">
										<span className="line-clamp-1">
											Stage: {task.stage}
										</span>
									</TableCell>
									<TableCell className="py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">
										{durationLabel}
									</TableCell>
									<TableCell className="py-2.5 whitespace-nowrap">
										<RunStatusCell
											status={task.status}
											admissionUnresolved={
												task.admissionUnresolved
											}
										/>
									</TableCell>
									<TableCell
										colSpan={2}
										className="py-2.5 text-xs text-destructive"
									>
										<span className="line-clamp-1">
											{task.error || "-"}
										</span>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}

function formatDuration(
	createdAt: string,
	completedAt: string | undefined,
	status: HistoryItem["status"],
): string {
	if (status === "RUNNING" || status === "PENDING") {
		return "Running...";
	}
	if (!completedAt) {
		return "-";
	}
	const startMs = new Date(createdAt).getTime();
	const endMs = new Date(completedAt).getTime();
	const diffSec = Math.max(0, Math.round((endMs - startMs) / 1000));
	if (diffSec < 60) {
		return `${diffSec}s`;
	}
	const mins = Math.floor(diffSec / 60);
	const secs = diffSec % 60;
	return `${mins}m ${secs}s`;
}

function RunStatusCell({
	status,
	admissionUnresolved,
}: {
	status: HistoryItem["status"];
	admissionUnresolved?: boolean;
}) {
	if (admissionUnresolved) {
		return (
			<span
				className="inline-flex items-center gap-1.5 text-xs font-medium text-highlight-ink"
				title="Check the execution before submitting another request; no automatic retry is promised."
			>
				<AlertCircle className="h-3.5 w-3.5 shrink-0" />
				<span>Admission unresolved</span>
			</span>
		);
	}

	switch (status) {
		case "COMPLETED":
			return (
				<span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
					<CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
					<span>Succeeded</span>
				</span>
			);
		case "RUNNING":
			return (
				<span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
					<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
					<span>Running</span>
				</span>
			);
		case "PENDING":
			return (
				<span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
					<Clock className="h-3.5 w-3.5 shrink-0" />
					<span>Pending</span>
				</span>
			);
		case "FAILED":
			return (
				<span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
					<XCircle className="h-3.5 w-3.5 shrink-0" />
					<span>Failed</span>
				</span>
			);
		case "CANCELLED":
			return (
				<span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					<XCircle className="h-3.5 w-3.5 shrink-0" />
					<span>Skipped</span>
				</span>
			);
	}
}
