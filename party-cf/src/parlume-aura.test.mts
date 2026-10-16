import assert from "node:assert/strict";
import test from "node:test";
import {
	type ParlumeAuraBinding,
	playParlumeAuraSentences,
	readParlumeSentenceLines,
} from "./parlume-aura.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Call = { text: string; inputs: Record<string, unknown>; options: unknown };

function pcmResponse(chunks: Uint8Array[], gapMs = 0, status = 200): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			async start(controller) {
				for (const chunk of chunks) {
					if (gapMs) {
						await sleep(gapMs);
					}
					controller.enqueue(chunk);
				}
				controller.close();
			},
		}),
		{ status },
	);
}

function binding(
	respond: (text: string, index: number) => Response | Promise<Response>,
) {
	const calls: Call[] = [];
	const ai: ParlumeAuraBinding = {
		run: async (_model, inputs, options) => {
			calls.push({
				text: inputs.text,
				inputs: { ...inputs },
				options,
			});
			return respond(inputs.text, calls.length - 1);
		},
	};
	return { ai, calls };
}

function outlet() {
	const events: string[] = [];
	const queued: Uint8Array[] = [];
	return {
		events,
		queued,
		bytes: () => queued.reduce((sum, chunk) => sum + chunk.byteLength, 0),
		enqueue: (bytes: Uint8Array) => {
			events.push(`enqueue ${bytes.byteLength}`);
			queued.push(bytes);
		},
		end: () => events.push("end"),
		clear: () => events.push("clear"),
		drained: async () => {
			events.push("drained");
		},
	};
}

async function* source(...texts: string[]): AsyncGenerator<string> {
	for (const text of texts) {
		yield text;
	}
}

const pcm = (length: number, fill = 1) => new Uint8Array(length).fill(fill);

test("asks Aura for Orpheus as raw 24 kHz linear PCM and plays what it returns", async () => {
	const { ai, calls } = binding(() => pcmResponse([pcm(480)]));
	const sink = outlet();

	const result = await playParlumeAuraSentences({
		ai,
		sentences: source("The plan is ready."),
		outlet: sink,
		isCurrent: () => true,
	});

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.inputs, {
		text: "The plan is ready.",
		speaker: "orpheus",
		encoding: "linear16",
		container: "none",
		sample_rate: 24_000,
	});
	assert.deepEqual(calls[0]?.options, { returnRawResponse: true });
	assert.equal(result.complete, true);
	assert.equal(result.failedAt, undefined);
	assert.equal(sink.bytes(), 480);
	assert.deepEqual(sink.events.slice(-2), ["end", "drained"]);
	assert.equal(typeof result.firstAudioAt, "number");
	assert.equal(result.sentences.length, 1);
	assert.equal(result.sentences[0]?.ok, true);
	assert.equal(result.sentences[0]?.chars, 18);
});

test("starts the next sentence's synthesis while the current one is still playing", async () => {
	const started: number[] = [];
	const origin = Date.now();
	const { ai } = binding((_text, index) => {
		started.push(Date.now() - origin);
		// The first clip streams for 150 ms; the second is ready at once.
		return index === 0
			? pcmResponse([pcm(100), pcm(100), pcm(100)], 50)
			: pcmResponse([pcm(100)]);
	});
	const sink = outlet();

	const result = await playParlumeAuraSentences({
		ai,
		sentences: source("First.", "Second."),
		outlet: sink,
		isCurrent: () => true,
	});

	assert.equal(result.complete, true);
	assert.equal(started.length, 2);
	assert.ok(
		(started[1] ?? 999) < 100,
		`second synthesis began at ${started[1]} ms, before the first finished`,
	);
	// Played in order: the first clip's three chunks, then the second's.
	assert.deepEqual(
		sink.events.filter((event) => event.startsWith("enqueue")),
		["enqueue 100", "enqueue 100", "enqueue 100", "enqueue 100"],
	);
	assert.equal(sink.bytes(), 400);
});

