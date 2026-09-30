import { type Connection, type ConnectionContext, Server } from "partyserver";
import type { Env } from "./env";
import { playParlumePcm } from "./parlume-pcm";
import {
	authenticateParlumeStreamMessage,
	isRecord,
	type ParlumeStreamConnection,
} from "./parlume-stream-auth";
import { ParlumeTurnEndpoint } from "./parlume-turn-endpoint";
import { parseParlumeWake } from "./parlume-wake";

const WATCHDOG_RETRY_MS = 5 * 60 * 1000;
const ACCESS_CHECK_MS = 60 * 1000;
const TURN_RETRY_MS = 2_000;
const VERIFY_BACKOFF_MS = [100, 250, 500, 1_000, 2_000, 4_000];
const PENDING_SEGMENTS_KEY = "pendingSegments";
const STREAM_CLOSED_KEY = "streamClosed";
const STREAM_ERROR_KEY = "streamError";
const WAKE_ARM_KEY = "wakeArm";
const PENDING_TURNS_KEY = "pendingTurns";
const PENDING_INTERRUPT_KEY = "pendingInterrupt";
const MAX_PENDING_SEGMENTS = 1_000;
const MAX_SEGMENTS_PER_FLUSH = 25;
const MAX_SPEECH_BYTES = 6 * 1024 * 1024;
// Nobody has spoken for this long and Parlume is silent: treat the meeting
// as over. The provider's own silence timeout cannot go below five minutes.
const IDLE_LEAVE_MS = 3 * 60 * 1000;
const LAST_ACTIVITY_KEY = "lastActivityAt";
const IDLE_REPORTED_KEY = "idleReported";

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
}

interface PendingTurn {
	voiceGeneration: number;
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

interface PendingInterrupt {
	sessionId: string;
	botId: string | null;
	voiceGeneration: number;
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

function parlumeSpeakerKey(
	speakerId: string | null,
	speakerName: string | null,
): string {
	return speakerId ?? speakerName?.toLowerCase() ?? "unknown";
}

// Workers Logs keep these as structured fields. Ids only: never the meeting
// URL, the stream token, or transcript text.
function log(
	level: "info" | "warn" | "error",
	event: string,
	meta: Record<string, unknown>,
): void {
	console[level](`[Parlume] ${event}`, {
		component: "parlume-bridge",
		event: `parlume.bridge.${event}`,
		...meta,
	});
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
	private responsePending = false;
	private turnEndpoint = new ParlumeTurnEndpoint<PendingTurn>((turn) => {
		void this.dispatchTurn(turn);
	});
	private lastActivityAt = Date.now();

	async onStart() {
		this.playbackEpoch =
			(await this.ctx.storage.get<number>("voiceGeneration")) ?? 0;
		this.responsePending =
			(await this.ctx.storage.get<boolean>("responsePending")) ?? false;
		// A restart loses the in-memory clock; the stored value is refreshed on
		// every final segment, so the idle window resumes rather than restarts.
		this.lastActivityAt =
			(await this.ctx.storage.get<number>(LAST_ACTIVITY_KEY)) ??
			Date.now();
	}

	private closeStream(reason: string): number {
		const open = [...this.connections.keys()];
		for (const connection of open) {
			connection.close(1000, reason);
		}
		return open.length;
	}

	private async interruptResponse(state: StreamConnection): Promise<void> {
		this.turnEndpoint.cancel();
		this.playbackEpoch++;
		this.playbackActive = false;
		this.responsePending = false;
		await this.ctx.storage.put({
			voiceGeneration: this.playbackEpoch,
			responsePending: false,
		});
		await this.ctx.storage.put<PendingInterrupt>(PENDING_INTERRUPT_KEY, {
			sessionId: state.sessionId,
			botId: state.botId,
			voiceGeneration: this.playbackEpoch,
		});
		await this.flushPendingInterrupt();
	}

	private async flushPendingInterrupt(): Promise<boolean> {
		const pending = await this.ctx.storage.get<PendingInterrupt>(
			PENDING_INTERRUPT_KEY,
		);
		if (!pending) {
			return true;
		}
		if (
			!(await this.postToFabric(
				"/api/internal/parlume/interrupt",
				pending,
			))
		) {
			await this.ctx.storage.setAlarm(Date.now() + TURN_RETRY_MS);
			return false;
		}
		const latest = await this.ctx.storage.get<PendingInterrupt>(
			PENDING_INTERRUPT_KEY,
		);
		if (latest?.voiceGeneration === pending.voiceGeneration) {
			await this.ctx.storage.delete(PENDING_INTERRUPT_KEY);
			return true;
		}
		return false;
	}

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
		const speakerName = event.data.speaker?.name ?? null;
		const speakerId = event.data.speaker?.id ?? null;
		const fromBot = this.isBotSpeaker(speakerName ?? undefined);
		const speakerKey = parlumeSpeakerKey(speakerId, speakerName);
		if (!fromBot) {
			this.lastActivityAt = Date.now();
			if (event.data.isFinal) {
				await this.ctx.storage.put(
					LAST_ACTIVITY_KEY,
					this.lastActivityAt,
				);
			}
		}
		// Speech only barges in while Parlume is audible. While a request is
		// being endpointed or answered, its speaker's continued speech extends it.
		if (!event.data.isFinal) {
			if (
				!fromBot &&
				!this.turnEndpoint.hold(speakerKey) &&
				this.playbackActive
			) {
				await this.interruptResponse(state);
			}
			return;
		}
		const segment: PendingSegment = {
			sessionId: state.sessionId,
			botId: event.bot_id,
			text: event.data.text,
			speakerName,
			speakerId,
			utteranceStartMs: this.secondsToMilliseconds(
				event.data.utteranceStart,
			),
			utteranceEndMs: this.secondsToMilliseconds(event.data.utteranceEnd),
		};
		if (
			!fromBot &&
			!this.turnEndpoint.append(
				speakerKey,
				segment.text,
				segment.utteranceEndMs,
			)
		) {
			await this.beginWakeTurn(state, segment, speakerKey);
		} else if (!fromBot) {
			log("info", "turn.extended", {
				sessionId: state.sessionId,
				botId: event.bot_id,
				speakerId,
			});
		}
		const persist = this.queueFinalSegment(segment);
		this.inFlightFinalSegments.add(persist);
		try {
			await persist;
		} finally {
			this.inFlightFinalSegments.delete(persist);
		}
	}

