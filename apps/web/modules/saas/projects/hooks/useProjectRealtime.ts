"use client";

/**
 * useProjectRealtime Hook
 *
 * Provides real-time updates for a project using Server-Sent Events (SSE).
 * Connects to the project's realtime endpoint and handles incoming events.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type PresenceAction = "join" | "leave" | "heartbeat";

export interface ActiveUser {
	userId: string;
	userName: string;
	userImage?: string;
	activeTab?: string;
	editingDocId?: string;
	lastSeen: Date;
}

interface PresenceUpdateEvent {
	projectId: string;
	userId: string;
	userName: string;
	userImage?: string;
	action: PresenceAction;
	activeTab?: string;
	editingDocId?: string;
}

export interface DocumentChangeEvent {
	projectId: string;
	documentId: string;
	action: "created" | "updated" | "deleted";
	userId: string;
	userName: string;
	documentType?: string;
	documentTitle?: string;
}

export interface ContextChangeEvent {
	projectId: string;
	contextId: string;
	action: "added" | "updated" | "deleted";
	userId: string;
	userName: string;
	contextType?: string;
	contextName?: string;
}

interface LockUpdateEvent {
	projectId: string;
	documentId: string;
	lockedBy: string | null;
	lockedByName?: string;
	lockedAt?: string;
}

export interface ActivityEvent {
	projectId: string;
	userId: string;
	userName: string;
	activityType: string;
	resourceType?: string;
	resourceId?: string;
	resourceName?: string;
	timestamp: string;
}

export type ConnectionStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "error";

interface UseProjectRealtimeOptions {
	projectId: string;
	onPresenceUpdate?: (event: PresenceUpdateEvent) => void;
	onDocumentChange?: (event: DocumentChangeEvent) => void;
	onContextChange?: (event: ContextChangeEvent) => void;
	onLockUpdate?: (event: LockUpdateEvent) => void;
	onActivity?: (event: ActivityEvent) => void;
	enabled?: boolean;
}

interface UseProjectRealtimeReturn {
	activeUsers: ActiveUser[];
	recentActivity: ActivityEvent[];
	status: ConnectionStatus;
	sendPresence: (
		action: PresenceAction,
		activeTab?: string,
		editingDocId?: string,
	) => Promise<void>;
}

const STALE_USER_THRESHOLD_MS = 30000; // 30 seconds
const CLEANUP_INTERVAL_MS = 10000; // 10 seconds
const RECONNECT_DELAY_MS = 3000; // 3 seconds

export function useProjectRealtime(
	options: UseProjectRealtimeOptions,
): UseProjectRealtimeReturn {
	const {
		projectId,
		onPresenceUpdate,
		onDocumentChange,
		onContextChange,
		onLockUpdate,
		onActivity,
		enabled = true,
	} = options;

	const [activeUsers, setActiveUsers] = useState<Map<string, ActiveUser>>(
		new Map(),
	);
	const [recentActivity, setRecentActivity] = useState<ActivityEvent[]>([]);
	const [status, setStatus] = useState<ConnectionStatus>("disconnected");

	const eventSourceRef = useRef<EventSource | null>(null);
	const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const cleanupIntervalRef = useRef<NodeJS.Timeout | null>(null);

	// Handle incoming SSE events
	const handleEvent = useCallback(
		(event: MessageEvent) => {
			try {
				const data = JSON.parse(event.data);

				// Handle different event types
				switch (data.event) {
					case "presence_update": {
						const payload = data.data as PresenceUpdateEvent;
						setActiveUsers((prev) => {
							const next = new Map(prev);
							if (payload.action === "leave") {
								next.delete(payload.userId);
							} else {
								next.set(payload.userId, {
									userId: payload.userId,
									userName: payload.userName,
									userImage: payload.userImage,
									activeTab: payload.activeTab,
									editingDocId: payload.editingDocId,
									lastSeen: new Date(),
								});
							}
							return next;
						});
						onPresenceUpdate?.(payload);
						break;
					}

					case "document_change": {
						const payload = data.data as DocumentChangeEvent;
						onDocumentChange?.(payload);
						break;
					}

					case "context_change": {
						const payload = data.data as ContextChangeEvent;
						onContextChange?.(payload);
						break;
					}

					case "lock_update": {
						const payload = data.data as LockUpdateEvent;
						onLockUpdate?.(payload);
						break;
					}

					case "activity": {
						const payload = data.data as ActivityEvent;
						setRecentActivity((prev) =>
							[payload, ...prev].slice(0, 20),
						);
						onActivity?.(payload);
						break;
					}
				}
			} catch (error) {
				console.error(
					"[useProjectRealtime] Failed to parse event:",
					error,
				);
			}
		},
		[
			onPresenceUpdate,
			onDocumentChange,
			onContextChange,
			onLockUpdate,
			onActivity,
		],
	);

	// Connect to SSE endpoint
	const connect = useCallback(() => {
		if (!enabled || !projectId) {
			return;
		}

		// Close existing connection
		if (eventSourceRef.current) {
			eventSourceRef.current.close();
		}

		setStatus("connecting");

		const url = `/api/projects/${projectId}/realtime`;
		const eventSource = new EventSource(url, { withCredentials: true });

		eventSource.onopen = () => {
			setStatus("connected");
			// A successful open means the service is healthy. Reset the
			// reconnect budget so normal stream-expiry cycles (the SSE
			// endpoint closes at ~4.5 min (server closes at ~268s by
			// design) and expects a reconnect) don't accumulate toward
			// the cap and permanently disable realtime. The cap then
			// only trips on CONSECUTIVE failures — i.e. a genuinely
			// unavailable service.
			sessionStorage.removeItem(`reconnect_attempts_${projectId}`);
			console.log("[useProjectRealtime] Connected to", projectId);
		};

		eventSource.onmessage = handleEvent;

		eventSource.onerror = (_error) => {
			// EventSource fires `onerror` both on genuine failures (e.g. a 503
			// when Redis isn't configured) AND on the SSE endpoint's expected
			// ~4.5 min (server closes at ~268s by design) stream expiry. We
			// can't tell them apart here, so treat a drop as routine and
			// reconnect — only the reconnect budget being exhausted
			// (consecutive failures, no successful open in between) signals
			// that realtime is genuinely unavailable.
			setStatus("disconnected");
			eventSource.close();

			// Only attempt to reconnect a few times, then give up
			// This prevents infinite reconnection loops when Redis isn't configured
			const maxReconnectAttempts = 3;
			const attemptKey = `reconnect_attempts_${projectId}`;
			const attempts = Number.parseInt(
				sessionStorage.getItem(attemptKey) || "0",
				10,
			);

			if (attempts < maxReconnectAttempts) {
				sessionStorage.setItem(attemptKey, String(attempts + 1));
				if (reconnectTimeoutRef.current) {
					clearTimeout(reconnectTimeoutRef.current);
				}
				reconnectTimeoutRef.current = setTimeout(
					() => {
						console.log(
							"[useProjectRealtime] Reconnecting...",
							attempts + 1,
						);
						connect();
					},
					RECONNECT_DELAY_MS * (attempts + 1),
				); // Exponential backoff
			} else {
				console.warn(
					`[useProjectRealtime] Realtime unavailable after ${maxReconnectAttempts} reconnect attempts — giving up until the connection is re-established`,
				);
				sessionStorage.removeItem(attemptKey);
			}
		};

		eventSourceRef.current = eventSource;
	}, [projectId, enabled, handleEvent]);

	// Disconnect from SSE endpoint
	const disconnect = useCallback(() => {
		if (eventSourceRef.current) {
			eventSourceRef.current.close();
			eventSourceRef.current = null;
		}
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
			reconnectTimeoutRef.current = null;
		}
		setStatus("disconnected");
	}, []);

	// Send presence update
	const sendPresence = useCallback(
		async (
			action: PresenceAction,
			activeTab?: string,
			editingDocId?: string,
		) => {
			if (!projectId) {
				return;
			}

			try {
				await fetch(`/api/projects/${projectId}/presence`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					credentials: "include",
					body: JSON.stringify({ action, activeTab, editingDocId }),
				});
			} catch (error) {
				console.error(
					"[useProjectRealtime] Failed to send presence:",
					error,
				);
			}
		},
		[projectId],
	);

	// Connect on mount, disconnect on unmount
	useEffect(() => {
		if (enabled) {
			connect();
		}

		return () => {
			disconnect();
		};
	}, [enabled, connect, disconnect]);

	// Clean up stale users periodically
	useEffect(() => {
		cleanupIntervalRef.current = setInterval(() => {
			const now = Date.now();
			setActiveUsers((prev) => {
				const next = new Map(prev);
				let hasChanges = false;
				for (const [userId, user] of next) {
					if (
						now - user.lastSeen.getTime() >
						STALE_USER_THRESHOLD_MS
					) {
						next.delete(userId);
						hasChanges = true;
					}
				}
				return hasChanges ? next : prev;
			});
		}, CLEANUP_INTERVAL_MS);

		return () => {
			if (cleanupIntervalRef.current) {
				clearInterval(cleanupIntervalRef.current);
			}
		};
	}, []);

	return {
		activeUsers: Array.from(activeUsers.values()),
		recentActivity,
		status,
		sendPresence,
	};
}
