import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	type ParlumeReplayFixture,
	replayMeeting,
} from "../src/parlume-replay.mts";

// Records a replay fixture from real Deepgram Flux on Workers AI: each line of
// a dialogue is spoken with Aura, the lines are mixed on one timeline, and the
// mix streams to Flux in real time as the bridge would send it. Prints how
// Flux heard it and what the bridge then did with it.
//
//   node --experimental-strip-types scripts/parlume-flux-replay.mts \
//     --out src/fixtures/parlume-replay/two-speakers.json [--keyterm F-12]...
//
// The Workers AI token is read from CLOUDFLARE_AI_TOKEN_FILE (or
// --token-file) and never printed; the account from CLOUDFLARE_ACCOUNT_ID (or
// --account), or the token's only account.

interface DialogueLine {
	speaker: string;
	id: string;
	/** An Aura-2 speaker, such as `arcas` or `thalia`. */
	voice: string;
	text: string;
	/** Seconds this line starts before the previous one ends; negative is a pause. */
	overlap?: number;
}

interface Dialogue {
	/** Silence before the first line and after the last, in seconds. */
	leadIn: number;
	tail: number;
	lines: DialogueLine[];
	questions: ParlumeReplayFixture["questions"];
}

const TWO_SPEAKERS: Dialogue = {
	leadIn: 0.5,
	tail: 4,
	lines: [
		{
			speaker: "Dev Example",
			id: "participant-1",
			voice: "arcas",
			text: "The staging deploy finished last night, and the fabric team is still reading through the logs before we call it done.",
		},
		{
			speaker: "QA Example",
			id: "participant-2",
			voice: "thalia",
			text: "Parlume, what is the status of F-12?",
			overlap: 0.6,
		},
	],
	// Flux writes F-12 as "f twelve"; the bridge compares the words as heard.
	questions: [{ speaker: "QA Example", contains: "status of f" }],
};

const SAMPLE_RATE = 16_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
// Deepgram asks for Flux audio in 80 ms chunks, as the bridge sends it.
const BATCH_MS = 80;
// The bridge's own Flux settings (`openTranscription` in parlume.ts).
const EAGER_EOT_THRESHOLD = "0.5";
// How long Flux may still answer once the audio, its silent tail included,
// has been sent.
const DRAIN_MS = 2_000;
const API = "https://api.cloudflare.com/client/v4";

const { values } = parseArgs({
	options: {
		dialogue: { type: "string" },
		out: { type: "string" },
		keyterm: { type: "string", multiple: true },
		account: { type: "string" },
		"token-file": { type: "string" },
		"eot-threshold": { type: "string", default: "0.7" },
		speed: { type: "string", default: "10" },
	},
});

const dialogue: Dialogue = values.dialogue
	? JSON.parse(readFileSync(values.dialogue, "utf8"))
	: TWO_SPEAKERS;
const keyterms = values.keyterm?.length ? values.keyterm : ["Parlume"];
const tokenFile = values["token-file"] ?? process.env.CLOUDFLARE_AI_TOKEN_FILE;
if (!tokenFile) {
	throw new Error(
		"Name the file that holds a Workers AI token: pass --token-file or set CLOUDFLARE_AI_TOKEN_FILE.",
	);
}
const token = readFileSync(tokenFile, "utf8").trim();
const auth = { Authorization: `Bearer ${token}` };
const accountId =
	values.account ??
	process.env.CLOUDFLARE_ACCOUNT_ID ??
	(await onlyAccount());

async function onlyAccount(): Promise<string> {
	const response = await fetch(`${API}/accounts`, { headers: auth });
	const body = await response.json();
	const accounts: unknown[] =
		typeof body === "object" &&
		body !== null &&
		"result" in body &&
		Array.isArray(body.result)
			? body.result
			: [];
	const [account] = accounts;
	if (
		accounts.length !== 1 ||
		typeof account !== "object" ||
		account === null ||
		!("id" in account) ||
		typeof account.id !== "string"
	) {
		throw new Error(
			`The token lists ${accounts.length} accounts (HTTP ${response.status}); pass --account or set CLOUDFLARE_ACCOUNT_ID.`,
		);
	}
	return account.id;
}

