"use client";

import { ORPCError } from "@orpc/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { ConversationDetail } from "../lib/conversation-list";

// Types for conversations
export interface ConversationMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
		result?: string;
		status?: "pending" | "running" | "success" | "error";
	}>;
	agentId?: string;
	metadata?: Record<string, unknown>;
	/**
	 * Stream lifecycle status persisted alongside the message body so
	 * cancelled turns surface the inline `Stopped` caption after a page
	 * reload (spec § 5.1 / AC-5). Optional for backwards compat with
	 * older persisted entries — renderers should treat `undefined` as
	 * `"completed"` for assistant messages.
	 */
	streamStatus?: "streaming" | "completed" | "error" | "cancelled";
	/** ISO timestamp stamped when the user halted this assistant turn. */
	cancelledAt?: string;
	/**
	 * Natural-language reasoning text the model emitted before answering.
	 * Persisted so the reasoning trace survives a page reload. Undefined
	 * for older persisted entries and for models without reasoning capability.
	 */
	reasoningText?: string;
	/**
	 * Duration of the reasoning phase in milliseconds. Persisted alongside
	 * reasoningText so "Thought for X.Ys" renders correctly after reload.
	 */
	reasoningDurationMs?: number;
}

interface TrajectoryNode {
	id: string;
	type:
		| "start"
		| "agent"
		| "tool_call"
		| "tool_result"
		| "decision"
		| "hitl"
		| "end";
	agentId?: string;
	agentName?: string;
	label: string;
	status: "pending" | "running" | "success" | "error";
	timestamp: string;
	duration?: number;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	error?: string;
	children: string[];
}

export interface AgentTrajectory {
	id: string;
	nodes: TrajectoryNode[];
	edges: Array<{ source: string; target: string }>;
	startTime: string;
	endTime?: string;
	status: "running" | "completed" | "failed";
}

export interface ConversationSummary {
	id: string;
	agentId: string;
	title: string | null;
	messageCount: number;
	pinned: boolean;
	status: "ACTIVE" | "ARCHIVED";
	createdAt: string;
	updatedAt: string;
	lastMessage: string | null;
}

const detailKey = (id: string) => ["agents", "conversations", "detail", id];

/** How often a conversation with a turn still running is read again. */
const RUNNING_TURN_REFRESH_MS = 5_000;

/**
 * Whether the read showed a turn that was still running (the server's
 * `inProgress` record): its answer is not there yet, so it is read again until
 * the finished turn replaces it.
 */
export function hasRunningTurn(
	detail: Pick<ConversationDetail, "metadata"> | null | undefined,
): boolean {
	const metadata = detail?.metadata;
	if (typeof metadata !== "object" || metadata === null) {
		return false;
	}
	const executions = (metadata as { executions?: unknown }).executions;
	return (
		Array.isArray(executions) &&
		executions.some(
			(execution) =>
				typeof execution === "object" &&
				execution !== null &&
				(execution as { inProgress?: unknown }).inProgress === true,
		)
	);
}

/**
 * One stored conversation, read when there is an id for it. A conversation that
 * is gone (a stale link, a deleted one) reads as null; any other failure is an
 * error, so the caller can offer to try again instead of saying it is gone.
 */
export function useConversationDetail(
	id: string | null,
	organizationId?: string | null,
) {
	return useQuery({
		queryKey: [...detailKey(id || ""), organizationId ?? null],
		queryFn: async (): Promise<ConversationDetail | null> => {
			if (!id) {
				return null;
			}
			try {
				return await orpcClient.agents.conversations.get({
					id,
					organizationId,
				});
			} catch (error) {
				if (error instanceof ORPCError && error.code === "NOT_FOUND") {
					return null;
				}
				throw error;
			}
		},
		enabled: !!id,
		retry: false,
		throwOnError: false,
		refetchInterval: (query) =>
			hasRunningTurn(query.state.data) ? RUNNING_TURN_REFRESH_MS : false,
	});
}

interface UseConversationHistoryOptions {
	/**
	 * Tenant scope. Pass `null` for personal context to prevent the server's
	 * `resolveOrganizationId` session fallback (the XOR pattern) — required so
	 * the listed conversations match where writes go. `undefined` keeps the
	 * legacy session-fallback behavior for existing callers.
	 */
	organizationId?: string | null;
	/** The agent whose conversations are listed; the list is kept per agent. */
	agentId: string;
	limit?: number;
}

/**
 * Hook for managing agent conversation history
 *
 * Features:
 * - List conversations with pagination
 * - Create/update/delete conversations
 * - Add messages to conversations
 * - Manage trajectories for visualization
 * - Pin/archive conversations
 */
