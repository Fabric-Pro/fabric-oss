"use client";

/**
 * Orchestrator Conversation Hook
 * Extends conversation history with orchestrator-specific features:
 * - Step results persistence
 * - Plan and routing decision storage
 * - Approval history tracking
 * - Full conversation rehydration
 */

import type { StepResult } from "@repo/temporal";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { mergeOrchestratorConversationMetadata } from "../lib/orchestrator-conversation-tools";
import {
	type AgentTrajectory,
	type ConversationMessage,
	generateMessageId,
} from "./useConversationHistory";

/**
 * Orchestrator-specific metadata stored in conversation
 */
interface OrchestratorMetadata {
	mode: "orchestrator";
	executionMode: "lite" | "balanced" | "deep" | "planner";
	executions: OrchestratorExecution[];
	lastUpdated: string;
	selectedMcpConfigIds?: string[];
}

/**
 * A single orchestrator execution (can have multiple per conversation)
 */
export interface OrchestratorExecution {
	id: string;
	workflowId?: string;
	userMessage: string;
	imageUrls?: string[];
	routingDecision?: {
		primaryAgent: string;
		agentName: string;
		confidence: number;
		riskLevel: string;
	};
	plan?: {
		id: string;
		description: string;
		riskLevel: string;
		steps: Array<{
			id: string;
			description: string;
			status: string;
			order: number;
			riskLevel?: string;
			requiresApproval?: boolean;
		}>;
	};
	stepResults: Array<{
		stepId: string;
		stepDescription: string;
		status: "complete" | "error" | "skipped";
		response?: string;
		toolCalls: Array<{
			id: string;
			name: string;
			args: unknown;
			result: unknown;
			status: "success" | "error";
			durationMs: number;
			/** MCP App: ui:// resource URI for interactive HTML UI */
			mcpAppResourceUri?: string;
			/** MCP App: MCP config ID for proxying iframe tool calls */
			mcpAppConfigId?: string;
		}>;
		durationMs?: number;
	}>;
	approvalHistory: Array<{
		approvalId: string;
		stepId: string;
		stepDescription: string;
		riskLevel: string;
		requestedAt: string;
		decidedAt?: string;
		approved: boolean;
		feedback?: string;
	}>;
	variables: Record<string, unknown>;
	status: "running" | "complete" | "error" | "cancelled";
	startedAt: string;
	completedAt?: string;
	finalResponse?: string;
	error?: string;
	/** Artifacts generated during execution (documents, code, data, charts) */
	artifacts?: Array<{
		id: string;
		type:
			| "document"
			| "code"
			| "data"
			| "tool_result"
			| "file"
			| "error"
			| "chart";
		name?: string;
		content?: string;
		stepId?: string;
		createdAt?: string;
		metadata?: Record<string, unknown>;
	}>;
	/** Sources used during planning (for ArtifactsPanel persistence) */
	sourcesUsed?: string[];
}

/**
 * Full orchestrator conversation detail
 */
export interface OrchestratorConversationDetail {
	id: string;
	agentId: string;
	title: string | null;
	messages: ConversationMessage[];
	trajectory: AgentTrajectory | null;
	orchestratorMetadata: OrchestratorMetadata | null;
	pinned: boolean;
	status: "ACTIVE" | "ARCHIVED";
	createdAt: string;
	updatedAt: string;
}

interface UseOrchestratorConversationOptions {
	organizationId?: string;
	executionMode?: "lite" | "balanced" | "deep" | "planner";
	/** Agent template instance ID - stored in conversation metadata for context restoration */
	instanceId?: string;
}

/**
 * Hook for managing orchestrator conversations with full execution history
 */
