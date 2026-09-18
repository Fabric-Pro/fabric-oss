/**
 * Downloading the bundle (Fizzy #2539, review round 2 finding 7).
 *
 * `arrayBuffer()` buffered whatever the server sent before anything could
 * look at it, so a malformed or hostile response sized the allocation itself.
 * The bound now comes from the manifest, which has already been checked
 * against the published snapshot limits, and it is enforced twice: against a
 * declared `Content-Length` before the body is read, and against the bytes
 * actually arriving.
 */
import { describe, expect, it } from "vitest";
import { fetchBundle } from "../src/lib/instructions/bundle.js";

/** A response whose body arrives in pieces, like a real one. */
function streamed(chunks: Uint8Array[], headers: HeadersInit = {}): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
	return new Response(stream, { headers });
}

function chunk(size: number): Uint8Array {
	return new Uint8Array(size).fill(7);
}

function serving(response: Response): typeof fetch {
	return (async () => response) as unknown as typeof fetch;
}

describe("fetchBundle", () => {
	it("returns the archive when it fits", async () => {
		const archive = await fetchBundle("https://example.com/a.zip", {
			timeoutMs: 1000,
			maxBytes: 4096,
			fetchImpl: serving(streamed([chunk(100), chunk(50)])),
		});

		expect(archive.length).toBe(150);
	});

	/**
	 * The declared length is refused on its own, without draining the body:
	 * this one never ends, so reaching the mid-stream check would either hang
	 * or report the other message.
	 */
	it("refuses a declared Content-Length above the bound", async () => {
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(chunk(1024));
			},
		});
		const response = new Response(endless, {
			headers: { "content-length": "999999" },
		});

		await expect(
			fetchBundle("https://example.com/a.zip", {
				timeoutMs: 1000,
				maxBytes: 4096,
				fetchImpl: serving(response),
			}),
		).rejects.toThrow(/declares 999999 bytes/);
	});

	/**
	 * The interesting one: a server that lies about its length, or sends none
	 * at all, must still not be able to make the client allocate without
	 * limit.
	 */
	it("abandons a body that grows past the bound mid-stream", async () => {
		const sent: number[] = [];
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				sent.push(1024);
				controller.enqueue(chunk(1024));
			},
		});

		await expect(
			fetchBundle("https://example.com/a.zip", {
				timeoutMs: 1000,
				maxBytes: 4096,
				fetchImpl: serving(new Response(stream)),
			}),
		).rejects.toThrow(/larger than the 4096 bytes/);
		// Bounded by the cap plus one chunk, not by the (endless) body.
		expect(sent.length).toBeLessThanOrEqual(6);
	});

	it("length-checks a body it cannot read in pieces", async () => {
		const response = new Response("x".repeat(200));
		Object.defineProperty(response, "body", { value: null });

		await expect(
			fetchBundle("https://example.com/a.zip", {
				timeoutMs: 1000,
				maxBytes: 100,
				fetchImpl: serving(response),
			}),
		).rejects.toThrow(/larger than the 100 bytes/);
	});

	it("reports a failed download by status", async () => {
		await expect(
			fetchBundle("https://example.com/a.zip", {
				timeoutMs: 1000,
				maxBytes: 4096,
				fetchImpl: serving(new Response("nope", { status: 503 })),
			}),
		).rejects.toThrow(/HTTP 503/);
	});

	it("abandons the request when the caller's deadline is already spent", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			fetchBundle("https://example.com/a.zip", {
				timeoutMs: 1000,
				maxBytes: 4096,
				signal: controller.signal,
				fetchImpl: (async (_url: string, init?: RequestInit) => {
					if (init?.signal?.aborted) {
						const error = new Error("aborted");
						error.name = "AbortError";
						throw error;
					}
					return new Response("");
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow(/timed out/);
	});
});
