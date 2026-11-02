// @vitest-environment node
import { createRequire } from "node:module";
import {
	MAX_AGENT_REQUEST_BODY_BYTES,
	withBoundedAgentRequestBody,
} from "@saas/agents/runtime/request-body";
import { ReflectAdapter } from "next/dist/server/web/spec-extension/adapters/reflect";
import { describe, expect, it, vi } from "vitest";

function streamedRequest(chunks: Uint8Array[], contentLength?: string) {
	const pull = vi.fn(
		(controller: ReadableStreamDefaultController<Uint8Array>) => {
			const chunk = chunks.shift();
			if (chunk) {
				controller.enqueue(chunk);
			} else {
				controller.close();
			}
		},
	);
	const cancel = vi.fn();
	const init: RequestInit & { duplex: string } = {
		method: "POST",
		headers: contentLength ? { "content-length": contentLength } : {},
		body: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
		duplex: "half",
	};
	return {
		request: new Request("https://example.com/agent/run", init),
		pull,
		cancel,
	};
}

describe("agent request transport bound", () => {
	it.each(["direct AI", "AI SDK provider"])(
		"reconstructs Next request proxies with %s private-field Request",
		async (consumer) => {
			const aiRequire = createRequire(import.meta.resolve("@repo/ai"));
			const providerRequire = createRequire(
				createRequire(aiRequire.resolve("ai")).resolve(
					"@ai-sdk/provider-utils",
				),
			);
			const consumerRequire =
				consumer === "direct AI" ? aiRequire : providerRequire;
			const { Request: PrivateRequest }: { Request: typeof Request } =
				consumerRequire("undici");
			vi.stubGlobal("Request", PrivateRequest);
			try {
				const controller = new AbortController();
				const target = new PrivateRequest(
					"https://example.com/agent/run?source=chat",
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-example": "kept",
						},
						body: '{"threadId":"synthetic-thread","messages":[]}',
						signal: controller.signal,
						cache: "no-store",
						credentials: "include",
						mode: "cors",
						redirect: "manual",
						referrer: "https://example.com/app",
						referrerPolicy: "same-origin",
						integrity:
							"sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
						keepalive: true,
					},
				);
				// Next's App Route proxy uses this adapter with the target as receiver.
				const request = new Proxy(target, {
					get: (target, property) =>
						ReflectAdapter.get(target, property, target),
				});
				const result = await withBoundedAgentRequestBody(request);
				if (!(result instanceof PrivateRequest)) {
					throw new Error("Expected a reconstructed request");
				}
				expect(result.url).toBe(target.url);
				expect(result.method).toBe(target.method);
				expect(result.headers.get("x-example")).toBe("kept");
				for (const field of [
					"cache",
					"credentials",
					"mode",
					"redirect",
					"referrer",
					"referrerPolicy",
					"integrity",
					"keepalive",
				] as const) {
					expect(result[field]).toBe(target[field]);
				}
				expect(await result.clone().json()).toEqual({
					threadId: "synthetic-thread",
					messages: [],
				});
				controller.abort();
				expect(result.signal.aborted).toBe(true);
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);
	it("rejects an announced excess without reading and cancels the stream", async () => {
		const { request, pull, cancel } = streamedRequest(
			[new Uint8Array([1])],
			String(MAX_AGENT_REQUEST_BODY_BYTES + 1),
		);
		const result = await withBoundedAgentRequestBody(request);
		expect(result).toBeInstanceOf(Response);
		if (!(result instanceof Response)) {
			throw new Error("Expected a refusal");
		}
		expect(result.status).toBe(413);
		expect(pull).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it.each([undefined, "1", "not-a-length"])(
		"counts actual bytes with content-length=%s and cancels on excess",
		async (declaredLength) => {
			const { request, cancel, pull } = streamedRequest(
				[
					new Uint8Array(MAX_AGENT_REQUEST_BODY_BYTES),
					new Uint8Array([1]),
					new Uint8Array([2]),
				],
				declaredLength,
			);
			const result = await withBoundedAgentRequestBody(request);
			expect(result).toBeInstanceOf(Response);
			if (!(result instanceof Response)) {
				throw new Error("Expected a refusal");
			}
			expect(result.status).toBe(413);
			expect(pull).toHaveBeenCalledTimes(2);
			expect(cancel).toHaveBeenCalledOnce();
		},
	);

	it("accepts exactly the byte cap with multibyte UTF-8 split across chunks", async () => {
		const text = `${"x".repeat(MAX_AGENT_REQUEST_BODY_BYTES - 4)}🎵`;
		const bytes = new TextEncoder().encode(text);
		const { request, cancel } = streamedRequest(
			[bytes.slice(0, bytes.length - 2), bytes.slice(bytes.length - 2)],
			"1",
		);
		const result = await withBoundedAgentRequestBody(request);
		expect(result).toBeInstanceOf(Request);
		if (!(result instanceof Request)) {
			throw new Error("Expected a buffered request");
		}
		expect(result.headers.get("content-length")).toBe(String(bytes.length));
		expect(await result.text()).toBe(text);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("counts multibyte UTF-8 as bytes, not characters", async () => {
		const { request } = streamedRequest([
			new TextEncoder().encode(
				`${"x".repeat(MAX_AGENT_REQUEST_BODY_BYTES - 1)}é`,
			),
		]);
		const result = await withBoundedAgentRequestBody(request);
		expect(result).toBeInstanceOf(Response);
	});

	it("preserves headers, malformed JSON bytes and the caller's abort signal", async () => {
		const controller = new AbortController();
		const request = new Request("https://example.com/agent/run", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-example": "kept",
			},
			body: "{broken",
			signal: controller.signal,
		});
		const result = await withBoundedAgentRequestBody(request);
		if (!(result instanceof Request)) {
			throw new Error("Expected a buffered request");
		}
		expect(result.url).toBe(request.url);
		expect(result.headers.get("x-example")).toBe("kept");
		expect(await result.clone().text()).toBe("{broken");
		await expect(result.json()).rejects.toBeInstanceOf(SyntaxError);
		controller.abort();
		expect(result.signal.aborted).toBe(true);
	});

	it("leaves GET/info and bodyless POST requests untouched", async () => {
		for (const method of ["GET", "POST"]) {
			const request = new Request("https://example.com/info", { method });
			expect(await withBoundedAgentRequestBody(request)).toBe(request);
		}
	});
});
