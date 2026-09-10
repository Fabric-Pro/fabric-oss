import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLLMTelemetryMiddleware } from "../llm-telemetry-middleware";

describe("AI SDK LLM telemetry middleware", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		trace.disable();
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		trace.setGlobalTracerProvider(provider);
	});

	afterEach(async () => {
		await provider.shutdown();
		trace.disable();
	});

	function middleware() {
		return createLLMTelemetryMiddleware({
			provider: "OPENAI_DIRECT",
			model: "gpt-5-mini",
		}) as any;
	}

	function exportedData(
		span: ReturnType<InMemorySpanExporter["getFinishedSpans"]>[number],
	) {
		return JSON.stringify({
			attributes: span.attributes,
			status: span.status,
			events: span.events,
		});
	}

	it("records generate success and usage on a real span", async () => {
		const response = {
			usage: {
				inputTokens: { total: 23, noCache: 20, cacheRead: 3 },
				outputTokens: { total: 11, text: 9, reasoning: 2 },
			},
		};

		await expect(
			middleware().wrapGenerate({
				doGenerate: vi.fn().mockResolvedValue(response),
			}),
		).resolves.toBe(response);

		const [span] = exporter.getFinishedSpans();
		expect(span.name).toBe("llm.chat");
		expect(span.status.code).toBe(SpanStatusCode.OK);
		expect(span.attributes).toMatchObject({
			"gen_ai.system": "OPENAI_DIRECT",
			"gen_ai.request.model": "gpt-5-mini",
			"gen_ai.usage.input_tokens": 23,
			"gen_ai.usage.output_tokens": 11,
		});
	});

	it("records a provider failure without changing its identity or exposing its message", async () => {
		const error = new Error("Bearer private-provider-key");

		await expect(
			middleware().wrapGenerate({
				doGenerate: vi.fn().mockRejectedValue(error),
			}),
		).rejects.toBe(error);

		const [span] = exporter.getFinishedSpans();
		expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
		expect(exportedData(span)).not.toContain("private-provider-key");
	});

	it("keeps a streaming span open until the finish chunk supplies usage", async () => {
		const source = new ReadableStream({
			start(controller) {
				controller.enqueue({ type: "text-delta", delta: "hello" });
				controller.enqueue({
					type: "finish",
					usage: { inputTokens: 8, outputTokens: 3 },
				});
				controller.close();
			},
		});
		const result = await middleware().wrapStream({
			doStream: vi.fn().mockResolvedValue({ stream: source }),
		});
		expect(exporter.getFinishedSpans()).toHaveLength(0);

		const chunks = [];
		for await (const chunk of result.stream) {
			chunks.push(chunk);
		}

		expect(chunks).toHaveLength(2);
		const [span] = exporter.getFinishedSpans();
		expect(span.status.code).toBe(SpanStatusCode.OK);
		expect(span.attributes).toMatchObject({
			"gen_ai.usage.input_tokens": 8,
			"gen_ai.usage.output_tokens": 3,
		});
	});

	it("ends a streaming span when its consumer cancels", async () => {
		const source = new ReadableStream({
			pull(controller) {
				controller.enqueue({
					type: "text-delta",
					delta: "still-going",
				});
			},
		});
		const result = await middleware().wrapStream({
			doStream: vi.fn().mockResolvedValue({ stream: source }),
		});
		const reader = result.stream.getReader();
		await reader.read();
		await reader.cancel("contains private cancellation details");

		const [span] = exporter.getFinishedSpans();
		expect(span.status).toEqual({ code: SpanStatusCode.UNSET });
		expect(span.attributes["llm.outcome"]).toBe("cancelled");
		expect(exportedData(span)).not.toContain(
			"private cancellation details",
		);
	});

	it("records a streaming error chunk without exposing its payload", async () => {
		const error = new Error("private streamed provider response");
		const source = new ReadableStream({
			start(controller) {
				controller.enqueue({ type: "error", error });
				controller.close();
			},
		});
		const result = await middleware().wrapStream({
			doStream: vi.fn().mockResolvedValue({ stream: source }),
		});
		for await (const _chunk of result.stream) {
			// Drain the provider stream to its terminal error part.
		}

		const [span] = exporter.getFinishedSpans();
		expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
		expect(span.attributes["llm.outcome"]).toBe("error");
		expect(exportedData(span)).not.toContain(
			"private streamed provider response",
		);
	});

	it("returns the provider result if telemetry cannot acquire its stream", async () => {
		const source = new ReadableStream({
			start(controller) {
				controller.close();
			},
		});
		const lock = source.getReader();

		const result = await middleware().wrapStream({
			doStream: vi.fn().mockResolvedValue({ stream: source }),
		});

		expect(result.stream).toBe(source);
		lock.releaseLock();
	});
});
