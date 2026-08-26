"use client";

/**
 * useProjectPresence Hook
 *
 * Manages user presence in a project with automatic join/leave/heartbeat.
 * Wraps useProjectRealtime with presence lifecycle management.
 */

import { useEffect, useRef } from "react";
import {
	type ActiveUser,
	type ActivityEvent,
	type ConnectionStatus,
	type ContextChangeEvent,
	type DocumentChangeEvent,
	useProjectRealtime,
} from "./useProjectRealtime";

const HEARTBEAT_INTERVAL_MS = 120000; // 2 minutes

interface UseProjectPresenceOptions {
	projectId: string;
	activeTab?: string;
	editingDocId?: string;
	enabled?: boolean;
	onDocumentChange?: (event: DocumentChangeEvent) => void;
	onContextChange?: (event: ContextChangeEvent) => void;
	onActivity?: (event: ActivityEvent) => void;
}

interface UseProjectPresenceReturn {
	activeUsers: ActiveUser[];
	recentActivity: ActivityEvent[];
	status: ConnectionStatus;
	isConnected: boolean;
}

export function useProjectPresence(
	options: UseProjectPresenceOptions,
): UseProjectPresenceReturn {
	const {
		projectId,
		activeTab,
		editingDocId,
		enabled = true,
		onDocumentChange,
		onContextChange,
		onActivity,
	} = options;

	const hasJoined = useRef(false);
	const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);

	const { activeUsers, recentActivity, status, sendPresence } =
		useProjectRealtime({
			projectId,
			enabled,
			onDocumentChange,
			onContextChange,
			onActivity,
		});

	// Join on mount, leave on unmount
	useEffect(() => {
		if (!enabled || !projectId) {
			return;
		}

		// Send join event
		if (!hasJoined.current) {
			sendPresence("join", activeTab, editingDocId);
			hasJoined.current = true;
		}

		return () => {
			// Send leave event on unmount
			if (hasJoined.current) {
				sendPresence("leave");
				hasJoined.current = false;
			}
		};
	}, [enabled, projectId, sendPresence, activeTab, editingDocId]);

	// Heartbeat to maintain presence
	useEffect(() => {
		if (!enabled || !projectId) {
			return;
		}

		heartbeatIntervalRef.current = setInterval(() => {
			if (hasJoined.current) {
				sendPresence("heartbeat", activeTab, editingDocId);
			}
		}, HEARTBEAT_INTERVAL_MS);

		return () => {
			if (heartbeatIntervalRef.current) {
				clearInterval(heartbeatIntervalRef.current);
			}
		};
	}, [enabled, projectId, sendPresence, activeTab, editingDocId]);

	// Update presence when tab or editing document changes
	useEffect(() => {
		if (hasJoined.current && enabled) {
			sendPresence("heartbeat", activeTab, editingDocId);
		}
	}, [activeTab, editingDocId, sendPresence, enabled]);

	// Handle page visibility changes
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible" && hasJoined.current) {
				// Re-announce presence when page becomes visible
				sendPresence("heartbeat", activeTab, editingDocId);
			}
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			document.removeEventListener(
				"visibilitychange",
				handleVisibilityChange,
			);
		};
	}, [sendPresence, activeTab, editingDocId]);

	// Handle beforeunload to send leave event
	useEffect(() => {
		const handleBeforeUnload = () => {
			if (hasJoined.current) {
				// Use sendBeacon for reliable delivery during page unload
				const data = JSON.stringify({ action: "leave" });
				navigator.sendBeacon(
					`/api/projects/${projectId}/presence`,
					new Blob([data], { type: "application/json" }),
				);
			}
		};

		window.addEventListener("beforeunload", handleBeforeUnload);

		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
		};
	}, [projectId]);

	return {
		activeUsers,
		recentActivity,
		status,
		isConnected: status === "connected",
	};
}
