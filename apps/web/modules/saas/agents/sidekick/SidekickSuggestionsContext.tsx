"use client";

import { NEW_AGENT_ID } from "@repo/ai/sidekick/constants";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
} from "react";

// ---- Types ----

/**
 * Mirrors the `AgentSuggestionRecord` shape returned by the backend.
 * Kept as a local type to avoid importing from `@repo/api` internals.
 */
export interface AgentSuggestionRecord {
	id: string;
	key: string;
	kind:
		| "instructions"
		| "tools"
		| "skills"
		| "model"
		| "knowledge"
		| "sub_agent"
		| "reliability"
		| "discovery";
	title: string;
	description: string;
	payload?:
		| { content: string; targetBlockId: string; type: "replace" }
		| { action: "add" | "remove"; toolId: string }
		| { action: "add" | "remove"; skillId: string }
		| { modelId: string; reasoningEffort?: string }
		| {
				action: "add" | "remove";
				method: "search" | "query_tables";
				dataSourceId: string;
				description?: string;
		  }
		| { action: "add" | "remove"; subAgentId: string }
		| null
		| undefined;
	state: "pending" | "approved" | "rejected" | "outdated";
	conversationId?: string | null | undefined;
	createdAt: string;
	updatedAt: string;
}

/** Shape returned by the list endpoint. */
interface SuggestionsListResponse {
	canReview: boolean;
	suggestions: AgentSuggestionRecord[];
}

/** TipTap editor interface — only the commands we rely on. */
interface SidekickEditor {
	commands?: {
		acceptSuggestion?: (suggestionId: string) => boolean;
		rejectSuggestion?: (suggestionId: string) => boolean;
	};
}

export interface SidekickSuggestionsContextValue {
	/** Suggestions currently awaiting review. */
	pendingSuggestions: AgentSuggestionRecord[];
	/** Suggestions that have been marked outdated. */
	outdatedSuggestions: AgentSuggestionRecord[];
	/** Whether either query is still loading for the first time. */
	isSuggestionsLoading: boolean;
	/** Look up a suggestion by ID across both pending and outdated lists. */
	getSuggestion(suggestionId: string): AgentSuggestionRecord | null;
	/** Optimistically approve a suggestion and persist via PATCH. */
	acceptSuggestion(suggestion: AgentSuggestionRecord): Promise<boolean>;
	/** Optimistically reject a suggestion and persist via PATCH. */
	rejectSuggestion(suggestion: AgentSuggestionRecord): Promise<boolean>;
	/** Register a TipTap editor so accept/reject can drive editor commands. */
	registerEditor(editor: SidekickEditor | null): void;
	/** Trigger a refetch for pending suggestions if a given ID is missing. */
	triggerRefetch(suggestionId: string): void;
	/** Whether we have already attempted a refetch for a given suggestion ID. */
	hasAttemptedRefetch(suggestionId: string): boolean;
	/** Scroll to the next pending suggestion card. */
	scrollToNextSuggestion(justAccepted?: AgentSuggestionRecord): void;
}

// ---- Context ----

const SidekickSuggestionsContext =
	createContext<SidekickSuggestionsContextValue | null>(null);

// ---- Provider ----

/**
 * Discriminates which entity this Sidekick session is editing:
 *  - "registered" — RegisteredAgent (full review workflow, persisted suggestions)
 *  - "instance"   — AgentTemplateInstance (auto-apply only; persistence unsupported)
 */
export type SidekickEntityType = "registered" | "instance";

interface SidekickSuggestionsProviderProps {
	agentId: string | undefined;
	entityType?: SidekickEntityType;
	children: ReactNode;
}

