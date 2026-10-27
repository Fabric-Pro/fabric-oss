// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
	type DirectStreamEvent,
	encodeDirectStreamEvent,
	parseDirectStreamEvent,
} from "../direct-stream-protocol";
import {
	INTERRUPTED_STREAM_MESSAGE,
	readDirectStream,
} from "../read-direct-stream";

function stream(chunks: Uint8Array[]) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
}

const encode = (value: string) => new TextEncoder().encode(value);

describe("Direct chat wire protocol", () => {
	it("reads both legacy and versioned producers", () => {
		const event = { type: "text", content: "hello" } as const;
		expect(parseDirectStreamEvent(event)).toEqual(event);
		expect(
			parseDirectStreamEvent(
				JSON.parse(encodeDirectStreamEvent(event).slice(6)),
			),
		).toEqual(event);
	});

	it("ignores unknown event kinds but rejects incompatible versions and malformed known events", () => {
		expect(
			parseDirectStreamEvent({ type: "future_event", version: 1 }),
		).toBeNull();
		expect(() =>
			parseDirectStreamEvent({
				type: "text",
				version: 2,
				content: "hello",
			}),
		).toThrow("unsupported version");
		expect(() =>
			parseDirectStreamEvent({
				type: "text",
				content: { secret: "synthetic" },
			}),
		).toThrow("invalid event");
		expect(() =>
			parseDirectStreamEvent({
				type: "done",
				usage: { inputTokens: "100" },
			}),
		).toThrow("invalid event");
	});
});

describe("Direct chat SSE transport", () => {
	it("finishes on done even if the server keeps the connection open", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encode(encodeDirectStreamEvent({ type: "done" })),
				);
			},
			cancel,
		});
		await readDirectStream(body, vi.fn());
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("handles every byte boundary, Unicode, CRLF, comments, and multiline data", async () => {
		const bytes = encode(
			': heartbeat\r\ndata:{"type":"text",\r\ndata: "content":"Hello 🌍"}\r\n\r\ndata: {"type":"done","version":1}\r\n\r\n',
		);
		const events: DirectStreamEvent[] = [];
		const body = stream(Array.from(bytes, (byte) => Uint8Array.of(byte)));
		await readDirectStream(body, (event) => events.push(event));
		expect(events).toEqual([
			{ type: "text", content: "Hello 🌍" },
			{ type: "done" },
		]);
		expect(body.locked).toBe(false);
	});

	it.each([
		"",
		'data: {"type":"text","content":"partial"}\n\n',
		'data: {"type":"done"}\n',
		'data: {"type":"done"}',
	])("never treats EOF as successful completion: %s", async (wire) => {
		const body = stream([encode(wire)]);
		await expect(readDirectStream(body, vi.fn())).rejects.toThrow(
			INTERRUPTED_STREAM_MESSAGE,
		);
		expect(body.locked).toBe(false);
	});

	it("preserves error followed by usage metadata, and ignores deltas after done", async () => {
		const expected: DirectStreamEvent[] = [
			{ type: "text", content: "partial" },
			{ type: "error", message: "Provider unavailable", partial: true },
			{ type: "done", usage: { inputTokens: 10 } },
		];
		const wire = [...expected, { type: "text", content: "late" } as const]
			.map(encodeDirectStreamEvent)
			.join("");
		const onEvent = vi.fn();
		await readDirectStream(stream([encode(wire)]), onEvent);
		expect(onEvent.mock.calls.map(([event]) => event)).toEqual(expected);
	});

	it("accepts error-only completion", async () => {
		await expect(
			readDirectStream(
				stream([
					encode(
						encodeDirectStreamEvent({
							type: "error",
							message: "Stopped",
						}),
					),
				]),
				vi.fn(),
			),
		).resolves.toBeUndefined();
	});

	it("does not swallow consumer exceptions", async () => {
		const body = stream([
			encode(encodeDirectStreamEvent({ type: "done" })),
		]);
		await expect(
			readDirectStream(body, () => {
				throw new Error("consumer failed");
			}),
		).rejects.toThrow("consumer failed");
		expect(body.locked).toBe(false);
	});

	it("propagates cancellation and releases the reader", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new DOMException("Stopped", "AbortError"));
			},
		});
		await expect(readDirectStream(body, vi.fn())).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(body.locked).toBe(false);
	});
});
