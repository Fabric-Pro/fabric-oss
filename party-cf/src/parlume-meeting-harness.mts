import { loadParlumeModule } from "./parlume-test-runtime.mts";

// A meeting around the bridge for its tests: a fake bot socket, Flux, Aura,
// storage and Fabric, and the requests the worker sends it.

class FakeFlux {
	accepted = false;
	sent: number[] = [];
	private listeners = new Map<string, ((event: unknown) => void)[]>();
	accept() {
		this.accepted = true;
	}
	send(data: ArrayBuffer) {
		this.sent.push(data.byteLength);
	}
	close() {}
	addEventListener(type: string, listener: (event: unknown) => void) {
		this.listeners.set(type, [
			...(this.listeners.get(type) ?? []),
			listener,
		]);
	}
	turn(event: Record<string, unknown>) {
		for (const listener of this.listeners.get("message") ?? []) {
			listener({ data: JSON.stringify(event) });
		}
	}
}

export type Bridge = {
	onStart(): Promise<void>;
	onConnect(conn: unknown, ctx: { request: { url: string } }): Promise<void>;
	onMessage(
		conn: unknown,
		message: string | ArrayBuffer | ArrayBufferView,
	): Promise<void>;
	onRequest(request: Request): Promise<Response>;
	onClose(conn: unknown, code?: number, reason?: string): Promise<void>;
};

export function meeting(
	options: {
		verify?: () => Promise<Response>;
		aura?: (text: string, index: number) => Response | Promise<Response>;
		/** Holds Fabric's answer to a request until it resolves. */
		fabricDelay?: (path: string) => Promise<void>;
		suggestionsEnabled?: boolean;
	} = {},
) {
	const auraCalls: Array<{ inputs: unknown; options: unknown }> = [];
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const fetch = async (url: unknown, init: unknown) => {
		const path = new URL(String(url)).pathname;
		const body = JSON.parse(String((init as RequestInit).body));
		requests.push({ path, body });
		await options.fabricDelay?.(path);
		if (path.endsWith("/verify-stream")) {
			return (
				(await options.verify?.()) ??
				Response.json({
					valid: true,
					hardStopAt: new Date(Date.now() + 3_600_000).toISOString(),
					streamGeneration: 1,
					suggestionsEnabled: options.suggestionsEnabled ?? false,
				})
			);
		}
		return Response.json({ accepted: true });
	};
	const data = new Map<string, unknown>();
	const alarms: number[] = [];
	const storage = {
		get: async (key: string) => data.get(key),
		put: async (key: string | Record<string, unknown>, value?: unknown) => {
			if (typeof key === "string") {
				data.set(key, value);
			} else {
				for (const [k, v] of Object.entries(key)) {
					data.set(k, v);
				}
			}
		},
		delete: async (key: string) => data.delete(key),
		setAlarm: async (at: number) => {
			alarms.push(at);
		},
		getAlarm: async () => alarms.at(-1) ?? null,
	};
	const meetingOptions = options;
	const flux = new FakeFlux();
	const transcription: Array<{
		model: string;
		inputs: unknown;
		options: unknown;
	}> = [];
	const { Parlume } = loadParlumeModule("./parlume.ts", fetch) as {
		Parlume: new (ctx: unknown, env: unknown) => Bridge;
	};
	const bridge = new Parlume(
		{ storage },
		{
			FABRIC_API_URL: "https://fabric.example",
			AGENT_SERVICE_SECRET: "service-secret",
			AI: {
				run: async (
					model: string,
					inputs: unknown,
					options: unknown,
				) => {
					if (model === "@cf/deepgram/aura-2-en") {
						auraCalls.push({ inputs, options });
						const text = (inputs as { text: string }).text;
						return (
							(await meetingOptions.aura?.(
								text,
								auraCalls.length - 1,
							)) ?? new Response(new Uint8Array(4_800))
						);
					}
					transcription.push({ model, inputs, options });
					return { status: 101, webSocket: flux };
				},
			},
		},
	);
	const sent: string[] = [];
	const closed: number[] = [];
	const bot = {
		send: (message: string) => sent.push(message),
		close: (code: number) => closed.push(code),
	};
	return {
		bridge,
		bot,
		flux,
		sent,
		closed,
		requests,
		transcription,
		auraCalls,
		alarms,
	};
}

// Objects built inside the sandboxed bridge have that realm's prototypes.
export const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
export const flush = () => new Promise((resolve) => setImmediate(resolve));
export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const STREAM_URL =
	"wss://bridge.example.com/parties/parlume/session-1?token=stream-token";

// Attendee's mixed-audio message: one 10 ms chunk at 16 kHz, stamped when it
// was packaged. Flux receives the meeting audio in 80 ms batches.
export function audio(
	timestampMs: number,
	options: { botId?: string; sampleRate?: number; bytes?: number } = {},
) {
	const { botId = "bot_abc123", sampleRate = 16_000, bytes = 320 } = options;
	return JSON.stringify({
		trigger: "realtime_audio.mixed",
		bot_id: botId,
		data: {
			chunk: Buffer.alloc(bytes).toString("base64"),
			timestamp_ms: timestampMs,
			sample_rate: sampleRate,
		},
	});
}

export function control(
	action: string,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return new Request(
		`https://bridge.example.com/parties/parlume/session-1?action=${action}`,
		{
			method: "POST",
			headers: {
				Authorization: "Bearer service-secret",
				"content-type": "application/json",
				...headers,
			},
			body: JSON.stringify(body),
		},
	);
}

export function say(
	sentences: string[],
	headers: Record<string, string> = {},
	generation = "0",
) {
	return new Request(
		"https://bridge.example.com/parties/parlume/session-1?action=say",
		{
			method: "POST",
			headers: {
				Authorization: "Bearer service-secret",
				"content-type": "application/x-ndjson",
				"x-parlume-voice-generation": generation,
				...headers,
			},
			body: sentences
				.map((text) => `${JSON.stringify({ text })}\n`)
				.join(""),
		},
	);
}

export async function connectedMeeting(
	options: Parameters<typeof meeting>[0] = {},
) {
	const harness = meeting(options);
	await harness.bridge.onStart();
	await harness.bridge.onConnect(harness.bot, {
		request: { url: STREAM_URL },
	});
	for (let end = 1_000_010; end <= 1_000_080; end += 10) {
		await harness.bridge.onMessage(harness.bot, audio(end));
	}
	await flush();
	return harness;
}

// Aura that takes about 800 ms to stream one sentence, so speech can land on it.
export const slowAura = () =>
	new Response(
		new ReadableStream<Uint8Array>({
			async start(controller) {
				for (let part = 0; part < 20; part++) {
					controller.enqueue(new Uint8Array(4_800));
					await sleep(40);
				}
				controller.close();
			},
		}),
	);

export async function answeringMeeting() {
	const harness = await connectedMeeting({ aura: slowAura });
	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.01,
		audio_window_end: 0.05,
		transcript: "Hey Fabric, what is the plan?",
	});
	for (
		let waited = 0;
		waited < 2_000 &&
		!harness.requests.some((r) => r.path.endsWith("/turns"));
		waited += 20
	) {
		await sleep(20);
	}
	return harness;
}
