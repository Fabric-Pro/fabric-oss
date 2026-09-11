/**
 * useCollaborativeEditor Hook
 *
 * Provides real-time collaborative editing via PartyKit + Yjs.
 * Manages the Yjs document, PartyKit provider connection, and collaborator tracking.
 */

"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useEffect, useMemo, useRef, useState } from "react";
import YPartyKitProvider from "y-partykit/provider";
import * as Y from "yjs";

interface CollaboratorInfo {
	name: string;
	color: string;
	image?: string;
}

interface UseCollaborativeEditorOptions {
	documentId: string;
	projectId: string;
	enabled?: boolean;
}

interface UseCollaborativeEditorResult {
	ydoc: Y.Doc | null;
	provider: YPartyKitProvider | null;
	isConnected: boolean;
	isSynced: boolean;
	collaborators: CollaboratorInfo[];
	userColor: string;
}

interface CollaborationToken {
	value: string;
}

/** Consecutive credential rejections tolerated before keeping the editor offline. */
const MAX_UNAUTHORIZED_CLOSES = 3;

/** Recovery-only retry schedule for transient token endpoint failures. */
const TOKEN_REFRESH_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

// Color palette for user cursors - saturated colors optimized for white text
// Only yellow uses black text, all others use white for better readability
const CURSOR_COLORS = [
	"#DC2626", // Red-600 (white text)
	"#EA580C", // Orange-600 (white text)
	"#FACC15", // Yellow-400 (black text - very light)
	"#16A34A", // Green-600 (white text)
	"#0D9488", // Teal-600 (white text)
	"#0891B2", // Cyan-600 (white text)
	"#2563EB", // Blue-600 (white text)
	"#7C3AED", // Violet-600 (white text)
	"#DB2777", // Pink-600 (white text)
	"#E11D48", // Rose-600 (white text)
	"#9333EA", // Purple-600 (white text)
	"#C026D3", // Fuchsia-600 (white text)
];

/**
 * Generate a consistent color for a user based on their ID
 */
function generateUserColor(userId: string): string {
	const hash = userId.split("").reduce((a, b) => a + b.charCodeAt(0), 0);
	return CURSOR_COLORS[hash % CURSOR_COLORS.length] as string;
}

