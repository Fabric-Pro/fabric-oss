"use client";

/**
 * useScopedPartyKitConnection
 *
 * The connection machinery shared by every per-feature PartyKit hook: the live
 * token handshake, the bounded reconnect budget, the health promotion that
 * decides when a socket has proven itself, and the dev-only token-less
 * fallback. Feature hooks wrap this and keep only their own message parsing
 * and domain state.
 */

import { useEffect, useRef, useState } from "react";

/**
 * Backoff schedule for reconnects. WebSocket closes and retryable token
 * failures share this budget, so a room that keeps rejecting us cannot spin
 * either path. Exhausting it leaves the connection down — each consumer has a
 * polling or streaming fallback that keeps its UI moving meanwhile.
 */
const RECONNECT_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

/** Re-fetch rather than reuse a token that could expire mid-handshake. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * A socket only counts as healthy once it delivers a message or stays open this
 * long. The worker authorizes inside onConnect and closes 4001 *after* the
 * handshake, so onopen on its own proves nothing.
 */
const HEALTHY_CONNECTION_MS = 5000;

/** Consecutive worker rejections tolerated before giving up on the room. */
const MAX_UNAUTHORIZED_CLOSES = 3;

type LiveTokenResult =
	| { kind: "token"; token: string; expiresAt: number }
	| { kind: "denied"; status: number }
	// `transport` marks failures that are purely infrastructural (network error
	// or 5xx). Any status the server actually chose is a decision: still worth
	// retrying, but it must never end in a token-less connect to a remote host.
	| { kind: "retryable"; transport: boolean };

/**
 * Only a local worker may be connected to without a token: the dev branch of
 * the party-cf workers still trusts the userId param, production never does.
 * Also decides ws vs wss below.
 */
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
	/** PartyKit room to join. Null keeps the hook disconnected. */
	roomId: string | null;
	/** Session user id. Undefined connects as "anonymous". */
	userId: string | undefined;
	enabled?: boolean;
	/** Party path segment, e.g. "orchestrator" in /parties/orchestrator/{room}. */
	party: string;
	/** Route that mints the live token for this party. */
	tokenEndpoint: string;
	/** JSON body for the token request — each party names the room differently. */
	buildTokenBody: (roomId: string) => Record<string, unknown>;
	/**
	 * Classifies a non-OK token response. `true` stops the hook: the server has
	 * decided this caller gets no token for this room. `false` keeps it on the
	 * retry budget. 401/403 are terminal for every party; 404 is not — whether a
	 * missing row means "no such room" or "not written yet" is party-specific.
	 */
	isTerminalTokenStatus: (status: number) => boolean;
	/** Prefix for this hook's console messages, without brackets. */
	logTag: string;
	/** Called for every socket message. May be a fresh closure on each render. */
	onMessage: (event: MessageEvent) => void;
}

