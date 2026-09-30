import { type Connection, type ConnectionContext, Server } from "partyserver";
import type { Env } from "./env";
import {
	authenticateParlumeStreamMessage,
	isRecord,
	type ParlumeStreamConnection,
} from "./parlume-stream-auth";

const WATCHDOG_RETRY_MS = 5 * 60 * 1000;
const ACCESS_CHECK_MS = 60 * 1000;
const TURN_RETRY_MS = 2_000;
const VERIFY_BACKOFF_MS = [100, 250, 500, 1_000, 2_000, 4_000];
const PENDING_SEGMENTS_KEY = "pendingSegments";
const STREAM_CLOSED_KEY = "streamClosed";
const STREAM_ERROR_KEY = "streamError";
const WAKE_ARM_KEY = "wakeArm";
const PENDING_TURNS_KEY = "pendingTurns";
const MAX_PENDING_SEGMENTS = 1_000;
const MAX_SEGMENTS_PER_FLUSH = 25;
const MAX_SPEECH_BYTES = 6 * 1024 * 1024;
const SPEECH_FRAME_BYTES = 1_920;

interface BridgeState {
	sessionId: string;
	botId: string | null;
	hardStopAt: string | null;
}

type StreamConnection = ParlumeStreamConnection;

interface PendingSegment {
	sessionId: string;
	botId: string;
	text: string;
	speakerName: string | null;
	speakerId: string | null;
	utteranceStartMs: number | null;
	utteranceEndMs: number | null;
	turnText?: string;
}

interface PendingTurn {
	sessionId: string;
	botId: string;
	text: string;
	speakerName: string | null;
	speakerId: string | null;
	utteranceStartMs: number | null;
	utteranceEndMs: number | null;
}

interface WakeArm {
	speakerKey: string;
	expiresAt: number;
}

interface StreamClosed {
	sessionId: string;
	botId: string;
	streamGeneration: number;
}

interface StreamError {
	sessionId: string;
	botId: string;
}