test("never ends the reply between sentences", async () => {
	const { ai } = binding(() => pcmResponse([pcm(200)]));
	const sink = outlet();

	await playParlumeAuraSentences({
		ai,
		sentences: source("One.", "Two.", "Three."),
		outlet: sink,
		isCurrent: () => true,
	});

	assert.equal(sink.events.filter((event) => event === "end").length, 1);
	assert.equal(sink.events.at(-2), "end");
});

test("keeps whole 16-bit samples when a chunk splits one", async () => {
	const { ai } = binding(() =>
		pcmResponse([
			Uint8Array.from([1, 2, 3]),
			Uint8Array.from([4, 5]),
			Uint8Array.from([6]),
		]),
	);
	const sink = outlet();

	await playParlumeAuraSentences({
		ai,
		sentences: source("Aligned."),
		outlet: sink,
		isCurrent: () => true,
	});

	assert.deepEqual(
		Array.from(sink.queued.flatMap((chunk) => Array.from(chunk))),
		[1, 2, 3, 4, 5, 6],
	);
	for (const chunk of sink.queued) {
		assert.equal(chunk.byteLength % 2, 0);
	}
});

test("drops a trailing half sample so the next sentence stays aligned", async () => {
	const { ai } = binding((_text, index) =>
		pcmResponse([index === 0 ? Uint8Array.from([1, 2, 3]) : pcm(4, 9)]),
	);
	const sink = outlet();

	await playParlumeAuraSentences({
		ai,
		sentences: source("Odd.", "Even."),
		outlet: sink,
		isCurrent: () => true,
	});

	assert.equal(sink.bytes() % 2, 0);
	assert.deepEqual(
		Array.from(sink.queued.flatMap((chunk) => Array.from(chunk))),
		[1, 2, 9, 9, 9, 9],
	);
});

test("reports the first sentence as failed when Aura answers with an error", async () => {
	const { ai } = binding(() => new Response("nope", { status: 500 }));
	const sink = outlet();

	const result = await playParlumeAuraSentences({
		ai,
		sentences: source("One.", "Two."),
		outlet: sink,
		isCurrent: () => true,
	});

	assert.equal(result.complete, false);
	assert.equal(result.failedAt, 0);
	assert.match(result.error ?? "", /HTTP 500/);
	assert.equal(sink.bytes(), 0);
	assert.ok(!sink.events.includes("drained"), "does not wait for a drain");
});

test("falls back from the sentence that failed and keeps the ones already played", async () => {
	const { ai } = binding((_text, index) => {
		if (index === 1) {
			throw new Error("Workers AI unavailable");
		}
		return pcmResponse([pcm(200)]);
	});
	const sink = outlet();

	const result = await playParlumeAuraSentences({
		ai,
		sentences: source("One.", "Two.", "Three."),
		outlet: sink,
		isCurrent: () => true,
	});

	assert.equal(result.complete, false);
	assert.equal(result.failedAt, 1);
	assert.equal(sink.bytes(), 200);
	assert.equal(result.sentences[0]?.ok, true);
	assert.equal(result.sentences[1]?.ok, false);
	// The queued first sentence still flushes; the replacement follows it.
	assert.equal(sink.events.at(-1), "end");
	assert.ok(!sink.events.includes("clear"));
});

test("a clip that dies midway is not repeated by the fallback", async () => {
	const { ai } = binding(
		() =>
			new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(pcm(300));
						await sleep(20);
						controller.error(new Error("connection reset"));
					},
				}),
			),
	);
	const sink = outlet();

	const result = await playParlumeAuraSentences({
		ai,
		sentences: source("One.", "Two."),
		outlet: sink,
		isCurrent: () => true,
	});

	assert.equal(
		result.failedAt,
		1,
		"resumes after the partly spoken sentence",
	);
	assert.equal(sink.bytes(), 300);
});

test("a response with no audio is a failure", async () => {
	const { ai } = binding(() => pcmResponse([]));
	const sink = outlet();

	const result = await playParlumeAuraSentences({
		ai,
		sentences: source("Silence."),
		outlet: sink,
		isCurrent: () => true,
	});

	assert.equal(result.failedAt, 0);
	assert.match(result.error ?? "", /no audio/);
});