	async onClose(conn: Connection, code?: number, reason?: string) {
		const state = this.connections.get(conn);
		this.connections.delete(conn);
		log("info", "stream.closed", {
			sessionId: this.name,
			botId: state?.botId ?? null,
			verified: state?.verified ?? false,
			code,
			reason,
			remainingConnections: this.connections.size,
		});
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
			await this.interruptResponse(state);
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
		if (action === "close") {
			// Fabric learned from the provider that the bot is gone (removed by
			// the host, meeting ended). Closing the socket here lets onClose
			// drain buffered segments and report the stream closed, instead of
			// waiting for a close the provider may never send.
			const closed = this.closeStream("meeting ended");
			log("info", "stream.close_requested", {
				sessionId: this.name,
				closed,
			});
			return Response.json({ closed });
		}
		if (action === "verify-generation") {
			const body: unknown = await request.json();
			return Response.json({
				current:
					isRecord(body) &&
					body.voiceGeneration === this.playbackEpoch &&
					this.responsePending,
			});
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
		const epoch = Number(
			request.headers.get("x-parlume-voice-generation") ??
				this.playbackEpoch,
		);
		if (epoch !== this.playbackEpoch) {
			return Response.json({ played: false, interrupted: true });
		}
		if (!request.body) {
			return Response.json(
				{ error: "Missing PCM body" },
				{ status: 400 },
			);
		}
		this.playbackActive = true;
		const startedAt = Date.now();
		try {
			const result = await playParlumePcm({
				body: request.body,
				declaredLength: length,
				isCurrent: () =>
					epoch === this.playbackEpoch &&
					this.connections.has(connection),
				send: (frame) => connection.send(frame),
			});
			const confirmationSpeakerId = request.headers.get(
				"x-parlume-confirmation-speaker",
			);
			if (result.played && confirmationSpeakerId) {
				await this.ctx.storage.put<WakeArm>(WAKE_ARM_KEY, {
					speakerKey: confirmationSpeakerId,
					expiresAt: Date.now() + 120_000,
				});
			}
			log("info", "speech.played", {
				sessionId: this.name,
				voiceGeneration: epoch,
				played: result.played,
				interrupted: result.interrupted,
				declaredBytes: length,
				playbackMs: Date.now() - startedAt,
			});
			return Response.json(result);
		} finally {
			if (epoch === this.playbackEpoch) {
				this.playbackActive = false;
				this.responsePending = false;
				await this.ctx.storage.put("responsePending", false);
			}
		}
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
		if (!(await this.flushPendingInterrupt())) {
			return;
		}
		if (await this.reportStreamFailure()) {
			return;
		}
		const access = await this.verifyInviterAccess(bridge);
		if (access !== "active") {
			const hardStopAt = new Date(bridge.hardStopAt ?? 0).getTime();
			if (access === "stopped") {
				// Capture is over on Fabric's side; close now so the stream-closed
				// report and finalization do not wait for the provider.
				const closed = this.closeStream("capture stopped");
				log("info", "access.stopped", {
					sessionId: bridge.sessionId,
					botId: bridge.botId,
					closed,
				});
				if (Number.isFinite(hardStopAt) && Date.now() < hardStopAt) {
					await this.ctx.storage.setAlarm(hardStopAt);
				}
			}
			return;
		}
		await this.reportIdleMeeting(bridge);
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

	// Runs on the access-check cadence, so a silent meeting is reported within
	// one minute of crossing the idle window. Fabric asks the provider to leave;
	// the terminal callback then ends the session as usual.
	private async reportIdleMeeting(bridge: BridgeState): Promise<void> {
		const idleMs = Date.now() - this.lastActivityAt;
		if (
			!bridge.botId ||
			this.playbackActive ||
			this.responsePending ||
			idleMs < IDLE_LEAVE_MS ||
			(await this.ctx.storage.get<boolean>(IDLE_REPORTED_KEY))
		) {
			return;
		}
		const reported = await this.postToFabric("/api/internal/parlume/idle", {
			sessionId: bridge.sessionId,
			botId: bridge.botId,
			idleMs,
		});
		log(reported ? "info" : "warn", "idle.reported", {
			sessionId: bridge.sessionId,
			botId: bridge.botId,
			idleMs,
			accepted: Boolean(reported),
		});
		if (reported) {
			await this.ctx.storage.put(IDLE_REPORTED_KEY, true);
		}
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
		this.lastActivityAt = Date.now();
		await this.ctx.storage.put(LAST_ACTIVITY_KEY, this.lastActivityAt);
		await this.ctx.storage.delete(IDLE_REPORTED_KEY);
		log("info", "stream.verified", {
			sessionId: state.sessionId,
			botId,
			streamGeneration: data.streamGeneration,
			hardStopAt: data.hardStopAt,
		});
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

	private async beginWakeTurn(
		state: StreamConnection,
		segment: PendingSegment,
		speakerKey: string,
	): Promise<void> {
		if (this.playbackActive) {
			await this.interruptResponse(state);
		}
		const turnText = await this.resolveWakeTurn(segment);
		if (!turnText) {
			return;
		}
		if (this.responsePending) {
			await this.interruptResponse(state);
		}
		this.playbackEpoch++;
		this.responsePending = true;
		await this.ctx.storage.put({
			voiceGeneration: this.playbackEpoch,
			responsePending: true,
		});
		log("info", "wake.detected", {
			sessionId: segment.sessionId,
			botId: segment.botId,
			speakerId: segment.speakerId,
			voiceGeneration: this.playbackEpoch,
			requestChars: turnText.length,
		});
		this.turnEndpoint.begin(speakerKey, {
			voiceGeneration: this.playbackEpoch,
			sessionId: segment.sessionId,
			botId: segment.botId,
			text: turnText,
			speakerName: segment.speakerName,
			speakerId: segment.speakerId,
			utteranceStartMs: segment.utteranceStartMs,
			utteranceEndMs: segment.utteranceEndMs,
		});
	}

	private async resolveWakeTurn(input: {
		text: string;
		speakerName: string | null;
		speakerId: string | null;
	}): Promise<string | null> {
		if (input.speakerName?.toLowerCase().includes("parlume")) {
			return null;
		}
		const speakerKey = parlumeSpeakerKey(
			input.speakerId,
			input.speakerName,
		);
		const afterWake = parseParlumeWake(input.text);
		if (afterWake !== null) {
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

	private async dispatchTurn(turn: PendingTurn): Promise<void> {
		// The request's segments reach Fabric first, so the turn sees them as
		// meeting context.
		await this.finalSegmentChain;
		if (turn.voiceGeneration !== this.playbackEpoch) {
			log("info", "turn.superseded", {
				sessionId: turn.sessionId,
				botId: turn.botId,
				voiceGeneration: turn.voiceGeneration,
			});
			return;
		}
		if (
			(await this.flushPendingInterrupt()) &&
			turn.voiceGeneration === this.playbackEpoch &&
			(await this.postToFabric("/api/internal/parlume/turns", turn))
		) {
			log("info", "turn.dispatched", {
				sessionId: turn.sessionId,
				botId: turn.botId,
				voiceGeneration: turn.voiceGeneration,
				requestChars: turn.text.length,
			});
			return;
		}
		log("warn", "turn.deferred", {
			sessionId: turn.sessionId,
			botId: turn.botId,
			voiceGeneration: turn.voiceGeneration,
		});
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
		if (!(await this.flushPendingInterrupt())) {
			return false;
		}
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
			if (turn && turn.voiceGeneration !== this.playbackEpoch) {
				continue;
			}
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
		// The open-socket count lets Fabric finalize a session whose bot is
		// already gone when no stream is left to close (a worker restart drops
		// sockets without an onClose), instead of waiting for the hard stop.
		const response = await this.requestFabric(
			"/api/internal/parlume/verify-access",
			{
				sessionId: bridge.sessionId,
				botId: bridge.botId,
				openConnections: this.connections.size,
			},
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
