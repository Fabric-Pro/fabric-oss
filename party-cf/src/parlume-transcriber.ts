// Audio held while the transcription stream (re)connects: five seconds at
// 24 kHz 16-bit mono. Older audio is dropped rather than replayed late.
const MAX_PENDING_BYTES = 24_000 * 2 * 5;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];

/** Times are epoch milliseconds on the provider's audio clock. */
export interface ParlumeTranscript {
	text: string;
	isFinal: boolean;
	startMs: number;
	endMs: number;
}

export interface ParlumeTranscriptionSocket {
	accept(): void;
	send(data: ArrayBuffer): void;
	close(code?: number, reason?: string): void;
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	addEventListener(
		type: "close",
		listener: (event: { code: number; reason: string }) => void,
	): void;
	addEventListener(type: "error", listener: () => void): void;
}

interface TranscriberOptions {
	connect: () => Promise<ParlumeTranscriptionSocket>;
	onTranscript: (transcript: ParlumeTranscript) => void;
	onStatus: (
		status: "connected" | "failed" | "closed",
		detail?: string,
	) => void;
	now?: () => number;
}

interface FluxEvent {
	event: string;
	turnIndex: number;
	transcript: string;
	windowStart: number | null;
	windowEnd: number | null;
}

function readFluxEvent(data: unknown): FluxEvent | null {
	if (typeof data !== "string") {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return null;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("event" in value) ||
		typeof value.event !== "string"
	) {
		return null;
	}
	const fields: Record<string, unknown> = { ...value };
	return {
		event: value.event,
		turnIndex:
			typeof fields.turn_index === "number" ? fields.turn_index : 0,
		transcript:
			typeof fields.transcript === "string"
				? fields.transcript.trim()
				: "",
		windowStart:
			typeof fields.audio_window_start === "number"
				? fields.audio_window_start
				: null,
		windowEnd:
			typeof fields.audio_window_end === "number"
				? fields.audio_window_end
				: null,
	};
}

/**
 * Streams the meeting's mixed audio to Deepgram Flux on Workers AI. Flux
 * decides where a speaker's turn ends and reports it as final; its partial
 * updates are reported too, so live speech can interrupt Parlume. A dropped
 * stream reconnects on the next audio chunk, with backoff after failures.
 */
export class ParlumeTranscriber {
	private socket: ParlumeTranscriptionSocket | null = null;
	private connecting = false;
	private pending: { chunk: ArrayBuffer; epochMs: number }[] = [];
	private pendingBytes = 0;
	private socketEpochMs: number | null = null;
	private turnStarts = new Map<number, number>();
	private failures = 0;
	private retryAt = 0;
	private closed = false;
	private readonly options: TranscriberOptions;

	constructor(options: TranscriberOptions) {
		this.options = options;
	}

	send(chunk: ArrayBuffer, epochMs: number): void {
		if (this.closed) {
			return;
		}
		if (this.socket) {
			this.forward(this.socket, chunk, epochMs);
			return;
		}
		this.pending.push({ chunk, epochMs });
		this.pendingBytes += chunk.byteLength;
		while (this.pendingBytes > MAX_PENDING_BYTES) {
			const dropped = this.pending.shift();
			this.pendingBytes -= dropped?.chunk.byteLength ?? this.pendingBytes;
		}
		void this.connect();
	}

	close(): void {
		this.closed = true;
		this.pending = [];
		this.pendingBytes = 0;
		const socket = this.socket;
		this.socket = null;
		socket?.close(1000, "meeting stream closed");
	}

	private forward(
		socket: ParlumeTranscriptionSocket,
		chunk: ArrayBuffer,
		epochMs: number,
	): void {
		this.socketEpochMs ??= epochMs;
		socket.send(chunk);
	}

	private async connect(): Promise<void> {
		const now = this.options.now?.() ?? Date.now();
		if (
			this.connecting ||
			this.socket ||
			this.closed ||
			now < this.retryAt
		) {
			return;
		}
		this.connecting = true;
		try {
			const socket = await this.options.connect();
			socket.accept();
			if (this.closed) {
				socket.close(1000, "meeting stream closed");
				return;
			}
			socket.addEventListener("message", (event) =>
				this.receive(socket, event.data),
			);
			socket.addEventListener("close", (event) =>
				this.drop(socket, `${event.code} ${event.reason}`.trim()),
			);
			socket.addEventListener("error", () => this.drop(socket, "error"));
			this.socket = socket;
			this.socketEpochMs = null;
			this.turnStarts.clear();
			this.failures = 0;
			this.options.onStatus("connected");
			for (const { chunk, epochMs } of this.pending) {
				this.forward(socket, chunk, epochMs);
			}
			this.pending = [];
			this.pendingBytes = 0;
		} catch (error) {
			this.failures++;
			this.retryAt =
				(this.options.now?.() ?? Date.now()) +
				(RECONNECT_DELAYS_MS[
					Math.min(this.failures, RECONNECT_DELAYS_MS.length) - 1
				] ?? 0);
			this.options.onStatus(
				"failed",
				error instanceof Error
					? error.message.slice(0, 200)
					: "unknown",
			);
		} finally {
			this.connecting = false;
		}
	}

	private drop(socket: ParlumeTranscriptionSocket, detail: string): void {
		if (this.socket !== socket) {
			return;
		}
		this.socket = null;
		if (!this.closed) {
			this.options.onStatus("closed", detail);
		}
	}

	private receive(socket: ParlumeTranscriptionSocket, data: unknown): void {
		const epoch = this.socketEpochMs;
		const event = readFluxEvent(data);
		if (this.socket !== socket || epoch === null || !event) {
			return;
		}
		const at = (seconds: number | null) =>
			epoch + Math.max(0, seconds ?? 0) * 1000;
		if (event.event === "StartOfTurn" || event.event === "Update") {
			if (!this.turnStarts.has(event.turnIndex)) {
				this.turnStarts.set(event.turnIndex, at(event.windowStart));
			}
			if (event.event === "StartOfTurn" || event.transcript) {
				this.options.onTranscript({
					text: event.transcript,
					isFinal: false,
					startMs:
						this.turnStarts.get(event.turnIndex) ??
						at(event.windowStart),
					endMs: at(event.windowEnd),
				});
			}
			return;
		}
		if (event.event !== "EndOfTurn") {
			return;
		}
		const startMs =
			this.turnStarts.get(event.turnIndex) ?? at(event.windowStart);
		this.turnStarts.delete(event.turnIndex);
		if (event.transcript) {
			this.options.onTranscript({
				text: event.transcript,
				isFinal: true,
				startMs,
				endMs: at(event.windowEnd),
			});
		}
	}
}