test("a reply with no sentences is a failure the worker can recover from", async () => {
	const { ai, calls } = binding(() => pcmResponse([pcm(10)]));

	const result = await playParlumeAuraSentences({
		ai,
		sentences: source(),
		outlet: outlet(),
		isCurrent: () => true,
	});

	assert.equal(calls.length, 0);
	assert.equal(result.complete, false);
	assert.equal(result.failedAt, 0);
});

test("barge-in mid-sentence stops playback, clears the outlet and is not a failure", async () => {
	let current = true;
	const { ai } = binding(() =>
		pcmResponse([pcm(100), pcm(100), pcm(100), pcm(100)], 40),
	);
	const sink = outlet();

	const playing = playParlumeAuraSentences({
		ai,
		sentences: source("A long sentence.", "Another."),
		outlet: sink,
		isCurrent: () => current,
	});
	await sleep(70);
	current = false;
	const result = await playing;

	assert.equal(result.complete, false);
	assert.equal(result.failedAt, undefined);
	assert.ok(sink.bytes() < 400, "stopped before the clip finished");
	assert.equal(sink.events.at(-1), "clear");
	assert.ok(!sink.events.includes("end"));
});

test("a reply that is no longer current never asks Aura for anything", async () => {
	const { ai, calls } = binding(() => pcmResponse([pcm(10)]));

	const result = await playParlumeAuraSentences({
		ai,
		sentences: source("Stale."),
		outlet: outlet(),
		isCurrent: () => false,
	});

	assert.equal(calls.length, 0);
	assert.equal(result.complete, false);
});

test("times each sentence from its own request to its first and last byte", async () => {
	let clock = 1_000;
	const { ai } = binding((_text, index) =>
		pcmResponse([pcm(100), pcm(100)], index === 0 ? 30 : 0),
	);

	const result = await playParlumeAuraSentences({
		ai,
		sentences: source("Timed."),
		outlet: outlet(),
		isCurrent: () => true,
		now: () => {
			clock += 10;
			return clock;
		},
	});

	const [timing] = result.sentences;
	assert.equal(timing?.firstByteMs, 10);
	assert.equal(timing?.totalMs, 20);
	assert.equal(timing?.ok, true);
});

function bodyOf(...parts: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) {
				controller.enqueue(encoder.encode(part));
			}
			controller.close();
		},
	});
}

test("reads one sentence per line, whichever way the bytes are cut", async () => {
	const lines = JSON.stringify({ text: "First one." });
	const second = JSON.stringify({ text: "Second, with “quotes” é." });
	const bytes = new TextEncoder().encode(`${lines}\n${second}\n`);
	const cut = Math.floor(bytes.length / 2) + 3;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice(0, cut));
			controller.enqueue(bytes.slice(cut));
			controller.close();
		},
	});

	const read: string[] = [];
	for await (const text of readParlumeSentenceLines(body)) {
		read.push(text);
	}

	assert.deepEqual(read, ["First one.", "Second, with “quotes” é."]);
});

test("reads a last line that has no newline and skips blank lines", async () => {
	const read: string[] = [];
	for await (const text of readParlumeSentenceLines(
		bodyOf('{"text":"A."}\n\n', '{"text":"B."}'),
	)) {
		read.push(text);
	}
	assert.deepEqual(read, ["A.", "B."]);
});

test("refuses a line that is not a sentence", async () => {
	for (const bad of [
		"not json\n",
		'{"text":""}\n',
		'{"text":12}\n',
		"[]\n",
		`{"text":"${"x".repeat(2_001)}"}\n`,
	]) {
		await assert.rejects(
			async () => {
				for await (const _ of readParlumeSentenceLines(bodyOf(bad))) {
					// Reading.
				}
			},
			bad.slice(0, 20),
		);
	}
});

test("refuses more sentences than a reply can hold", async () => {
	const many = `${'{"text":"Hi."}\n'.repeat(41)}`;
	await assert.rejects(async () => {
		for await (const _ of readParlumeSentenceLines(bodyOf(many))) {
			// Reading.
		}
	}, /Too much text/);
});
