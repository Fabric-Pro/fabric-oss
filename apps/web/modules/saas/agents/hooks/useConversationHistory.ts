"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

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

interface ConversationDetail {
	id: string;
	agentId: string;
	title: string | null;
	messages: ConversationMessage[];
	trajectory: AgentTrajectory | null;
	metadata: Record<string, unknown> | null;
	pinned: boolean;
	status: "ACTIVE" | "ARCHIVED";
	createdAt: string;
	updatedAt: string;
}

interface UseConversationHistoryOptions {
	/**
	 * Tenant scope. Pass `null` for personal context to prevent the server's
	 * `resolveOrganizationId` session fallback (the XOR pattern) — required so
	 * the listed conversations match where writes go. `undefined` keeps the
	 * legacy session-fallback behavior for existing callers.
	 */
	organizationId?: string | null;
	agentId?: string;
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
export function useConversationHistory(
	options: UseConversationHistoryOptions = {},
) {
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
	const detailKey = (id: string) => ["agents", "conversations", "detail", id];

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
					offset: 0,
				});
				return result;
			} catch (error) {
				console.warn(
					"[useConversationHistory] Failed to fetch conversations:",
					error,
				);
				// Return empty result on error to not break the UI
				return { conversations: [], total: 0, hasMore: false };
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
	} = useQuery({
		queryKey: detailKey(activeConversationId || ""),
		queryFn: async () => {
			if (!activeConversationId) {
				return null;
			}
			try {
				const result = await orpcClient.agents.conversations.get({
					id: activeConversationId,
				});
				return result as unknown as ConversationDetail;
			} catch (error: unknown) {
				// Handle case where conversation doesn't exist (e.g., stale URL, deleted conversation)
				// Check if it's a 404/NOT_FOUND error - these are expected for missing conversations
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				if (
					errorMessage.includes("not found") ||
					errorMessage.includes("NOT_FOUND") ||
					errorMessage.includes("Conversation not found")
				) {
					// Silently return null for expected 404 errors
					return null;
				}
				// Log unexpected errors
				console.warn(
					`[useConversationHistory] Failed to fetch conversation: ${activeConversationId}`,
					error,
				);
				return null;
			}
		},
		enabled: !!activeConversationId,
		// Don't retry - conversation either exists or doesn't
		retry: false,
		// Don't throw errors to the error boundary
		throwOnError: false,
	});

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
			const result = await orpcClient.agents.conversations.update(input);
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
			const result =
				await orpcClient.agents.conversations.addMessage(input);
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
				await orpcClient.agents.conversations.updateTrajectory(input);
			return result;
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: detailKey(data.id) });
		},
	});

	// Delete conversation mutation
	const deleteMutation = useMutation({
		mutationFn: async (id: string) => {
			const result = await orpcClient.agents.conversations.delete({ id });
			return result;
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: listKey });
			if (activeConversationId) {
				setActiveConversationId(null);
			}
		},
	});

	// Archive conversation mutation
	const archiveMutation = useMutation({
		mutationFn: async (id: string) => {
			const result = await orpcClient.agents.conversations.archive({
				id,
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
		total: conversationsData?.total ?? 0,
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
