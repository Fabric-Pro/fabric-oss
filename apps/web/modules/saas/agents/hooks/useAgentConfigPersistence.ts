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

export const ORGANIZATION_STORAGE_KEYS = [
	STORAGE_KEYS.AGENTS,
	STORAGE_KEYS.MCP,
	STORAGE_KEYS.WORKSPACES,
	STORAGE_KEYS.INTEGRATIONS,
	STORAGE_KEYS.PRIORITIZED_AGENTS,
	STORAGE_KEYS.PRIORITIZED_MCP,
	STORAGE_KEYS.PRIORITIZED_INTEGRATIONS,
] as const;

export function getOrganizationStorageKey(
	base: (typeof ORGANIZATION_STORAGE_KEYS)[number],
	organizationId: string | null | undefined,
	userId: string | null | undefined,
): string | null {
	return organizationId && userId
		? `${base}:${userId}:${organizationId}`
		: null;
}

export function removeLegacyOrganizationStorage(): void {
	if (typeof window === "undefined") {
		return;
	}
	for (const key of ORGANIZATION_STORAGE_KEYS) {
		try {
			localStorage.removeItem(key);
		} catch {
			// Storage may be unavailable; scoped reads still ignore legacy entries.
		}
	}
}

// =============================================================================
// localStorage Utilities
// =============================================================================

/**
 * Safely get a value from localStorage
 */
export function getFromLocalStorage<T>(key: string | null, defaultValue: T): T {
	if (key === null || typeof window === "undefined") {
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
export function setToLocalStorage<T>(key: string | null, value: T): boolean {
	if (key === null || typeof window === "undefined") {
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
export function hasLocalStorageKey(key: string | null): boolean {
	if (key === null || typeof window === "undefined") {
		return false;
	}
	try {
		return localStorage.getItem(key) !== null;
	} catch {
		return false;
	}
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

const syncErrorToastIds = new Map<string, string | number>();

/**
 * Show a toast notification for sync errors (deduplicated)
 */
export function showSyncError(
	message: string,
	description?: string,
	onRetry?: () => void,
	key = "default",
): void {
	dismissSyncError(key);
	const id = toast.error(message, {
		description,
		duration: Number.POSITIVE_INFINITY,
		action: onRetry
			? {
					label: "Retry",
					onClick: (event) => {
						// Sonner dismisses action toasts unless the event is prevented.
						event.preventDefault();
						onRetry?.();
					},
				}
			: undefined,
	});
	syncErrorToastIds.set(key, id);
}

export function dismissSyncError(key = "default"): void {
	const id = syncErrorToastIds.get(key);
	if (id !== undefined) {
		toast.dismiss(id);
		syncErrorToastIds.delete(key);
	}
}

/**
 * Show a toast notification for sync success (subtle)
 */
export function showSyncSuccess(key = "default"): void {
	dismissSyncError(key);
	// Avoid spamming success messages for background saves.
}