async function secretMatches(
	candidate: string | null,
	expected: string | undefined,
): Promise<boolean> {
	if (!candidate || !expected) {
		return false;
	}
	const encoder = new TextEncoder();
	const [candidateDigest, expectedDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	const a = new Uint8Array(candidateDigest);
	const b = new Uint8Array(expectedDigest);
	let mismatch = a.length ^ b.length;
	for (let index = 0; index < a.length; index++) {
		mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
	}
	return mismatch === 0;
}

export class Parlume extends Server<Env> {
	private connections = new Map<Connection, StreamConnection>();
	private inFlightFinalSegments = new Set<Promise<void>>();
	private finalSegmentChain = Promise.resolve();
	private connectionGeneration = 0;
	private playbackEpoch = 0;
	private playbackActive = false;

	async onConnect(conn: Connection, ctx: ConnectionContext) {
		const url = new URL(ctx.request.url);
		const token = url.searchParams.get("token");
		if (
			!token ||
			!this.env.AGENT_SERVICE_SECRET ||
			!this.env.FABRIC_API_URL
		) {
			conn.close(4001, "Unauthorized");
			return;
		}
		this.connections.set(conn, {
			sessionId: this.name,
			token,
			botId: null,
			verified: false,
			generation: ++this.connectionGeneration,
			streamGeneration: null,
		});
	}

	async onMessage(conn: Connection, message: string) {
		const authenticated = await authenticateParlumeStreamMessage(
			{
				connections: this.connections,
				verifyStreamWithRetry: (state, botId) =>
					this.verifyStreamWithRetry(state, botId),
			},
			conn,
			message,
		);
		if (!authenticated) {
			return;
		}
		const { event, state } = authenticated;
		if (event.event === "session.started") {
			return;
		}
		if (event.event === "error") {
			await this.ctx.storage.put<StreamError>(STREAM_ERROR_KEY, {
				sessionId: state.sessionId,
				botId: event.bot_id,
			});
			await this.reportStreamFailure();
			return;
		}
		if (event.event === "transcript.incomplete") {
			return;
		}
		if (!event.data.isFinal) {
			if (
				this.playbackActive &&
				!this.isBotSpeaker(event.data.speaker?.name)
			) {
				this.playbackEpoch++;
				this.playbackActive = false;
			}
			return;
		}
		if (
			this.playbackActive &&
			!this.isBotSpeaker(event.data.speaker?.name)
		) {
			this.playbackEpoch++;
			this.playbackActive = false;
		}
		const turnText = await this.resolveWakeTurn({
			text: event.data.text,
			speakerName: event.data.speaker?.name ?? null,
			speakerId: event.data.speaker?.id ?? null,
		});
		const persist = this.queueFinalSegment({
			sessionId: state.sessionId,
			botId: event.bot_id,
			text: event.data.text,
			speakerName: event.data.speaker?.name ?? null,
			speakerId: event.data.speaker?.id ?? null,
			utteranceStartMs: this.secondsToMilliseconds(
				event.data.utteranceStart,
			),
			utteranceEndMs: this.secondsToMilliseconds(event.data.utteranceEnd),
			turnText: turnText ?? undefined,
		});
		this.inFlightFinalSegments.add(persist);
		try {
			await persist;
		} finally {
			this.inFlightFinalSegments.delete(persist);
		}
	}

	async onClose(conn: Connection) {
		const state = this.connections.get(conn);
		this.connections.delete(conn);
		this.playbackEpoch++;
		this.playbackActive = false;
		if (state?.verified && state.botId && state.streamGeneration !== null) {
			const hasReplacementConnection = [
				...this.connections.values(),
			].some(
				(connection) =>
					connection.sessionId === state.sessionId &&
					(!connection.verified || connection.botId === state.botId),
			);
			if (hasReplacementConnection) {
				return;
			}
			await Promise.all(this.inFlightFinalSegments);
			// A replacement can connect while final segments drain. Its onConnect
			// advances this generation before verification clears close markers, so
			// this older socket must not write a stale stream-closed event afterward.
			if (state.generation !== this.connectionGeneration) {
				return;
			}
			if (await this.reportStreamFailure()) {
				return;
			}
			await this.ctx.storage.put<StreamClosed>(STREAM_CLOSED_KEY, {
				sessionId: state.sessionId,
				botId: state.botId,
				streamGeneration: state.streamGeneration,
			});
			await this.flushPendingSegments();
			await this.reportClosedStreamIfDrained();
		}
	}

	async onRequest(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		if (
			!(await secretMatches(
				request.headers.get("Authorization"),
				this.env.AGENT_SERVICE_SECRET
					? `Bearer ${this.env.AGENT_SERVICE_SECRET}`
					: undefined,
			))
		) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}
		const action = new URL(request.url).searchParams.get("action");
		if (action === "speak") {
			return this.speak(request);
		}
		if (action === "stop") {
			return this.stop(request);
		}
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: "Invalid request" }, { status: 400 });
		}
		if (!isRecord(body) || typeof body.hardStopAt !== "string") {
			return Response.json({ error: "Invalid request" }, { status: 400 });
		}
		const hardStopAt = new Date(body.hardStopAt);
		if (
			Number.isNaN(hardStopAt.getTime()) ||
			hardStopAt.getTime() <= Date.now()
		) {
			return Response.json(
				{ error: "Invalid hard stop" },
				{ status: 400 },
			);
		}
		await this.ctx.storage.put<BridgeState>("bridge", {
			sessionId: this.name,
			botId: null,
			hardStopAt: hardStopAt.toISOString(),
		});
		await this.ctx.storage.setAlarm(hardStopAt.getTime());
		return Response.json({ armed: true });
	}

	private isBotSpeaker(name: string | undefined): boolean {
		return Boolean(name && /^Fabric Parlume\b/i.test(name));
	}

	private async speak(request: Request): Promise<Response> {
		const headerLength = request.headers.get("content-length");
		const length = headerLength === null ? null : Number(headerLength);
		if (
			request.headers.get("content-type") !== "audio/pcm" ||
			(length !== null &&
				(!Number.isFinite(length) ||
					length <= 0 ||
					length > MAX_SPEECH_BYTES ||
					length % 2 !== 0))
		) {
			return Response.json(
				{ error: "Invalid PCM audio" },
				{ status: 400 },
			);
		}
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		if (
			!bridge ||
			(bridge.hardStopAt &&
				new Date(bridge.hardStopAt).getTime() <= Date.now())
		) {
			return Response.json({ error: "Meeting ended" }, { status: 409 });
		}
		const connection = [...this.connections].find(
			([, state]) => state.verified && state.botId,
		)?.[0];
		if (!connection) {
			return Response.json(
				{ error: "Bot stream unavailable" },
				{ status: 409 },
			);
		}
		const pcm = new Uint8Array(await request.arrayBuffer());
		if (
			pcm.length === 0 ||
			pcm.length > MAX_SPEECH_BYTES ||
			pcm.length % 2 !== 0 ||
			(length !== null && pcm.length !== length)
		) {
			return Response.json(
				{ error: "Invalid PCM length" },
				{ status: 400 },
			);
		}
		const epoch = ++this.playbackEpoch;
		this.playbackActive = true;
		let interrupted = false;
		try {
			for (
				let offset = 0;
				offset < pcm.length;
				offset += SPEECH_FRAME_BYTES
			) {
				if (
					epoch !== this.playbackEpoch ||
					!this.connections.has(connection)
				) {
					interrupted = true;
					break;
				}
				connection.send(pcm.slice(offset, offset + SPEECH_FRAME_BYTES));
				await new Promise((resolve) => setTimeout(resolve, 40));
			}
		} finally {
			if (epoch === this.playbackEpoch) {
				this.playbackActive = false;
			}
		}
		return Response.json({ played: !interrupted, interrupted });
	}

	private async stop(_request: Request): Promise<Response> {
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		if (!bridge?.botId) {
			return Response.json(
				{ error: "Meeting stream unavailable" },
				{ status: 409 },
			);
		}
		await this.ctx.storage.put<StreamError>(STREAM_ERROR_KEY, {
			sessionId: bridge.sessionId,
			botId: bridge.botId,
		});
		await this.reportStreamFailure();
		return Response.json({ accepted: true });
	}

	async onAlarm() {
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		if (!bridge) {
			return;
		}
		if (await this.reportStreamFailure()) {
			return;
		}
		const access = await this.verifyInviterAccess(bridge);
		if (access !== "active") {
			const hardStopAt = new Date(bridge.hardStopAt ?? 0).getTime();
			if (
				access === "stopped" &&
				Number.isFinite(hardStopAt) &&
				Date.now() < hardStopAt
			) {
				await this.ctx.storage.setAlarm(hardStopAt);
			}
			return;
		}
		const [flushed, turnsFlushed] = await Promise.all([
			this.flushPendingSegments(),
			this.flushPendingTurns(),
		]);
		if (flushed) {
			await this.reportClosedStreamIfDrained();
		}
		const hardStopAt = new Date(bridge.hardStopAt ?? 0).getTime();
		if (Number.isFinite(hardStopAt) && Date.now() < hardStopAt) {
			const retryDelay = !flushed
				? WATCHDOG_RETRY_MS
				: !turnsFlushed
					? TURN_RETRY_MS
					: ACCESS_CHECK_MS;
			await this.ctx.storage.setAlarm(
				Math.min(hardStopAt, Date.now() + retryDelay),
			);
			return;
		}
		const response = await this.postToFabric(
			"/api/internal/parlume/watchdog",
			{
				sessionId: bridge.sessionId,
			},
		);
		if (!response || !flushed || !turnsFlushed) {
			await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_RETRY_MS);
			return;
		}
		await this.ctx.storage.delete("bridge");
	}

	private secondsToMilliseconds(value: number | undefined): number | null {
		if (!Number.isFinite(value) || value === undefined || value < 0) {
			return null;
		}
		return Math.round(value * 1000);
	}

	private async verifyStreamWithRetry(
		state: StreamConnection,
		botId: string,
	): Promise<boolean> {
		for (const delay of VERIFY_BACKOFF_MS) {
			const response = await this.requestFabric(
				"/api/internal/parlume/verify-stream",
				{
					sessionId: state.sessionId,
					streamToken: state.token,
					botId,
				},
			);
			if (response?.ok) {
				const streamGeneration = await this.persistVerifiedStream(
					response,
					state,
					botId,
				);
				if (streamGeneration !== null) {
					state.streamGeneration = streamGeneration;
					return true;
				}
			}
			if (response?.status !== 202) {
				return false;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
		return false;
	}

	private async persistVerifiedStream(
		response: Response,
		state: StreamConnection,
		botId: string,
	): Promise<number | null> {
		let data: unknown;
		try {
			data = await response.json();
		} catch {
			return null;
		}
		if (
			!isRecord(data) ||
			data.valid !== true ||
			typeof data.hardStopAt !== "string" ||
			typeof data.streamGeneration !== "number" ||
			!Number.isSafeInteger(data.streamGeneration) ||
			data.streamGeneration < 1
		) {
			return null;
		}
		await this.ctx.storage.put<BridgeState>("bridge", {
			sessionId: state.sessionId,
			botId,
			hardStopAt: data.hardStopAt,
		});
		// A provider reconnect may follow a transient WebSocket close. Do not
		// let that old close finalize the session after this newer stream proves
		// it is live.
		await this.ctx.storage.delete(STREAM_CLOSED_KEY);
		const hardStopAt = new Date(data.hardStopAt);
		if (!Number.isNaN(hardStopAt.getTime())) {
			await this.ctx.storage.setAlarm(
				Math.min(hardStopAt.getTime(), Date.now() + ACCESS_CHECK_MS),
			);
		}
		return data.streamGeneration;
	}

	private async postToFabric(
		path: string,
		body: object,
	): Promise<Response | null> {
		const response = await this.requestFabric(path, body);
		return response?.ok ? response : null;
	}

	private async requestFabric(
		path: string,
		body: object,
	): Promise<Response | null> {
		if (!this.env.FABRIC_API_URL || !this.env.AGENT_SERVICE_SECRET) {
			return null;
		}
		try {
			const response = await fetch(`${this.env.FABRIC_API_URL}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Agent-Service-Token": this.env.AGENT_SERVICE_SECRET,
				},
				body: JSON.stringify(body),
			});
			return response;
		} catch {
			return null;
		}
	}

	private async persistFinalSegment(segment: PendingSegment): Promise<void> {
		if (
			await this.postToFabric("/api/internal/parlume/segments", segment)
		) {
			await this.dispatchTurn(segment);
			return;
		}
		const pending =
			(await this.ctx.storage.get<PendingSegment[]>(
				PENDING_SEGMENTS_KEY,
			)) ?? [];
		if (pending.length >= MAX_PENDING_SEGMENTS) {
			await this.ctx.storage.put<StreamError>(STREAM_ERROR_KEY, {
				sessionId: segment.sessionId,
				botId: segment.botId,
			});
			const bridge = await this.ctx.storage.get<BridgeState>("bridge");
			await this.schedulePendingRetry(
				bridge?.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
			);
			return;
		}
		pending.push(segment);
		await this.ctx.storage.put(PENDING_SEGMENTS_KEY, pending);
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		const hardStopAt = bridge?.hardStopAt
			? new Date(bridge.hardStopAt).getTime()
			: 0;
		await this.schedulePendingRetry(hardStopAt);
	}

	private queueFinalSegment(segment: PendingSegment): Promise<void> {
		const persist = this.finalSegmentChain.then(() =>
			this.persistFinalSegment(segment),
		);
		this.finalSegmentChain = persist.catch(() => undefined);
		return persist;
	}

	private async flushPendingSegments(): Promise<boolean> {
		const pending =
			(await this.ctx.storage.get<PendingSegment[]>(
				PENDING_SEGMENTS_KEY,
			)) ?? [];
		if (pending.length === 0) {
			return true;
		}
		let index = 0;
		const limit = Math.min(pending.length, MAX_SEGMENTS_PER_FLUSH);
		for (; index < limit; index++) {
			const segment = pending[index];
			if (
				!segment ||
				!(await this.postToFabric(
					"/api/internal/parlume/segments",
					segment,
				))
			) {
				break;
			}
			await this.dispatchTurn(segment);
		}
		if (index === pending.length) {
			await this.ctx.storage.delete(PENDING_SEGMENTS_KEY);
			return true;
		}
		await this.ctx.storage.put(PENDING_SEGMENTS_KEY, pending.slice(index));
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		await this.schedulePendingRetry(
			bridge?.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
		);
		return false;
	}

	private async reportClosedStreamIfDrained(): Promise<void> {
		const pending =
			(await this.ctx.storage.get<PendingSegment[]>(
				PENDING_SEGMENTS_KEY,
			)) ?? [];
		const closed =
			await this.ctx.storage.get<StreamClosed>(STREAM_CLOSED_KEY);
		if (pending.length > 0 || !closed) {
			return;
		}
		if (
			await this.postToFabric(
				"/api/internal/parlume/stream-closed",
				closed,
			)
		) {
			await this.ctx.storage.delete(STREAM_CLOSED_KEY);
		}
	}

	private async resolveWakeTurn(input: {
		text: string;
		speakerName: string | null;
		speakerId: string | null;
	}): Promise<string | null> {
		if (input.speakerName?.toLowerCase().includes("parlume")) {
			return null;
		}
		const speakerKey =
			input.speakerId ?? input.speakerName?.toLowerCase() ?? "unknown";
		const wakeMatch = /\bhey\s+fabric\b/i.exec(input.text);
		if (wakeMatch) {
			const afterWake = input.text
				.slice(wakeMatch.index + wakeMatch[0].length)
				.trim();
			if (afterWake) {
				return afterWake;
			}
			await this.ctx.storage.put<WakeArm>(WAKE_ARM_KEY, {
				speakerKey,
				expiresAt: Date.now() + 15_000,
			});
			return null;
		}
		const armed = await this.ctx.storage.get<WakeArm>(WAKE_ARM_KEY);
		if (!armed) {
			return null;
		}
		if (armed.expiresAt < Date.now()) {
			await this.ctx.storage.delete(WAKE_ARM_KEY);
			return null;
		}
		if (armed.speakerKey !== speakerKey) {
			return null;
		}
		await this.ctx.storage.delete(WAKE_ARM_KEY);
		return input.text;
	}

	private async dispatchTurn(segment: PendingSegment): Promise<void> {
		if (!segment.turnText) {
			return;
		}
		const turn: PendingTurn = {
			sessionId: segment.sessionId,
			botId: segment.botId,
			text: segment.turnText,
			speakerName: segment.speakerName,
			speakerId: segment.speakerId,
			utteranceStartMs: segment.utteranceStartMs,
			utteranceEndMs: segment.utteranceEndMs,
		};
		if (await this.postToFabric("/api/internal/parlume/turns", turn)) {
			return;
		}
		const pending =
			(await this.ctx.storage.get<PendingTurn[]>(PENDING_TURNS_KEY)) ??
			[];
		if (pending.length >= MAX_PENDING_SEGMENTS) {
			await this.ctx.storage.put<StreamError>(STREAM_ERROR_KEY, {
				sessionId: turn.sessionId,
				botId: turn.botId,
			});
			const bridge = await this.ctx.storage.get<BridgeState>("bridge");
			await this.schedulePendingRetry(
				bridge?.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
			);
			return;
		}
		pending.push(turn);
		await this.ctx.storage.put(PENDING_TURNS_KEY, pending);
		await this.ctx.storage.setAlarm(Date.now() + TURN_RETRY_MS);
	}

	private async flushPendingTurns(): Promise<boolean> {
		const pending =
			(await this.ctx.storage.get<PendingTurn[]>(PENDING_TURNS_KEY)) ??
			[];
		if (pending.length === 0) {
			return true;
		}
		let index = 0;
		const limit = Math.min(pending.length, MAX_SEGMENTS_PER_FLUSH);
		for (; index < limit; index++) {
			const turn = pending[index];
			if (
				!turn ||
				!(await this.postToFabric("/api/internal/parlume/turns", turn))
			) {
				break;
			}
		}
		if (index === pending.length) {
			await this.ctx.storage.delete(PENDING_TURNS_KEY);
			return true;
		}
		await this.ctx.storage.put(PENDING_TURNS_KEY, pending.slice(index));
		await this.ctx.storage.setAlarm(Date.now() + TURN_RETRY_MS);
		return false;
	}

	private async schedulePendingRetry(hardStopAt: number): Promise<void> {
		await this.ctx.storage.setAlarm(
			hardStopAt > Date.now()
				? Math.min(hardStopAt, Date.now() + WATCHDOG_RETRY_MS)
				: Date.now() + WATCHDOG_RETRY_MS,
		);
	}

	private async reportStreamFailure(): Promise<boolean> {
		const failure =
			await this.ctx.storage.get<StreamError>(STREAM_ERROR_KEY);
		if (!failure) {
			return false;
		}
		if (
			await this.postToFabric(
				"/api/internal/parlume/stream-error",
				failure,
			)
		) {
			await this.ctx.storage.delete(STREAM_ERROR_KEY);
			const bridge = await this.ctx.storage.get<BridgeState>("bridge");
			const hardStopAt = bridge?.hardStopAt
				? new Date(bridge.hardStopAt).getTime()
				: 0;
			if (Number.isFinite(hardStopAt) && hardStopAt > Date.now()) {
				await this.ctx.storage.setAlarm(hardStopAt);
			}
			return true;
		}
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		await this.schedulePendingRetry(
			bridge?.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
		);
		return true;
	}

	private async verifyInviterAccess(
		bridge: BridgeState,
	): Promise<"active" | "retry" | "stopped"> {
		if (!bridge.botId) {
			return "active";
		}
		const response = await this.requestFabric(
			"/api/internal/parlume/verify-access",
			{ sessionId: bridge.sessionId, botId: bridge.botId },
		);
		if (!response?.ok) {
			await this.schedulePendingRetry(
				bridge.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
			);
			return "retry";
		}
		try {
			const payload: unknown = await response.json();
			return isRecord(payload) && payload.captureStopped === true
				? "stopped"
				: "active";
		} catch {
			await this.schedulePendingRetry(
				bridge.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
			);
			return "retry";
		}
	}
}
