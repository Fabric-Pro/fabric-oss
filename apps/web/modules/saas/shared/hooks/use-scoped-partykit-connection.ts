"use client";

import { useEffect, useRef, useState } from "react";

const RECONNECT_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
const RECOVERY_COOLDOWN_MS = 30_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
// Workers can reject credentials after onopen, so the handshake alone is not health.
const HEALTHY_CONNECTION_MS = 5000;
const MAX_UNAUTHORIZED_CLOSES = 3;

type LiveTokenResult =
	| { kind: "token"; token: string; expiresAt: number }
	| { kind: "denied" }
	| { kind: "retryable" };

type ConnectionPhase =
	| "connecting"
	| "connected"
	| "retrying"
	| "exhausted"
	| "denied"
	| "stopped";

function isLocalPartyKitHost(host: string): boolean {
	const hostname = host.startsWith("[")
		? host.slice(0, host.indexOf("]") + 1)
		: (host.split(":")[0] ?? "");
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]"
	);
}

export interface UseScopedPartyKitConnectionOptions {
	roomId: string | null;
	userId: string | undefined;
	enabled?: boolean;
	party: string;
	tokenEndpoint: string;
	buildTokenBody: (roomId: string) => Record<string, unknown>;
	/** 401/403 and any party-specific permanent refusal stop retries. */
	isTerminalTokenStatus: (status: number) => boolean;
	logTag: string;
	onMessage: (event: MessageEvent) => void;
}

export interface UseScopedPartyKitConnectionResult {
	isConnected: boolean;
}

