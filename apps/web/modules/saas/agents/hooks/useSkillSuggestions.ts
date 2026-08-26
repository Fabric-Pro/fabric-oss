"use client";

/**
 * useSkillSuggestions
 *
 * React hook for fetching skill suggestions based on the last user message
 * in a conversation. Suggestions appear as chip buttons above the chat input.
 *
 * TENANT ISOLATION: This hook automatically uses the current organization context.
 */

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useEffect, useRef, useState } from "react";

interface SkillSuggestion {
	skillId: string;
	name: string;
	reason: string;
	confidence: number;
}

export interface UseSkillSuggestionsOptions {
	/**
	 * Override organization context.
	 * - `undefined` (default): Auto-detect from context
	 * - `null`: Force personal context
	 * - `string`: Force specific organization context
	 */
	organizationId?: string | null;
	/** Debounce delay in milliseconds (default: 400) */
	debounceMs?: number;
	/** Minimum message length to trigger suggestions (default: 5) */
	minLength?: number;
	/** Whether suggestions are enabled (default: true) */
	enabled?: boolean;
	/** Conversation ID for context-aware suggestions */
	conversationId?: string | null;
}

export interface UseSkillSuggestionsResult {
	suggestions: SkillSuggestion[];
	isLoading: boolean;
	error: string | null;
	/** Clear current suggestions */
	clear: () => void;
}

export function useSkillSuggestions(
	lastUserMessage: string,
	options: UseSkillSuggestionsOptions = {},
): UseSkillSuggestionsResult {
	// Auto-inject organization ID from context if not explicitly provided
	const contextOrgId = useOrganizationId();
	const organizationId =
		options.organizationId !== undefined
			? options.organizationId
			: contextOrgId;

	const {
		debounceMs = 400,
		minLength = 5,
		enabled = true,
		conversationId = null,
	} = options;

	const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const abortControllerRef = useRef<AbortController | null>(null);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);
	// Track the last message we already fetched for to avoid duplicate calls
	const lastFetchedMessageRef = useRef<string>("");

	const fetchSuggestions = useCallback(
		async (message: string) => {
			// Cancel any pending request
			abortControllerRef.current?.abort();
			abortControllerRef.current = new AbortController();

			setIsLoading(true);
			setError(null);

			try {
				const result = await orpcClient.agents.suggestSkills({
					message,
					organizationId: organizationId ?? null,
					conversationId: conversationId ?? undefined,
				});

				setSuggestions(result.suggestions || []);
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					// Request was cancelled, ignore
					return;
				}
				setError(err instanceof Error ? err.message : "Unknown error");
				setSuggestions([]);
			} finally {
				setIsLoading(false);
			}
		},
		[organizationId, conversationId],
	);

	// Debounced effect for fetching suggestions
	useEffect(() => {
		// Clear any pending timeout
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}

		const trimmedMessage = lastUserMessage.trim();

		// Don't fetch if disabled, too short, or already fetched for this message
		if (
			!enabled ||
			trimmedMessage.length < minLength ||
			trimmedMessage === lastFetchedMessageRef.current
		) {
			if (trimmedMessage.length < minLength) {
				setSuggestions([]);
			}
			return;
		}

		// Set up debounced fetch
		timeoutRef.current = setTimeout(() => {
			lastFetchedMessageRef.current = trimmedMessage;
			fetchSuggestions(trimmedMessage);
		}, debounceMs);

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, [lastUserMessage, enabled, minLength, debounceMs, fetchSuggestions]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			abortControllerRef.current?.abort();
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, []);

	const clear = useCallback(() => {
		setSuggestions([]);
		setError(null);
		// Note: we intentionally do NOT reset lastFetchedMessageRef here.
		// This prevents re-fetching suggestions for the same message after
		// the user explicitly dismisses them or starts typing.
	}, []);

	return {
		suggestions,
		isLoading,
		error,
		clear,
	};
}