export function SidekickSuggestionsProvider({
	agentId,
	entityType = "registered",
	children,
}: SidekickSuggestionsProviderProps) {
	const queryClient = useQueryClient();

	// Include entityType in the cache key so registered/instance sessions
	// with the same ID (unlikely but possible) don't collide.
	const suggestionsKey = useMemo(
		() => ["sidekick-suggestions", entityType, agentId] as const,
		[agentId, entityType],
	);

	const suggestionsQuery = useQuery<SuggestionsListResponse>({
		queryKey: suggestionsKey,
		queryFn: () =>
			orpcClient.agents.registry.suggestions.list({
				id: agentId as string,
				entityType,
				states: ["pending", "outdated"],
				limit: 100,
			}),
		// Persisted suggestions are RegisteredAgent-only today; skip the query
		// for instances and for unsaved agents to avoid noisy 404s.
		enabled:
			!!agentId &&
			agentId !== NEW_AGENT_ID &&
			entityType === "registered",
	});

	// ---- Refs ----

	/** Keeps track of suggestions that have been accepted/rejected locally
	 *  before the server responds, so `getSuggestion` can return the updated state. */
	const processedSuggestionsRef = useRef<Map<string, AgentSuggestionRecord>>(
		new Map(),
	);

	/** Prevents repeated refetch attempts for the same suggestion ID. */
	const refetchAttemptedRef = useRef<Set<string>>(new Set());

	/** Optional TipTap editor reference for driving accept/reject commands. */
	const editorRef = useRef<SidekickEditor | null>(null);

	// ---- Derived data ----

	const pendingSuggestions = useMemo(
		() =>
			suggestionsQuery.data?.suggestions.filter(
				(s) => s.state === "pending",
			) ?? [],
		[suggestionsQuery.data],
	);

	const outdatedSuggestions = useMemo(
		() =>
			suggestionsQuery.data?.suggestions.filter(
				(s) => s.state === "outdated",
			) ?? [],
		[suggestionsQuery.data],
	);

	const isSuggestionsLoading = suggestionsQuery.isLoading;

	// ---- Helpers ----

	// Build a Map for O(1) suggestion lookups instead of O(n) array scans
	const suggestionMap = useMemo(() => {
		const map = new Map<string, AgentSuggestionRecord>();
		for (const s of pendingSuggestions) {
			map.set(s.id, s);
		}
		for (const s of outdatedSuggestions) {
			map.set(s.id, s);
		}
		return map;
	}, [pendingSuggestions, outdatedSuggestions]);

	const getSuggestion = useCallback(
		(suggestionId: string): AgentSuggestionRecord | null => {
			// Check processed cache first (optimistic state)
			const processed = processedSuggestionsRef.current.get(suggestionId);
			if (processed) {
				return processed;
			}
			return suggestionMap.get(suggestionId) ?? null;
		},
		[suggestionMap],
	);

	// ---- Accept / Reject ----

	const patchSuggestion = useCallback(
		async (
			suggestion: AgentSuggestionRecord,
			nextState: "approved" | "rejected",
		): Promise<boolean> => {
			if (!agentId || entityType !== "registered") {
				return false;
			}

			const updatedSuggestion: AgentSuggestionRecord = {
				...suggestion,
				state: nextState,
			};

			// Store in processed cache for immediate lookups
			processedSuggestionsRef.current.set(
				suggestion.id,
				updatedSuggestion,
			);

			// Optimistic update: remove the item from the query cache
			// (it moves to processedSuggestionsRef for immediate lookups)
			queryClient.setQueryData<SuggestionsListResponse>(
				suggestionsKey,
				(old) => {
					if (!old) {
						return old;
					}
					return {
						...old,
						suggestions: old.suggestions.filter(
							(item) => item.id !== suggestion.id,
						),
					};
				},
			);

			try {
				await orpcClient.agents.registry.suggestions.patch({
					id: agentId,
					entityType,
					suggestionId: suggestion.id,
					state: nextState,
				});

				// For instructions, drive the TipTap editor
				if (suggestion.kind === "instructions" && editorRef.current) {
					if (nextState === "approved") {
						editorRef.current.commands?.acceptSuggestion?.(
							suggestion.id,
						);
					} else {
						editorRef.current.commands?.rejectSuggestion?.(
							suggestion.id,
						);
					}
				}

				return true;
			} catch (error) {
				console.error(
					`[SidekickSuggestions] Failed to ${nextState} suggestion ${suggestion.id}:`,
					error,
				);

				// Rollback: remove from processed cache and refetch
				processedSuggestionsRef.current.delete(suggestion.id);
				queryClient.invalidateQueries({ queryKey: suggestionsKey });

				return false;
			}
		},
		[agentId, entityType, suggestionsKey, queryClient],
	);

	const acceptSuggestion = useCallback(
		(suggestion: AgentSuggestionRecord) =>
			patchSuggestion(suggestion, "approved"),
		[patchSuggestion],
	);

	const rejectSuggestion = useCallback(
		(suggestion: AgentSuggestionRecord) =>
			patchSuggestion(suggestion, "rejected"),
		[patchSuggestion],
	);

	// ---- Editor registration ----

	const registerEditor = useCallback((editor: SidekickEditor | null) => {
		editorRef.current = editor;
	}, []);

	// ---- Refetch management ----

	const triggerRefetch = useCallback(
		(suggestionId: string) => {
			// Don't refetch for new (unsaved) agents — no DB rows exist
			if (!agentId || agentId === NEW_AGENT_ID) {
				return;
			}
			if (getSuggestion(suggestionId)) {
				return;
			}
			if (refetchAttemptedRef.current.has(suggestionId)) {
				return;
			}

			refetchAttemptedRef.current.add(suggestionId);
			suggestionsQuery.refetch();
		},
		[agentId, getSuggestion, suggestionsQuery],
	);

	const hasAttemptedRefetch = useCallback((suggestionId: string): boolean => {
		return refetchAttemptedRef.current.has(suggestionId);
	}, []);

	// ---- Scroll ----

	const scrollToNextSuggestion = useCallback(
		(_justAccepted?: AgentSuggestionRecord) => {
			// TODO: scroll to next pending suggestion card in the chat panel
		},
		[],
	);

	// ---- Context value ----

	const value = useMemo<SidekickSuggestionsContextValue>(
		() => ({
			pendingSuggestions,
			outdatedSuggestions,
			isSuggestionsLoading,
			getSuggestion,
			acceptSuggestion,
			rejectSuggestion,
			registerEditor,
			triggerRefetch,
			hasAttemptedRefetch,
			scrollToNextSuggestion,
		}),
		[
			pendingSuggestions,
			outdatedSuggestions,
			isSuggestionsLoading,
			getSuggestion,
			acceptSuggestion,
			rejectSuggestion,
			registerEditor,
			triggerRefetch,
			hasAttemptedRefetch,
			scrollToNextSuggestion,
		],
	);

	return (
		<SidekickSuggestionsContext.Provider value={value}>
			{children}
		</SidekickSuggestionsContext.Provider>
	);
}

// ---- Hook ----

export function useSidekickSuggestions(): SidekickSuggestionsContextValue {
	const context = useContext(SidekickSuggestionsContext);
	if (!context) {
		throw new Error(
			"useSidekickSuggestions must be used within SidekickSuggestionsProvider",
		);
	}
	return context;
}
