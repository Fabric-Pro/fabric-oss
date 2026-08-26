"use client";

/**
 * useAgentConfigPersistence
 *
 * A comprehensive hook for managing agent configuration state with dual persistence:
 * - localStorage: For immediate UI responsiveness and offline caching
 * - Database: For cross-device/cross-session persistence via user preferences
 *
 * Features:
 * - Immediate localStorage updates for fast UX
 * - Debounced database writes to avoid excessive API calls
 * - Automatic retry logic for failed database operations
 * - Toast notifications for sync status and errors
 * - Conflict resolution (database is authoritative)
 * - Offline-friendly with localStorage fallback
 */

import { toast } from "sonner";

// =============================================================================
// Constants
// =============================================================================

export const STORAGE_KEYS = {
	AGENTS: "fabric-orchestrator-enabled-agents",
	MCP: "fabric-orchestrator-enabled-mcp",
	WORKSPACES: "fabric-orchestrator-enabled-workspaces",
	FABRIC_TOOLS: "fabric-orchestrator-enabled-fabric-tools",
	INTEGRATIONS: "fabric-orchestrator-enabled-integrations",
	PRIORITIZED_TOOLS: "fabric-orchestrator-prioritized-tools",
	PRIORITIZED_AGENTS: "fabric-orchestrator-prioritized-agents",
	PRIORITIZED_MCP: "fabric-orchestrator-prioritized-mcp",
	PRIORITIZED_INTEGRATIONS: "fabric-orchestrator-prioritized-integrations",
	META: "fabric-orchestrator-config-meta",
} as const;

// =============================================================================
// localStorage Utilities
// =============================================================================

/**
 * Safely get a value from localStorage
 */
export function getFromLocalStorage<T>(key: string, defaultValue: T): T {
	if (typeof window === "undefined") {
		return defaultValue;
	}

	try {
		const stored = localStorage.getItem(key);
		if (stored === null) {
			return defaultValue;
		}
		return JSON.parse(stored) as T;
	} catch {
		console.warn(`[AgentConfig] Failed to parse localStorage key: ${key}`);
		return defaultValue;
	}
}

/**
 * Safely set a value in localStorage
 */
export function setToLocalStorage<T>(key: string, value: T): boolean {
	if (typeof window === "undefined") {
		return false;
	}

	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch (error) {
		console.error(
			`[AgentConfig] Failed to save to localStorage key: ${key}`,
			error,
		);
		return false;
	}
}

/**
 * Check if localStorage has a value for a key
 */
export function hasLocalStorageKey(key: string): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	return localStorage.getItem(key) !== null;
}

// =============================================================================
// Retry Logic with Exponential Backoff
// =============================================================================

/**
 * Execute a function with retry logic and exponential backoff
 */
export async function executeWithRetry<T>(
	fn: () => Promise<T>,
	options: {
		maxRetries: number;
		baseDelayMs?: number;
		onRetry?: (attempt: number, error: Error) => void;
	},
): Promise<T> {
	const { maxRetries, baseDelayMs = 1000, onRetry } = options;
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError =
				error instanceof Error ? error : new Error(String(error));

			if (attempt < maxRetries) {
				// Exponential backoff: 1s, 2s, 4s...
				const delay = baseDelayMs * 2 ** attempt;
				onRetry?.(attempt + 1, lastError);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	throw lastError;
}

// =============================================================================
// Notification Helpers
// =============================================================================

let syncErrorToastId: string | number | undefined;

/**
 * Show a toast notification for sync errors (deduplicated)
 */
export function showSyncError(message: string, description?: string): void {
	// Dismiss any existing sync error toast
	if (syncErrorToastId) {
		toast.dismiss(syncErrorToastId);
	}

	syncErrorToastId = toast.error(message, {
		description,
		duration: 5000,
		action: {
			label: "Retry",
			onClick: () => {
				// The parent component should handle retry via callback
				toast.dismiss(syncErrorToastId);
			},
		},
	});
}

/**
 * Show a toast notification for sync success (subtle)
 */
export function showSyncSuccess(): void {
	// Dismiss any existing sync error toast since sync succeeded
	if (syncErrorToastId) {
		toast.dismiss(syncErrorToastId);
		syncErrorToastId = undefined;
	}

	// Show subtle success only if there was a previous error
	// This avoids spamming the user with success messages
}