export interface UseScopedPartyKitConnectionResult {
	isConnected: boolean;
}

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

	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const [reconnectTrigger, setReconnectTrigger] = useState(0);
	// The live token lives in a ref, not state: a fetch that set state would
	// re-run the socket effect, which would fetch again. Keyed by room AND user
	// so a session switch can never reuse the previous user's token.
	const tokenRef = useRef<{
		roomId: string;
		userId: string;
		token: string;
		expiresAt: number;
	} | null>(null);
	const reconnectAttemptsRef = useRef(0);
	const unauthorizedClosesRef = useRef(0);
	const healthyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	// Cleared as soon as a token failure is anything other than transport/5xx,
	// which disqualifies the token-less fallback for this room.
	const tokenFallbackEligibleRef = useRef(true);

	// Consumers pass inline closures, so depending on them directly would tear
	// down and rebuild the socket on each parent render — replaying every stored
	// message. Reading them from refs keeps the socket effect keyed on the room.
	const onMessageRef = useRef(onMessage);
	const buildTokenBodyRef = useRef(buildTokenBody);
	const isTerminalTokenStatusRef = useRef(isTerminalTokenStatus);
	onMessageRef.current = onMessage;
	buildTokenBodyRef.current = buildTokenBody;
	isTerminalTokenStatusRef.current = isTerminalTokenStatus;

	// Reset per-room / per-user connection state. Declared before the socket
	// effect so it runs first when either changes. The cached token needs no
	// clearing here: it carries its own room and user and is only used when both
	// still match.
	useEffect(() => {
		reconnectAttemptsRef.current = 0;
		unauthorizedClosesRef.current = 0;
		tokenFallbackEligibleRef.current = true;
	}, [roomId, userId]);

	useEffect(() => {
		if (!roomId || !enabled) {
			if (wsRef.current) {
				wsRef.current.close();
				wsRef.current = null;
			}
			setIsConnected(false);
			return;
		}

		let cancelled = false;
		let socket: WebSocket | null = null;

		const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:1999";
		const isLocalHost = isLocalPartyKitHost(host);
		const protocol = isLocalHost ? "ws" : "wss";
		const resolvedUserId = userId || "anonymous";

		const markConnectionHealthy = () => {
			if (healthyTimeoutRef.current) {
				clearTimeout(healthyTimeoutRef.current);
				healthyTimeoutRef.current = null;
			}
			reconnectAttemptsRef.current = 0;
			unauthorizedClosesRef.current = 0;
			tokenFallbackEligibleRef.current = true;
		};

		const scheduleReconnect = () => {
			if (cancelled) {
				return;
			}
			const delay = RECONNECT_BACKOFF_MS[reconnectAttemptsRef.current];
			if (delay === undefined) {
				console.warn(
					`[${logTag}] Reconnect budget exhausted, staying disconnected`,
				);
				return;
			}
			reconnectAttemptsRef.current += 1;
			reconnectTimeoutRef.current = setTimeout(() => {
				console.log(`[${logTag}] Attempting reconnect...`);
				// Bump the trigger so the effect re-runs and reconnects
				setReconnectTrigger((prev) => prev + 1);
			}, delay);
		};

		const requestToken = async (): Promise<LiveTokenResult> => {
			try {
				const response = await fetch(tokenEndpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(buildTokenBodyRef.current(roomId)),
				});

				if (response.ok) {
					const data = (await response.json()) as {
						token?: string;
						expiresIn?: number;
					};
					if (typeof data.token !== "string" || !data.token) {
						return { kind: "retryable", transport: false };
					}
					const ttlSeconds =
						typeof data.expiresIn === "number"
							? data.expiresIn
							: 600;
					return {
						kind: "token",
						token: data.token,
						expiresAt: Date.now() + ttlSeconds * 1000,
					};
				}

				if (isTerminalTokenStatusRef.current(response.status)) {
					return { kind: "denied", status: response.status };
				}

				// 5xx is infrastructure. Anything else the server chose is a
				// decision, so it is retried but never rewarded with a
				// token-less connect.
				return {
					kind: "retryable",
					transport: response.status >= 500,
				};
			} catch (error) {
				console.warn(`[${logTag}] Token request failed:`, error);
				return { kind: "retryable", transport: true };
			}
		};

		const openSocket = (token: string | null) => {
			// Build WebSocket URL with auth params
			const params = new URLSearchParams({ userId: resolvedUserId });
			if (token) {
				params.set("token", token);
			}
			const wsUrl = `${protocol}://${host}/parties/${party}/${roomId}?${params.toString()}`;

			console.log(`[${logTag}] Connecting to:`, roomId);

			const ws = new WebSocket(wsUrl);
			socket = ws;
			wsRef.current = ws;

			ws.onopen = () => {
				console.log(`[${logTag}] Connected`);
				setIsConnected(true);
				// Deliberately NOT resetting the backoff budget here: the worker
				// authorizes in onConnect and closes 4001 after the handshake,
				// so a socket that is about to be rejected still fires onopen.
				// The budget resets only once the connection proves itself.
				if (reconnectTimeoutRef.current) {
					clearTimeout(reconnectTimeoutRef.current);
					reconnectTimeoutRef.current = null;
				}
				healthyTimeoutRef.current = setTimeout(
					markConnectionHealthy,
					HEALTHY_CONNECTION_MS,
				);
			};

			ws.onmessage = (event) => {
				// First message is proof the worker accepted us.
				markConnectionHealthy();
				onMessageRef.current(event);
			};

			ws.onerror = (error) => {
				console.warn(`[${logTag}] WebSocket error:`, error);
			};

			ws.onclose = (event) => {
				console.log(`[${logTag}] Disconnected:`, event.code);
				setIsConnected(false);
				if (wsRef.current === ws) {
					wsRef.current = null;
				}
				if (healthyTimeoutRef.current) {
					clearTimeout(healthyTimeoutRef.current);
					healthyTimeoutRef.current = null;
				}

				// 4001 is the worker rejecting our credential. Drop the cached
				// token so the retry re-fetches: if access is genuinely gone
				// the token route answers 401/403 and we stop, instead of
				// replaying a dead token for the whole budget. Cap consecutive
				// rejections too — a misconfigured worker would otherwise loop
				// fetch → connect → 4001 forever, since each rejection also
				// produced an onopen.
				if (event.code === 4001) {
					tokenRef.current = null;
					unauthorizedClosesRef.current += 1;
					if (
						unauthorizedClosesRef.current >= MAX_UNAUTHORIZED_CLOSES
					) {
						console.warn(
							`[${logTag}] Worker rejected the connection repeatedly, giving up`,
						);
						return;
					}
				}

				// Attempt reconnect if not a clean close and still enabled
				if (event.code !== 1000 && event.code !== 1001 && enabled) {
					scheduleReconnect();
				}
			};
		};

		const connect = async () => {
			const cached = tokenRef.current;
			let token =
				cached &&
				cached.roomId === roomId &&
				cached.userId === resolvedUserId &&
				cached.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS
					? cached.token
					: null;

			if (!token) {
				const result = await requestToken();
				if (cancelled) {
					return;
				}

				if (result.kind === "token") {
					tokenRef.current = {
						roomId,
						userId: resolvedUserId,
						token: result.token,
						expiresAt: result.expiresAt,
					};
					token = result.token;
				} else if (isLocalHost) {
					// Dev only: the local worker trusts the userId param, so
					// connect without a token straight away rather than making
					// developers sit through the backoff schedule.
					console.warn(
						`[${logTag}] Token unavailable, connecting to the local worker without one`,
					);
				} else if (result.kind === "denied") {
					console.warn(
						`[${logTag}] Live token denied (${result.status}), not connecting`,
					);
					setIsConnected(false);
					return;
				} else {
					if (!result.transport) {
						// The server answered rather than the transport failing.
						// Retry, but this room is no longer eligible for a
						// token-less connect.
						tokenFallbackEligibleRef.current = false;
					}
					if (
						reconnectAttemptsRef.current <
						RECONNECT_BACKOFF_MS.length
					) {
						scheduleReconnect();
						return;
					}
					if (!tokenFallbackEligibleRef.current) {
						console.warn(
							`[${logTag}] Token refused after retries, staying disconnected`,
						);
						setIsConnected(false);
						return;
					}
					// Budget spent purely on transport failures: attempt a
					// token-less connect. Production rejects it — this exists for
					// dev/self-hosted workers, not as a bypass.
					console.warn(
						`[${logTag}] Token endpoint unreachable, attempting connect without a token`,
					);
				}
			}

			if (cancelled) {
				return;
			}
			openSocket(token);
		};

		void connect();

		return () => {
			cancelled = true;
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
				reconnectTimeoutRef.current = null;
			}
			if (healthyTimeoutRef.current) {
				clearTimeout(healthyTimeoutRef.current);
				healthyTimeoutRef.current = null;
			}
			if (
				socket &&
				(socket.readyState === WebSocket.OPEN ||
					socket.readyState === WebSocket.CONNECTING)
			) {
				socket.close(1000, "Component unmounted");
			}
		};
		// The callback knobs are read from refs, so they are not deps here.
	}, [
		roomId,
		userId,
		enabled,
		party,
		tokenEndpoint,
		logTag,
		reconnectTrigger,
	]);

	return { isConnected };
}