export function useCollaborativeEditor(
	options: UseCollaborativeEditorOptions,
): UseCollaborativeEditorResult {
	const { documentId, projectId: _projectId, enabled = true } = options;
	const { user } = useSession();

	const [isConnected, setIsConnected] = useState(false);
	const [isSynced, setIsSynced] = useState(false);
	const [collaborators, setCollaborators] = useState<
		Map<number, CollaboratorInfo>
	>(new Map());
	const [token, setToken] = useState<CollaborationToken | null>(null);
	const [tokenRefreshTrigger, setTokenRefreshTrigger] = useState(0);
	const [provider, setProvider] = useState<YPartyKitProvider | null>(null);
	const unauthorizedClosesRef = useRef(0);
	const tokenRefreshAttemptsRef = useRef(0);
	const tokenRefreshRetryTimeoutRef = useRef<ReturnType<
		typeof setTimeout
	> | null>(null);
	const authRecoveryPendingRef = useRef(false);

	// Check if we're on the client - Yjs doesn't work on the server
	const isClient = typeof window !== "undefined";

	// Create Yjs document only on client side - use useState with lazy init
	// to ensure stable reference and avoid SSR issues
	const [ydoc] = useState<Y.Doc | null>(() => {
		if (!isClient) {
			return null;
		}
		return new Y.Doc();
	});

	// A document or session change starts a distinct connection lifecycle, so a
	// prior room's rejection budget cannot leave the new one disconnected.
	useEffect(() => {
		unauthorizedClosesRef.current = 0;
		tokenRefreshAttemptsRef.current = 0;
		authRecoveryPendingRef.current = false;
		if (tokenRefreshRetryTimeoutRef.current) {
			clearTimeout(tokenRefreshRetryTimeoutRef.current);
			tokenRefreshRetryTimeoutRef.current = null;
		}
	}, [documentId, enabled, user?.id]);

	// Generate user color
	const userColor = useMemo(
		// biome-ignore lint/style/noNonNullAssertion: CURSOR_COLORS array is non-empty
		() => (user?.id ? generateUserColor(user.id) : CURSOR_COLORS[0]!),
		[user?.id],
	);

	// Fetch collaboration token
	useEffect(() => {
		console.log(
			"[useCollaborativeEditor] Token effect - enabled:",
			enabled,
			"user:",
			!!user,
			"isClient:",
			isClient,
		);
		if (!isClient || !enabled || !user) {
			setToken(null);
			return;
		}

		let cancelled = false;

		const scheduleTokenRefreshRetry = () => {
			if (cancelled || !authRecoveryPendingRef.current) {
				return;
			}

			const delay =
				TOKEN_REFRESH_BACKOFF_MS[tokenRefreshAttemptsRef.current];
			if (delay === undefined) {
				console.warn(
					"[useCollaborativeEditor] Token recovery budget exhausted, staying disconnected",
				);
				authRecoveryPendingRef.current = false;
				return;
			}

			tokenRefreshAttemptsRef.current += 1;
			tokenRefreshRetryTimeoutRef.current = setTimeout(() => {
				tokenRefreshRetryTimeoutRef.current = null;
				if (!cancelled && authRecoveryPendingRef.current) {
					setTokenRefreshTrigger((current) => current + 1);
				}
			}, delay);
		};

		async function getToken() {
			try {
				console.log(
					"[useCollaborativeEditor] Fetching token for document:",
					documentId,
				);
				const response = await fetch("/api/collab/token", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ documentId }),
				});
				if (cancelled) {
					return;
				}

				if (!response.ok) {
					console.error(
						"[useCollaborativeEditor] Failed to get token:",
						response.status,
						response.statusText,
					);
					if (response.status === 401 || response.status === 403) {
						authRecoveryPendingRef.current = false;
						tokenRefreshAttemptsRef.current = 0;
					} else if (response.status >= 500) {
						scheduleTokenRefreshRetry();
					}
					return;
				}

				const data = await response.json();
				console.log(
					"[useCollaborativeEditor] Token received successfully",
				);
				if (!cancelled) {
					authRecoveryPendingRef.current = false;
					tokenRefreshAttemptsRef.current = 0;
					// Store an object so a forced recovery replaces the provider even
					// if the token endpoint returns the same string.
					setToken({ value: data.token });
				}
			} catch (error) {
				console.error(
					"[useCollaborativeEditor] Token fetch error:",
					error,
				);
				scheduleTokenRefreshRetry();
			}
		}

		getToken();

		// Refresh token before expiry (every 50 minutes)
		const refreshInterval = setInterval(getToken, 50 * 60 * 1000);

		return () => {
			cancelled = true;
			clearInterval(refreshInterval);
			if (tokenRefreshRetryTimeoutRef.current) {
				clearTimeout(tokenRefreshRetryTimeoutRef.current);
				tokenRefreshRetryTimeoutRef.current = null;
			}
		};
	}, [documentId, enabled, user, isClient, tokenRefreshTrigger]);

	// Create PartyKit provider
	useEffect(() => {
		console.log(
			"[useCollaborativeEditor] Provider effect - token:",
			!!token,
			"enabled:",
			enabled,
			"ydoc:",
			!!ydoc,
		);

		if (!token || !enabled || !ydoc) {
			setProvider(null);
			setIsConnected(false);
			setIsSynced(false);
			return;
		}

		const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:1999";

		console.log(
			"[useCollaborativeEditor] Creating provider for:",
			documentId,
			"host:",
			host,
		);

		// Track connection state - define handlers first
		const handleStatus = ({ status }: { status: string }) => {
			console.log("[useCollaborativeEditor] Status event:", status);
			// Y-PartyKit uses 'connected' for connected and 'disconnected' for disconnected
			setIsConnected(status === "connected");
			// Reset synced state when disconnected
			if (status === "disconnected") {
				setIsSynced(false);
			}
		};

		const handleSync = (synced: boolean) => {
			console.log("[useCollaborativeEditor] Sync event:", synced);
			setIsSynced(synced);
			if (synced) {
				// The worker authorizes after opening the socket. A completed sync,
				// unlike the "connected" status, proves this credential was accepted.
				unauthorizedClosesRef.current = 0;
			}
		};

		// Handle connection errors
		const _handleConnectionError = (error: Error) => {
			console.error("[useCollaborativeEditor] Connection error:", error);
			setIsConnected(false);
			setIsSynced(false);
		};

		// Create the provider with token in params
		// Don't auto-connect yet so we can attach handlers first
		const newProvider = new YPartyKitProvider(host, documentId, ydoc, {
			connect: false, // Don't connect immediately
			params: { token: token.value },
		});

		let handledUnauthorizedClose = false;
		const handleConnectionClose = (event: CloseEvent) => {
			if (event.code !== 4001 || handledUnauthorizedClose) {
				return;
			}
			handledUnauthorizedClose = true;
			// y-partykit reconnects with its original URL. Stop it before asking
			// for a new credential so it cannot replay the rejected token.
			newProvider.off("connection-close", handleConnectionClose);
			newProvider.destroy();
			setProvider((current) =>
				current === newProvider ? null : current,
			);
			setIsConnected(false);
			setIsSynced(false);
			setCollaborators(new Map());

			unauthorizedClosesRef.current += 1;
			if (unauthorizedClosesRef.current >= MAX_UNAUTHORIZED_CLOSES) {
				authRecoveryPendingRef.current = false;
				if (tokenRefreshRetryTimeoutRef.current) {
					clearTimeout(tokenRefreshRetryTimeoutRef.current);
					tokenRefreshRetryTimeoutRef.current = null;
				}
				console.warn(
					"[useCollaborativeEditor] Worker rejected the connection repeatedly, giving up",
				);
				return;
			}

			authRecoveryPendingRef.current = true;
			tokenRefreshAttemptsRef.current = 0;
			setTokenRefreshTrigger((current) => current + 1);
		};

		// Attach event handlers BEFORE connecting
		newProvider.on("status", handleStatus);
		newProvider.on("sync", handleSync);
		newProvider.on("connection-close", handleConnectionClose);
		// Note: y-partykit doesn't have a direct 'error' event,
		// but we can handle WebSocket errors through status changes

		// Set local user info in awareness
		if (user) {
			newProvider.awareness.setLocalStateField("user", {
				name: user.name || "Anonymous",
				color: userColor,
				image: user.image,
			});
		}

		// Track remote users via awareness
		const handleAwarenessChange = () => {
			const states = newProvider.awareness.getStates();
			const newCollaborators = new Map<number, CollaboratorInfo>();

			states.forEach((state, clientId) => {
				if (clientId !== newProvider.awareness.clientID && state.user) {
					newCollaborators.set(
						clientId,
						state.user as CollaboratorInfo,
					);
				}
			});

			console.log(
				"[useCollaborativeEditor] Awareness change - collaborators:",
				newCollaborators.size,
			);
			setCollaborators(newCollaborators);
		};

		newProvider.awareness.on("change", handleAwarenessChange);
		handleAwarenessChange(); // Initial state

		// Now connect and set the provider state
		console.log("[useCollaborativeEditor] Connecting to PartyKit...");
		newProvider.connect();
		setProvider(newProvider);

		return () => {
			console.log("[useCollaborativeEditor] Cleaning up provider");
			newProvider.off("status", handleStatus);
			newProvider.off("sync", handleSync);
			newProvider.off("connection-close", handleConnectionClose);
			newProvider.awareness.off("change", handleAwarenessChange);
			newProvider.destroy();
			setProvider(null);
			setIsConnected(false);
			setIsSynced(false);
			setCollaborators(new Map());
		};
	}, [token, documentId, ydoc, enabled, user, userColor]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			ydoc?.destroy();
		};
	}, [ydoc]);

	return {
		ydoc,
		provider,
		isConnected,
		isSynced,
		// Ensure we always return an array, even if collaborators state is in an unexpected state
		collaborators: collaborators ? Array.from(collaborators.values()) : [],
		userColor,
	};
}
