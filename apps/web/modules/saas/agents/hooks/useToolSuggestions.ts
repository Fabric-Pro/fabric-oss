"use client";

/**
 * useToolSuggestions
 *
 * React hook for fetching tool suggestions based on user input.
 * Uses debouncing to avoid excessive API calls while typing.
 *
 * TENANT ISOLATION: This hook automatically uses the current organization context.
 */

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { useCallback, useEffect, useRef, useState } from "react";

interface ToolSuggestion {
	toolName: string;
	serverName: string;
	configName: string;
	description: string;
	reason: string;
}

export interface UseToolSuggestionsOptions {
	/**
	 * Override organization context.
	 * - `undefined` (default): Auto-detect from context
	 * - `null`: Force personal context
	 * - `string`: Force specific organization context
	 */
	organizationId?: string | null;
	enabledMcpConfigIds?: string[] | null;
	/** Debounce delay in milliseconds (default: 500) */
	debounceMs?: number;
	/** Minimum input length to trigger suggestions (default: 5) */
	minLength?: number;
	/** Whether suggestions are enabled (default: true) */
	enabled?: boolean;
}

export interface UseToolSuggestionsResult {
	suggestions: ToolSuggestion[];
	isLoading: boolean;
	canHandle: boolean;
	confidence: number;
	error: string | null;
	/** Clear current suggestions */
	clear: () => void;
}

export function useToolSuggestions(
	input: string,
	options: UseToolSuggestionsOptions = {},
): UseToolSuggestionsResult {
	// Auto-inject organization ID from context if not explicitly provided
	const contextOrgId = useOrganizationId();
	const organizationId =
		options.organizationId !== undefined
			? options.organizationId
			: contextOrgId;

	const {
		enabledMcpConfigIds = null,
		debounceMs = 500,
		minLength = 5,
		enabled = true,
	} = options;

	const [suggestions, setSuggestions] = useState<ToolSuggestion[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [canHandle, setCanHandle] = useState(false);
	const [confidence, setConfidence] = useState(0);
	const [error, setError] = useState<string | null>(null);

	const abortControllerRef = useRef<AbortController | null>(null);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);

	const fetchSuggestions = useCallback(
		async (message: string) => {
			// Cancel any pending request
			abortControllerRef.current?.abort();
			abortControllerRef.current = new AbortController();

			setIsLoading(true);
			setError(null);

			try {
				const response = await fetch(
					"/api/agents/fabric-ai/suggest-tools",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							message,
							organizationId,
							enabledMcpConfigIds,
						}),
						signal: abortControllerRef.current.signal,
					},
				);

				if (!response.ok) {
					const data = await response.json();
					throw new Error(
						data.error || "Failed to fetch suggestions",
					);
				}

				const data = await response.json();
				setSuggestions(data.suggestions || []);
				setCanHandle(data.canHandle || false);
				setConfidence(data.confidence || 0);
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					// Request was cancelled, ignore
					return;
				}
				setError(err instanceof Error ? err.message : "Unknown error");
				setSuggestions([]);
				setCanHandle(false);
				setConfidence(0);
			} finally {
				setIsLoading(false);
			}
		},
		[organizationId, enabledMcpConfigIds],
	);

	// Debounced effect for fetching suggestions
	useEffect(() => {
		// Clear any pending timeout
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}

		// Don't fetch if disabled or input too short
		if (!enabled || input.trim().length < minLength) {
			setSuggestions([]);
			setCanHandle(false);
			setConfidence(0);
			return;
		}

		// Set up debounced fetch
		timeoutRef.current = setTimeout(() => {
			fetchSuggestions(input.trim());
		}, debounceMs);

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, [input, enabled, minLength, debounceMs, fetchSuggestions]);

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
		setCanHandle(false);
		setConfidence(0);
		setError(null);
	}, []);

	return {
		suggestions,
		isLoading,
		canHandle,
		confidence,
		error,
		clear,
	};
}
