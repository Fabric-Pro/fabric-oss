// @vitest-environment node
import { createAgentResponseLifetime } from "@saas/agents/runtime/response-lifetime";
import { ReflectAdapter } from "next/dist/server/web/spec-extension/adapters/reflect";
import { describe, expect, it, vi } from "vitest";

const URL = "https://example.com/api/agents/runtime/agent/atlas-chat/run";
const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8" };

function request(signal?: AbortSignal) {
	return new Request(URL, {
		method: "POST",
		headers: { "content-type": "application/json", "x-example": "kept" },
		body: '{"threadId":"example-thread"}',
		signal,
	});
}

async function withAgentResponseLifetime(
	input: Request,
	handle: (routed: Request) => Promise<Response>,
) {
	const lifetime = createAgentResponseLifetime(input);
	return lifetime.response(await handle(lifetime.request));
}

describe("agent response lifetime", () => {
	it("preserves request content and response bytes, status and headers on completion", async () => {
		let signal: AbortSignal | undefined;
		const chunk = new TextEncoder().encode(
			'data: {"type":"RUN_FINISHED"}\n\n',
		);
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk);
				controller.close();
			},
		});
		const response = await withAgentResponseLifetime(
			request(),
			async (routed) => {
				signal = routed.signal;
				expect(routed.method).toBe("POST");
				expect(routed.url).toBe(URL);
				expect(routed.headers.get("x-example")).toBe("kept");
				expect(await routed.json()).toEqual({
					threadId: "example-thread",
				});
				return new Response(source, {
					status: 202,
					statusText: "Accepted",
					headers: { ...SSE_HEADERS, "x-example": "response" },
				});
			},
		);

		expect(response.status).toBe(202);
		expect(response.statusText).toBe("Accepted");
		expect(response.headers.get("content-type")).toBe(
			SSE_HEADERS["content-type"],
		);
		expect(response.headers.get("x-example")).toBe("response");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(chunk);
		expect(signal?.aborted).toBe(false);
		expect(source.locked).toBe(false);
	});

	it("aborts the SDK signal before cancelling a pending reader, without aborting the caller", async () => {
		const client = new AbortController();
		let signal: AbortSignal | undefined;
		const cancel = vi.fn(() => expect(signal?.aborted).toBe(true));
		const source = new ReadableStream<Uint8Array>({ cancel });
		const response = await withAgentResponseLifetime(
			request(client.signal),
			async (routed) => {
				signal = routed.signal;
				return new Response(source, { headers: SSE_HEADERS });
			},
		);
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("Expected an SSE response body");
		}
		const pending = reader.read();
		await reader.cancel("tab closed");

		expect(await pending).toEqual({ done: true, value: undefined });
		expect(signal?.reason).toBe("tab closed");
		expect(client.signal.aborted).toBe(false);
		expect(cancel).toHaveBeenCalledExactlyOnceWith("tab closed");
		expect(source.locked).toBe(false);
		reader.releaseLock();
	});

	it("retains incoming request aborts", async () => {
		const client = new AbortController();
		let signal: AbortSignal | undefined;
		const response = await withAgentResponseLifetime(
			request(client.signal),
			async (routed) => {
				signal = routed.signal;
				return new Response(null, { headers: SSE_HEADERS });
			},
		);
		client.abort("client abort");
		expect(signal?.aborted).toBe(true);
		expect(signal?.reason).toBe("client abort");
		expect(response.body).toBeNull();
	});

	it("detaches and unlocks an errored source while preserving the read error", async () => {
		const error = new Error("stream failed");
		let signal: AbortSignal | undefined;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(error);
			},
		});
		const response = await withAgentResponseLifetime(
			request(),
			async (routed) => {
				signal = routed.signal;
				return new Response(source, { headers: SSE_HEADERS });
			},
		);

		await expect(response.text()).rejects.toBe(error);
		expect(signal?.aborted).toBe(true);
		expect(source.locked).toBe(false);
	});

	it("unlocks the source if cancellation rejects", async () => {
		const error = new Error("cancel failed");
		const source = new ReadableStream<Uint8Array>({
			cancel() {
				throw error;
			},
		});
		const response = await withAgentResponseLifetime(
			request(),
			async () => new Response(source, { headers: SSE_HEADERS }),
		);
		await expect(response.body?.cancel()).rejects.toBe(error);
		expect(source.locked).toBe(false);
	});

	it("propagates a source error through both response wrappers and the SDK tee", async () => {
		const lifetime = createAgentResponseLifetime(request());
		const error = new Error("source failed after headers");
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(error);
			},
		});
		const inner = lifetime.response(
			new Response(source, { headers: SSE_HEADERS }),
		);
		const sdkCopy = inner.clone();
		const outer = lifetime.response(inner);

		await expect(outer.text()).rejects.toBe(error);
		await expect(sdkCopy.text()).rejects.toBe(error);
		expect(source.locked).toBe(false);
	});

	it("leaves a non-streaming response untouched", async () => {
		const original = Response.json({ stopped: true });
		const response = await withAgentResponseLifetime(
			request(),
			async () => original,
		);
		expect(response).toBe(original);
		expect(await response.json()).toEqual({ stopped: true });
	});

	it("passes GET requests through without cloning Next's proxy", async () => {
		const target = new Request(
			"https://example.com/api/agents/runtime/info",
		);
		const original = new Proxy(target, {
			get: (target, property) =>
				ReflectAdapter.get(target, property, target),
		});
		const response = Response.json({ agents: [] });
		const handle = vi.fn(async () => response);
		expect(await withAgentResponseLifetime(original, handle)).toBe(
			response,
		);
		expect(handle).toHaveBeenCalledExactlyOnceWith(original);
	});
});