async function speak(line: DialogueLine): Promise<Int16Array> {
	const response = await fetch(
		`${API}/accounts/${accountId}/ai/run/@cf/deepgram/aura-2-en`,
		{
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({
				text: line.text,
				speaker: line.voice,
				encoding: "linear16",
				container: "none",
				sample_rate: SAMPLE_RATE,
			}),
		},
	);
	if (
		!response.ok ||
		response.headers.get("content-type")?.includes("json")
	) {
		throw new Error(
			`Aura refused "${line.voice}": HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
		);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const pcm = withoutWavHeader(bytes);
	return new Int16Array(pcm.slice(0, pcm.length - (pcm.length % 2)).buffer);
}

// Aura is asked for raw PCM; a WAV header, if one comes anyway, is skipped.
function withoutWavHeader(bytes: Uint8Array): Uint8Array {
	if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") {
		return bytes;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset);
	for (let offset = 12; offset + 8 <= bytes.length; ) {
		const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
		const size = view.getUint32(offset + 4, true);
		if (id === "data") {
			return bytes.subarray(offset + 8, offset + 8 + size);
		}
		offset += 8 + size;
	}
	return bytes;
}

interface PlacedLine extends DialogueLine {
	start: number;
	end: number;
}

function mix(lines: DialogueLine[], speech: Int16Array[]) {
	const placed: PlacedLine[] = [];
	let cursor = dialogue.leadIn;
	lines.forEach((line, index) => {
		const start = Math.max(
			0,
			index === 0 ? cursor : cursor - (line.overlap ?? 0),
		);
		const end = start + speech[index].length / SAMPLE_RATE;
		placed.push({ ...line, start, end });
		cursor = end;
	});
	const total = Math.ceil(
		(Math.max(...placed.map((line) => line.end)) + dialogue.tail) *
			SAMPLE_RATE,
	);
	const sum = new Float64Array(total);
	placed.forEach((line, index) => {
		const offset = Math.round(line.start * SAMPLE_RATE);
		speech[index].forEach((sample, at) => {
			sum[offset + at] += sample;
		});
	});
	const pcm = new Int16Array(total);
	sum.forEach((sample, at) => {
		pcm[at] = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
	});
	return { placed, pcm };
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function transcribe(pcm: Int16Array) {
	const query = new URLSearchParams({
		encoding: "linear16",
		sample_rate: String(SAMPLE_RATE),
		eot_threshold: values["eot-threshold"],
		eager_eot_threshold: EAGER_EOT_THRESHOLD,
	});
	for (const term of keyterms) {
		query.append("keyterm", term);
	}
	const socket = new WebSocket(
		`wss://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/deepgram/flux?${query}`,
		{ headers: auth },
	);
	socket.binaryType = "arraybuffer";
	const events: ParlumeReplayFixture["flux"] = [];
	let startedAt = 0;
	socket.addEventListener("message", (message) => {
		const at = (performance.now() - startedAt) / 1000;
		if (typeof message.data === "string") {
			// The provider's request id stays out of the fixture; the bridge
			// never reads it.
			const event: Record<string, unknown> = JSON.parse(message.data);
			delete event.request_id;
			events.push({ at: Number(at.toFixed(3)), event });
		}
	});
	const closed = new Promise<string>((resolve) =>
		socket.addEventListener("close", (event) =>
			resolve(`${event.code} ${event.reason}`.trim()),
		),
	);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () =>
			reject(new Error("The Flux socket failed to open.")),
		);
	});
	const bytes = new Uint8Array(pcm.buffer);
	const batchBytes = BYTES_PER_MS * BATCH_MS;
	startedAt = performance.now();
	for (let batch = 0; batch * batchBytes < bytes.length; batch++) {
		const wait = startedAt + batch * BATCH_MS - performance.now();
		if (wait > 0) {
			await sleep(wait);
		}
		socket.send(bytes.slice(batch * batchBytes, (batch + 1) * batchBytes));
	}
	await sleep(DRAIN_MS);
	socket.close(1000, "recording finished");
	return { events, closed: await Promise.race([closed, sleep(2_000)]) };
}

