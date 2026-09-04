"use client";

/**
 * useProjectPresence Hook
 *
 * Manages user presence in a project with automatic join/leave/heartbeat.
 * Wraps useProjectRealtime with presence lifecycle management.
 */

import { useCallback, useEffect, useRef } from "react";
import {
	type ActiveUser,
	type ActivityEvent,
	type ConnectionStatus,
	type ContextChangeEvent,
	type DocumentChangeEvent,
	useProjectRealtime,
} from "./useProjectRealtime";

const HEARTBEAT_INTERVAL_MS = 120000; // 2 minutes

/**
 * How long to wait after `activeTab` / `editingDocId` changes before telling
 * the server. On a cold project load the active tab settles through several
 * intermediate values as the tab-config queries resolve; without coalescing,
 * each step is its own POST.
 */
const PRESENCE_UPDATE_DEBOUNCE_MS = 300;

interface UseProjectPresenceOptions {
	projectId: string;
	activeTab?: string;
	editingDocId?: string;
	enabled?: boolean;
	onDocumentChange?: (event: DocumentChangeEvent) => void;
	onContextChange?: (event: ContextChangeEvent) => void;
	onActivity?: (event: ActivityEvent) => void;
}

export interface UseProjectPresenceReturn {
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

	// The join / heartbeat / visibility effects read the CURRENT tab and doc
	// through refs rather than listing them as dependencies. Listing them
	// re-ran the join effect on every tab change, whose cleanup sent `leave`
	// and whose body sent `join` again — three POSTs per tab switch, and ~20
	// on a cold load while the active tab was still settling. Only the
	// debounced update effect below reacts to those values changing.
	const activeTabRef = useRef(activeTab);
	activeTabRef.current = activeTab;
	const editingDocIdRef = useRef(editingDocId);
	editingDocIdRef.current = editingDocId;

	// The tab/doc pair the server last heard from us. Every join or heartbeat
	// goes through `announce`, which records what it sent, so the update
	// effect can skip values the server already has: its own first run on
	// mount, a change that reverts before the debounce elapses, or a change an
	// interval / visibility heartbeat happened to carry first.
	const lastReportedRef = useRef({ activeTab, editingDocId });

	const { activeUsers, recentActivity, status, sendPresence } =
		useProjectRealtime({
			projectId,
			enabled,
			onDocumentChange,
			onContextChange,
			onActivity,
		});

	// The single path for anything that carries the tab/doc pair. Reads the
	// current values from the refs and records them as reported.
	const announce = useCallback(
		(action: "join" | "heartbeat") => {
			const current = {
				activeTab: activeTabRef.current,
				editingDocId: editingDocIdRef.current,
			};
			lastReportedRef.current = current;
			sendPresence(action, current.activeTab, current.editingDocId);
		},
		[sendPresence],
	);

	// Join on mount, leave on unmount
	useEffect(() => {
		if (!enabled || !projectId) {
			return;
		}

		// Send join event
		if (!hasJoined.current) {
			announce("join");
			hasJoined.current = true;
		}

		return () => {
			// Send leave event on unmount
			if (hasJoined.current) {
				sendPresence("leave");
				hasJoined.current = false;
			}
		};
	}, [enabled, projectId, announce, sendPresence]);

	// Heartbeat to maintain presence
	useEffect(() => {
		if (!enabled || !projectId) {
			return;
		}

		heartbeatIntervalRef.current = setInterval(() => {
			if (hasJoined.current) {
				announce("heartbeat");
			}
		}, HEARTBEAT_INTERVAL_MS);

		return () => {
			if (heartbeatIntervalRef.current) {
				clearInterval(heartbeatIntervalRef.current);
			}
		};
	}, [enabled, projectId, announce]);

	// Update presence when tab or editing document changes. Debounced so a
	// burst of changes (tab settling on load, quick tab flips) sends only the
	// final value; the timer is cleared if the value changes again first.
	//
	// Compares against the values last REPORTED, not "has the effect run
	// before": the effect also runs on mount, right after the join effect has
	// already sent these same values, and a mount-time heartbeat would be a
	// second POST for nothing. A cancelled timer leaves the last-reported pair
	// untouched, so the next change is still compared against what the server
	// actually knows. The check repeats when the timer fires, because an
	// interval or visibility heartbeat may have carried the pair meanwhile.
	useEffect(() => {
		if (!enabled) {
			return;
		}
		const isReported = () =>
			lastReportedRef.current.activeTab === activeTab &&
			lastReportedRef.current.editingDocId === editingDocId;
		if (isReported()) {
			return;
		}

		const timer = setTimeout(() => {
			if (hasJoined.current && !isReported()) {
				announce("heartbeat");
			}
		}, PRESENCE_UPDATE_DEBOUNCE_MS);

		return () => {
			clearTimeout(timer);
		};
	}, [activeTab, editingDocId, announce, enabled]);

	// Handle page visibility changes
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible" && hasJoined.current) {
				// Re-announce presence when page becomes visible
				announce("heartbeat");
			}
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			document.removeEventListener(
				"visibilitychange",
				handleVisibilityChange,
			);
		};
	}, [announce]);

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
