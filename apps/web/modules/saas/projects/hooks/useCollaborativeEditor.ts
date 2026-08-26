/**
 * useCollaborativeEditor Hook
 *
 * Provides real-time collaborative editing via PartyKit + Yjs.
 * Manages the Yjs document, PartyKit provider connection, and collaborator tracking.
 */

"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useEffect, useMemo, useState } from "react";
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
	const [token, setToken] = useState<string | null>(null);
	const [provider, setProvider] = useState<YPartyKitProvider | null>(null);

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

				if (!response.ok) {
					console.error(
						"[useCollaborativeEditor] Failed to get token:",
						response.status,
						response.statusText,
					);
					return;
				}

				const data = await response.json();
				console.log(
					"[useCollaborativeEditor] Token received successfully",
				);
				if (!cancelled) {
					setToken(data.token);
				}
			} catch (error) {
				console.error(
					"[useCollaborativeEditor] Token fetch error:",
					error,
				);
			}
		}

		getToken();

		// Refresh token before expiry (every 50 minutes)
		const refreshInterval = setInterval(getToken, 50 * 60 * 1000);

		return () => {
			cancelled = true;
			clearInterval(refreshInterval);
		};
	}, [documentId, enabled, user, isClient]);

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
			params: { token },
		});

		// Attach event handlers BEFORE connecting
		newProvider.on("status", handleStatus);
		newProvider.on("sync", handleSync);
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