// Case, punctuation and a hyphen inside a word ("F-12" or "F12") are ignored.
const words = (text: string) =>
	text
		.toLowerCase()
		.replace(/(?<=[\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(" ")
		.filter(Boolean);

function wordErrorRate(expected: string, heard: string): number {
	const ref = words(expected);
	const hyp = words(heard);
	let previous = hyp.map((_, index) => index + 1);
	previous.unshift(0);
	for (let i = 1; i <= ref.length; i++) {
		const row = [i];
		for (let j = 1; j <= hyp.length; j++) {
			row[j] = Math.min(
				previous[j] + 1,
				row[j - 1] + 1,
				previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
			);
		}
		previous = row;
	}
	return ref.length ? previous[hyp.length] / ref.length : 0;
}

// A turn's span on the audio clock: its words when Flux sends their times,
// else the window it reports.
function turnSpan(event: Record<string, unknown>): [number, number] {
	const timed = Array.isArray(event.words)
		? event.words.filter(
				(word): word is { start: number; end: number } =>
					typeof word?.start === "number" &&
					typeof word?.end === "number",
			)
		: [];
	if (timed.length) {
		return [timed[0].start, timed[timed.length - 1].end];
	}
	return [
		Number(event.audio_window_start ?? 0),
		Number(event.audio_window_end ?? 0),
	];
}

const eventType = (event: Record<string, unknown>) =>
	String(event.event ?? event.type);

function score(placed: PlacedLine[], events: ParlumeReplayFixture["flux"]) {
	const turns = events.filter(({ event }) => event.event === "EndOfTurn");
	const heardBy = new Map<number, typeof turns>();
	for (const turn of turns) {
		const [start, end] = turnSpan(turn.event);
		let best = -1;
		let bestOverlap = 0;
		placed.forEach((line, index) => {
			const overlap =
				Math.min(end, line.end) - Math.max(start, line.start);
			if (overlap > bestOverlap) {
				best = index;
				bestOverlap = overlap;
			}
		});
		heardBy.set(best, [...(heardBy.get(best) ?? []), turn]);
	}
	const lines = placed.map((line, index) => {
		const heard = heardBy.get(index) ?? [];
		const transcript = heard
			.map(({ event }) => String(event.transcript ?? ""))
			.join(" ");
		const last = heard.at(-1);
		return {
			speaker: line.speaker,
			expected: line.text,
			heard: transcript,
			wer: Number(wordErrorRate(line.text, transcript).toFixed(3)),
			endOfTurnLatencyMs: last
				? Math.round((last.at - line.end) * 1000)
				: null,
		};
	});
	const allHeard = words(
		turns.map(({ event }) => String(event.transcript ?? "")).join(" "),
	).join(" ");
	return {
		keyterms: keyterms.map((term) => ({
			term,
			heard: ` ${allHeard} `.includes(` ${words(term).join(" ")} `),
		})),
		lines,
		turnsOnNoLine: (heardBy.get(-1) ?? []).map(({ event }) =>
			String(event.transcript ?? ""),
		),
		// Flux's `Connected` message has a `type` and no `event`.
		eventCounts: Object.fromEntries(
			[...new Set(events.map(({ event }) => eventType(event)))].map(
				(type) => [
					type,
					events.filter(({ event }) => eventType(event) === type)
						.length,
				],
			),
		),
	};
}

const speech = await Promise.all(dialogue.lines.map(speak));
const { placed, pcm } = mix(dialogue.lines, speech);
const { events, closed } = await transcribe(pcm);
const fixture: ParlumeReplayFixture = {
	source: `A recording of real Workers AI Flux (eot_threshold ${values["eot-threshold"]}, eager_eot_threshold ${EAGER_EOT_THRESHOLD}, keyterms ${keyterms.join(", ")}) hearing synthetic Aura-2 voices (${dialogue.lines.map((line) => `${line.speaker}: ${line.voice}`).join(", ")}), made by scripts/parlume-flux-replay.mts on ${new Date().toISOString().slice(0, 10)}. Speech updates are the known timeline, delivered when they happened.`,
	audio: [{ at: 0, seconds: Number((pcm.length / SAMPLE_RATE).toFixed(2)) }],
	speech: placed.flatMap((line) => [
		{
			at: Number(line.start.toFixed(3)),
			name: line.speaker,
			id: line.id,
			speaking: true,
		},
		{
			at: Number(line.end.toFixed(3)),
			name: line.speaker,
			id: line.id,
			speaking: false,
		},
	]),
	flux: events,
	questions: dialogue.questions,
};
if (values.out) {
	writeFileSync(values.out, `${JSON.stringify(fixture, null, "\t")}\n`);
}
console.log(
	JSON.stringify(
		{
			timeline: placed.map(({ speaker, start, end }) => ({
				speaker,
				start: Number(start.toFixed(2)),
				end: Number(end.toFixed(2)),
			})),
			fluxClosed: closed ?? "still open",
			flux: score(placed, events),
			bridge: await replayMeeting(fixture, {
				speed: Number(values.speed),
			}),
		},
		null,
		2,
	),
);