/** Finite retry bursts recover on online/foreground events, never on auth refusals. */
export function useScopedPartyKitConnection(
	options: UseScopedPartyKitConnectionOptions,
): UseScopedPartyKitConnectionResult {
	const {
		roomId,
		userId,
		enabled = true,
		party,
		tokenEndpoint,
		buildTokenBody,
		isTerminalTokenStatus,
		logTag,
		onMessage,
	} = options;
	const [isConnected, setIsConnected] = useState(false);
	// Inline consumer callbacks must not reconnect a socket on every render.
	const callbacks = useRef({
		onMessage,
		buildTokenBody,
		isTerminalTokenStatus,
	});
	callbacks.current = { onMessage, buildTokenBody, isTerminalTokenStatus };

	useEffect(() => {
		setIsConnected(false);
		if (!roomId || !enabled) {
			return;
		}

		const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:1999";
		const isLocalHost = isLocalPartyKitHost(host);
		const resolvedUserId = userId || "anonymous";
		const requestController = new AbortController();
		let cancelled = false;
		let phase: ConnectionPhase = "connecting";
		let attempts = 0;
		let unauthorizedCloses = 0;
		let recoverAfter = 0;
		let tokenStatus: number | undefined;
		let closeCode: number | undefined;
		let wasClean: boolean | undefined;
		let socket: WebSocket | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let healthyTimer: ReturnType<typeof setTimeout> | undefined;
		// Effect ownership isolates tokens across rooms, users, parties and endpoints.
		let cachedToken: { token: string; expiresAt: number } | undefined;

		const diagnose = () => {
			console.info(`[${logTag}] Connection state`, {
				phase,
				retry: attempts,
				tokenStatus,
				closeCode,
				wasClean,
			});
		};

		const clearHealthTimer = () => {
			clearTimeout(healthyTimer);
			healthyTimer = undefined;
		};

		const markHealthy = () => {
			clearHealthTimer();
			attempts = 0;
			unauthorizedCloses = 0;
		};

		const scheduleReconnect = () => {
			if (cancelled || retryTimer !== undefined) {
				return;
			}
			const delay = RECONNECT_BACKOFF_MS[attempts];
			if (delay === undefined) {
				phase = "exhausted";
				recoverAfter = Date.now() + RECOVERY_COOLDOWN_MS;
				diagnose();
				return;
			}
			phase = "retrying";
			attempts += 1;
			diagnose();
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				void connect();
			}, delay);
		};

		const requestToken = async (): Promise<LiveTokenResult> => {
			try {
				const response = await fetch(tokenEndpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						callbacks.current.buildTokenBody(roomId),
					),
					signal: requestController.signal,
				});
				tokenStatus = response.status;
				if (response.ok) {
					const data: { token?: string; expiresIn?: number } =
						await response.json();
					if (typeof data.token !== "string" || !data.token) {
						return { kind: "retryable" };
					}
					return {
						kind: "token",
						token: data.token,
						expiresAt:
							Date.now() +
							(typeof data.expiresIn === "number"
								? data.expiresIn
								: 600) *
								1000,
					};
				}
				return callbacks.current.isTerminalTokenStatus(response.status)
					? { kind: "denied" }
					: { kind: "retryable" };
			} catch {
				tokenStatus = undefined;
				return { kind: "retryable" };
			}
		};

		const openSocket = (token: string | undefined) => {
			const params = new URLSearchParams({ userId: resolvedUserId });
			if (token) {
				params.set("token", token);
			}
			const protocol = isLocalHost ? "ws" : "wss";
			const ws = new WebSocket(
				`${protocol}://${host}/parties/${party}/${roomId}?${params}`,
			);
			socket = ws;
			ws.onopen = () => {
				if (cancelled) {
					return;
				}
				phase = "connected";
				setIsConnected(true);
				diagnose();
				healthyTimer = setTimeout(markHealthy, HEALTHY_CONNECTION_MS);
			};
			ws.onmessage = (event) => {
				if (!cancelled) {
					markHealthy();
					callbacks.current.onMessage(event);
				}
			};
			// Never log the event: it contains a socket URL carrying the live token.
			ws.onerror = () => diagnose();
			ws.onclose = (event) => {
				if (cancelled) {
					return;
				}
				socket = null;
				setIsConnected(false);
				clearHealthTimer();
				closeCode = event.code;
				wasClean = event.wasClean;
				if (event.code === 4001) {
					cachedToken = undefined;
					unauthorizedCloses += 1;
					if (unauthorizedCloses >= MAX_UNAUTHORIZED_CLOSES) {
						phase = "denied";
						diagnose();
						return;
					}
				}
				if (event.code === 1000 || event.code === 1001) {
					phase = "stopped";
					diagnose();
					return;
				}
				scheduleReconnect();
			};
		};

		async function connect() {
			phase = "connecting";
			let token =
				cachedToken &&
				cachedToken.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS
					? cachedToken.token
					: undefined;
			if (!token) {
				const result = await requestToken();
				if (cancelled) {
					return;
				}
				if (result.kind === "token") {
					cachedToken = result;
					token = result.token;
				} else if (result.kind === "denied") {
					phase = "denied";
					diagnose();
					return;
				} else if (!isLocalHost) {
					// Remote workers always require a token, including after outages.
					scheduleReconnect();
					return;
				}
			}
			openSocket(token);
		}

		const recover = () => {
			if (
				phase !== "exhausted" ||
				navigator.onLine === false ||
				document.visibilityState !== "visible"
			) {
				return;
			}
			phase = "retrying";
			retryTimer = setTimeout(
				() => {
					retryTimer = undefined;
					if (
						navigator.onLine === false ||
						document.visibilityState !== "visible"
					) {
						phase = "exhausted";
						return;
					}
					attempts = 0;
					void connect();
				},
				Math.max(0, recoverAfter - Date.now()),
			);
		};
		window.addEventListener("online", recover);
		document.addEventListener("visibilitychange", recover);
		void connect();

		return () => {
			cancelled = true;
			requestController.abort();
			window.removeEventListener("online", recover);
			document.removeEventListener("visibilitychange", recover);
			clearTimeout(retryTimer);
			clearHealthTimer();
			if (socket) {
				socket.onopen = null;
				socket.onmessage = null;
				socket.onclose = null;
				socket.onerror = null;
				socket.close(1000, "Connection scope ended");
			}
		};
	}, [roomId, userId, enabled, party, tokenEndpoint, logTag]);

	return { isConnected };
}