export function useOrchestratorConversation(
	options: UseOrchestratorConversationOptions = {},
) {
	const queryClient = useQueryClient();
	const [activeConversationId, setActiveConversationId] = useState<
		string | null
	>(null);

	const { organizationId, executionMode = "balanced", instanceId } = options;
	// Canonical RegisteredAgent.agentId from seed-system-agents.ts.
	// The legacy "fabric-ai" value (URL-slug form) was a historical
	// drift between the catalog and AgentConversation rows; cleanup
	// PR migrated it and removed the compat alias seeded in PR #1236.
	// The instanceId discriminator stays in `metadata` as before — the
	// catalog id only identifies the agent, not the chat instance.
	// NOTE: this is the AgentConversation.agentId only. The orchestrator
	// subsystem identifies its agents with its own separate key, and that
	// is intentionally NOT migrated here — a different concern with its
	// own blast radius.
	const agentId = "fabric-workspace-assistant";

	// Query keys
	const listKey = [
		"orchestrator",
		"conversations",
		"list",
		{ organizationId },
	];
	const detailKey = (id: string) => [
		"orchestrator",
		"conversations",
		"detail",
		id,
	];

	// List orchestrator conversations
	const {
		data: conversationsData,
		isLoading: isLoadingList,
		refetch: refetchList,
	} = useQuery({
		queryKey: listKey,
		queryFn: async () => {
			try {
				const result = await orpcClient.agents.conversations.list({
					organizationId,
					agentId,
					status: "ACTIVE",
					limit: 50,
					offset: 0,
				});
				return result;
			} catch (error) {
				console.warn(
					"[useOrchestratorConversation] Failed to fetch:",
					error,
				);
				return { conversations: [], total: 0, hasMore: false };
			}
		},
		retry: false,
		staleTime: 10000,
	});

	// Get active conversation with orchestrator metadata
	const { data: activeConversation, isLoading: isLoadingDetail } = useQuery({
		queryKey: detailKey(activeConversationId || ""),
		queryFn: async (): Promise<OrchestratorConversationDetail | null> => {
			if (!activeConversationId) {
				return null;
			}

			const result = await orpcClient.agents.conversations.get({
				id: activeConversationId,
			});

			// Transform metadata to typed orchestrator metadata
			const metadata = result.metadata as Record<string, unknown> | null;
			const orchestratorMetadata: OrchestratorMetadata | null =
				metadata?.mode === "orchestrator"
					? (metadata as unknown as OrchestratorMetadata)
					: null;

			return {
				id: result.id,
				agentId: result.agentId,
				title: result.title,
				messages: result.messages as unknown as ConversationMessage[],
				trajectory:
					result.trajectory as unknown as AgentTrajectory | null,
				orchestratorMetadata,
				pinned: result.pinned,
				status: result.status,
				createdAt: result.createdAt,
				updatedAt: result.updatedAt,
			};
		},
		enabled: !!activeConversationId,
	});

	// Create conversation mutation
	const createMutation = useMutation({
		mutationFn: async (input: {
			title?: string;
			initialMessage?: ConversationMessage;
		}) => {
			const messages = input.initialMessage ? [input.initialMessage] : [];
			const metadata = mergeOrchestratorConversationMetadata({
				executionMode,
				executions: [],
				instanceId,
			});

			const result = await orpcClient.agents.conversations.create({
				organizationId,
				agentId,
				title: input.title,
				messages,
				metadata: metadata as unknown as Record<string, unknown>,
			});

			return result;
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: listKey });
			setActiveConversationId(data.id);
		},
	});

	// Save execution mutation
	const saveExecutionMutation = useMutation({
		mutationFn: async (input: {
			conversationId: string;
			execution: OrchestratorExecution;
			messages: ConversationMessage[];
			selectedMcpConfigIds?: string[] | null;
		}) => {
			// Get current conversation
			const current = await orpcClient.agents.conversations.get({
				id: input.conversationId,
			});

			const currentMetadata =
				(current.metadata as unknown as OrchestratorMetadata) || {
					mode: "orchestrator",
					executionMode,
					executions: [],
					lastUpdated: new Date().toISOString(),
				};

			// Guard: ensure executions is always an array even if DB metadata was
			// corrupted by a concurrent tool-selection update that ran before this
			// saveExecution completed (race condition on new conversation creation).
			const existingExecutions = Array.isArray(currentMetadata.executions)
				? currentMetadata.executions
				: [];

			// Add new execution
			const updatedMetadata = mergeOrchestratorConversationMetadata({
				existing: currentMetadata as unknown as Record<string, unknown>,
				executionMode: currentMetadata.executionMode ?? executionMode,
				executions: [...existingExecutions, input.execution],
				instanceId,
				// Use caller-provided selectedMcpConfigIds if given (avoids race
				// where DB metadata was overwritten before executions were saved),
				// otherwise fall back to whatever is already stored in the DB.
				selectedMcpConfigIds:
					input.selectedMcpConfigIds !== undefined
						? (input.selectedMcpConfigIds ?? undefined)
						: currentMetadata.selectedMcpConfigIds,
			});

			// Update conversation with new messages and metadata
			const result = await orpcClient.agents.conversations.update({
				id: input.conversationId,
				messages: input.messages,
				metadata: updatedMetadata as unknown as Record<string, unknown>,
			});

			return result;
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: listKey });
			queryClient.invalidateQueries({ queryKey: detailKey(data.id) });
		},
	});

	// Update execution mutation (for in-progress updates)
	const updateExecutionMutation = useMutation({
		mutationFn: async (input: {
			conversationId: string;
			executionId: string;
			update: Partial<OrchestratorExecution>;
		}) => {
			const current = await orpcClient.agents.conversations.get({
				id: input.conversationId,
			});

			const currentMetadata =
				current.metadata as unknown as OrchestratorMetadata;
			if (!currentMetadata) {
				throw new Error("Conversation has no orchestrator metadata");
			}

			// Update the specific execution
			const executions = currentMetadata.executions.map((exec) =>
				exec.id === input.executionId
					? { ...exec, ...input.update }
					: exec,
			);

			const updatedMetadata = mergeOrchestratorConversationMetadata({
				existing: currentMetadata as unknown as Record<string, unknown>,
				executionMode: currentMetadata.executionMode ?? executionMode,
				executions,
				instanceId,
				selectedMcpConfigIds: currentMetadata.selectedMcpConfigIds,
			});

			const result = await orpcClient.agents.conversations.update({
				id: input.conversationId,
				metadata: updatedMetadata as unknown as Record<string, unknown>,
			});

			return result;
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: detailKey(data.id) });
		},
	});

	// Helper functions
	const createConversation = useCallback(
		async (initialMessage?: string) => {
			const message = initialMessage
				? {
						id: generateMessageId(),
						role: "user" as const,
						content: initialMessage,
						timestamp: new Date().toISOString(),
					}
				: undefined;

			// Generate title from initial message
			const title = initialMessage
				? initialMessage.slice(0, 50) +
					(initialMessage.length > 50 ? "..." : "")
				: undefined;

			return createMutation.mutateAsync({
				title,
				initialMessage: message,
			});
		},
		[createMutation],
	);

	const selectConversation = useCallback((id: string | null) => {
		setActiveConversationId(id);
	}, []);

	const saveExecution = useCallback(
		async (
			conversationId: string,
			execution: OrchestratorExecution,
			messages: ConversationMessage[],
			selectedMcpConfigIds?: string[] | null,
		) => {
			return saveExecutionMutation.mutateAsync({
				conversationId,
				execution,
				messages,
				selectedMcpConfigIds,
			});
		},
		[saveExecutionMutation],
	);

	const updateExecution = useCallback(
		async (
			conversationId: string,
			executionId: string,
			update: Partial<OrchestratorExecution>,
		) => {
			return updateExecutionMutation.mutateAsync({
				conversationId,
				executionId,
				update,
			});
		},
		[updateExecutionMutation],
	);

	/**
	 * Rehydrate a conversation - get all executions with their step results
	 */
	const rehydrateConversation = useCallback(
		async (
			conversationId: string,
		): Promise<OrchestratorConversationDetail | null> => {
			const result = await orpcClient.agents.conversations.get({
				id: conversationId,
			});

			const metadata = result.metadata as Record<string, unknown> | null;
			const orchestratorMetadata: OrchestratorMetadata | null =
				metadata?.mode === "orchestrator"
					? (metadata as unknown as OrchestratorMetadata)
					: null;

			return {
				id: result.id,
				agentId: result.agentId,
				title: result.title,
				messages: result.messages as unknown as ConversationMessage[],
				trajectory:
					result.trajectory as unknown as AgentTrajectory | null,
				orchestratorMetadata,
				pinned: result.pinned,
				status: result.status,
				createdAt: result.createdAt,
				updatedAt: result.updatedAt,
			};
		},
		[],
	);

	/**
	 * Get the last execution from a conversation
	 */
	const getLastExecution = useCallback((): OrchestratorExecution | null => {
		if (!activeConversation?.orchestratorMetadata) {
			return null;
		}
		const executions = activeConversation.orchestratorMetadata.executions;
		return executions.length > 0 ? executions[executions.length - 1] : null;
	}, [activeConversation]);

	/**
	 * Convert step results from Temporal to storage format
	 */
	const convertStepResults = useCallback(
		(results: StepResult[]): OrchestratorExecution["stepResults"] => {
			return results.map((r) => ({
				stepId: r.stepId,
				stepDescription: r.stepDescription,
				status: r.status,
				response: r.response,
				toolCalls: r.toolCalls.map((tc) => ({
					id: tc.id,
					name: tc.name,
					args: tc.args,
					result: tc.result,
					status: tc.status,
					durationMs: tc.durationMs,
					mcpAppResourceUri: tc.mcpAppResourceUri,
					mcpAppConfigId: tc.mcpAppConfigId,
				})),
				durationMs: r.durationMs,
			}));
		},
		[],
	);

	return {
		// State
		conversations: conversationsData?.conversations ?? [],
		activeConversationId,
		activeConversation,

		// Loading states
		isLoadingList,
		isLoadingDetail,
		isSaving: saveExecutionMutation.isPending,
		isUpdating: updateExecutionMutation.isPending,

		// Actions
		createConversation,
		selectConversation,
		saveExecution,
		updateExecution,
		rehydrateConversation,
		getLastExecution,
		convertStepResults,
		refetchList,
	};
}

/**
 * Create an execution record from orchestrator state
 */
export function createExecutionRecord(
	id: string,
	userMessage: string,
	_executionMode: "lite" | "balanced" | "deep" | "planner",
): OrchestratorExecution {
	return {
		id,
		userMessage,
		stepResults: [],
		approvalHistory: [],
		variables: {},
		status: "running",
		startedAt: new Date().toISOString(),
	};
}