export function useConversationHistory(options: UseConversationHistoryOptions) {
	const queryClient = useQueryClient();
	const [activeConversationId, setActiveConversationId] = useState<
		string | null
	>(null);

	const { organizationId, agentId, limit = 50 } = options;

	// Query keys
	const listKey = [
		"agents",
		"conversations",
		"list",
		{ organizationId, agentId },
	];

	// List conversations
	const {
		data: conversationsData,
		isLoading: isLoadingList,
		error: listError,
		refetch: refetchList,
	} = useQuery({
		queryKey: listKey,
		queryFn: async () => {
			try {
				const result = await orpcClient.agents.conversations.list({
					organizationId,
					agentId,
					status: "ACTIVE",
					limit,
				});
				return result;
			} catch (error) {
				console.warn(
					"[useConversationHistory] Failed to fetch conversations:",
					error,
				);
				// Return empty result on error to not break the UI
				return { conversations: [], hasMore: false };
			}
		},
		// Don't retry on failure - gracefully degrade
		retry: false,
		// Cache for a short time
		staleTime: 10000,
	});

	// Get active conversation details
	const {
		data: activeConversation,
		isLoading: isLoadingDetail,
		error: detailError,
	} = useConversationDetail(activeConversationId, organizationId);

	// Create conversation mutation
	const createMutation = useMutation({
		mutationFn: async (input: {
			agentId: string;
			title?: string;
			messages?: ConversationMessage[];
			metadata?: Record<string, unknown>;
		}) => {
			const result = await orpcClient.agents.conversations.create({
				organizationId,
				agentId: input.agentId,
				title: input.title,
				messages: input.messages,
				metadata: input.metadata,
			});
			return result;
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: listKey });
			setActiveConversationId(data.id);
		},
	});

	// Update conversation mutation
	const updateMutation = useMutation({
		mutationFn: async (input: {
			id: string;
			title?: string | null;
			messages?: ConversationMessage[];
			trajectory?: AgentTrajectory | null;
			metadata?: Record<string, unknown>;
			pinned?: boolean;
			status?: "ACTIVE" | "ARCHIVED";
		}) => {
			const result = await orpcClient.agents.conversations.update({
				...input,
				organizationId: organizationId ?? undefined,
			});
			return result;
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: listKey });
			queryClient.invalidateQueries({ queryKey: detailKey(data.id) });
		},
	});

	// Add message mutation
	const addMessageMutation = useMutation({
		mutationFn: async (input: {
			conversationId: string;
			message: ConversationMessage;
		}) => {
			const result = await orpcClient.agents.conversations.addMessage({
				...input,
				organizationId: organizationId ?? undefined,
			});
			return result;
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: listKey });
			queryClient.invalidateQueries({ queryKey: detailKey(data.id) });
		},
	});

	// Update trajectory mutation
	const updateTrajectoryMutation = useMutation({
		mutationFn: async (input: {
			conversationId: string;
			trajectory: AgentTrajectory;
		}) => {
			const result =
				await orpcClient.agents.conversations.updateTrajectory({
					...input,
					organizationId: organizationId ?? undefined,
				});
			return result;
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: detailKey(data.id) });
		},
	});

	// Delete conversation mutation
	const deleteMutation = useMutation({
		mutationFn: async (id: string) => {
			const result = await orpcClient.agents.conversations.delete({
				id,
				organizationId: organizationId ?? undefined,
			});
			return result;
		},
		onSuccess: (_result, deletedId) => {
			queryClient.invalidateQueries({ queryKey: listKey });
			// Only the open conversation's own deletion may clear the selection —
			// a transient null wipes its document-RAG chat id and research state.
			setActiveConversationId((current) =>
				current === deletedId ? null : current,
			);
		},
	});

	// Archive conversation mutation
	const archiveMutation = useMutation({
		mutationFn: async (id: string) => {
			const result = await orpcClient.agents.conversations.archive({
				id,
				organizationId: organizationId ?? undefined,
			});
			return result;
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: listKey });
		},
	});

	// Toggle pin mutation
	const togglePinMutation = useMutation({
		mutationFn: async (id: string) => {
			const result = await orpcClient.agents.conversations.togglePin({
				id,
				organizationId: organizationId ?? undefined,
			});
			return result;
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: listKey });
		},
	});

	// Helper functions
	const createConversation = useCallback(
		async (agentId: string, initialMessage?: ConversationMessage) => {
			const messages = initialMessage ? [initialMessage] : undefined;
			return createMutation.mutateAsync({
				agentId,
				messages,
			});
		},
		[createMutation],
	);

	const selectConversation = useCallback((id: string | null) => {
		setActiveConversationId(id);
	}, []);

	const addMessage = useCallback(
		async (message: ConversationMessage) => {
			if (!activeConversationId) {
				throw new Error("No active conversation");
			}
			return addMessageMutation.mutateAsync({
				conversationId: activeConversationId,
				message,
			});
		},
		[activeConversationId, addMessageMutation],
	);

	const updateTrajectory = useCallback(
		async (trajectory: AgentTrajectory) => {
			if (!activeConversationId) {
				throw new Error("No active conversation");
			}
			return updateTrajectoryMutation.mutateAsync({
				conversationId: activeConversationId,
				trajectory,
			});
		},
		[activeConversationId, updateTrajectoryMutation],
	);

	const deleteConversation = useCallback(
		async (id: string) => {
			return deleteMutation.mutateAsync(id);
		},
		[deleteMutation],
	);

	const archiveConversation = useCallback(
		async (id: string) => {
			return archiveMutation.mutateAsync(id);
		},
		[archiveMutation],
	);

	const togglePin = useCallback(
		async (id: string) => {
			return togglePinMutation.mutateAsync(id);
		},
		[togglePinMutation],
	);

	const updateTitle = useCallback(
		async (id: string, title: string) => {
			return updateMutation.mutateAsync({ id, title });
		},
		[updateMutation],
	);

	return {
		// State
		conversations: (conversationsData?.conversations ??
			[]) as ConversationSummary[],
		hasMore: conversationsData?.hasMore ?? false,
		activeConversationId,
		activeConversation,

		// Loading states
		isLoadingList,
		isLoadingDetail,
		isCreating: createMutation.isPending,
		isUpdating: updateMutation.isPending,
		isDeleting: deleteMutation.isPending,

		// Errors
		listError,
		detailError,

		// Actions
		createConversation,
		selectConversation,
		addMessage,
		updateTrajectory,
		deleteConversation,
		archiveConversation,
		togglePin,
		updateTitle,
		refetchList,
	};
}

/**
 * Helper to generate unique message IDs
 */
export function generateMessageId(): string {
	return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
