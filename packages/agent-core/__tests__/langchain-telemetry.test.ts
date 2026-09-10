import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProviderModel } from "../src/services/langchain-models";
import { createLangChainTelemetryCallback } from "../src/services/langchain-telemetry";

describe("LangChain LLM telemetry callback", () => {
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

	function exportedData(
		span: ReturnType<InMemorySpanExporter["getFinishedSpans"]>[number],
	) {
		return JSON.stringify({
			attributes: span.attributes,
			status: span.status,
			events: span.events,
		});
	}

	it("records the callback lifecycle and normalized token usage", async () => {
		const callback = createLangChainTelemetryCallback({
			provider: "DATABRICKS",
			model: "workspace-serving-endpoint",
		});
		await callback.handleChatModelStart?.({}, [], "run-success");
		await callback.handleLLMEnd?.(
			{
				generations: [
					[
						{
							text: "private model output",
							message: {
								usage_metadata: {
									input_tokens: 31,
									output_tokens: 9,
								},
							},
						},
					],
				],
			} as any,
			"run-success",
		);

		const [span] = exporter.getFinishedSpans();
		expect(span.status.code).toBe(SpanStatusCode.OK);
		expect(span.attributes).toMatchObject({
			"gen_ai.system": "DATABRICKS",
			"gen_ai.request.model": "workspace-serving-endpoint",
			"gen_ai.usage.input_tokens": 31,
			"gen_ai.usage.output_tokens": 9,
		});
		expect(exportedData(span)).not.toContain("private model output");
		expect(exportedData(span)).not.toContain("run-success");
	});

	it("records errors without raw error content and cleans up the run", async () => {
		const callback = createLangChainTelemetryCallback({
			provider: "ANTHROPIC_DIRECT",
			model: "claude-sonnet",
		});
		await callback.handleLLMStart?.({}, [], "run-error");
		await callback.handleLLMError?.(
			new Error("secret request contents"),
			"run-error",
		);
		await callback.handleLLMEnd?.({ generations: [] }, "run-error");

		const [span] = exporter.getFinishedSpans();
		expect(exporter.getFinishedSpans()).toHaveLength(1);
		expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
		expect(exportedData(span)).not.toContain("secret request contents");
	});

	it("classifies an aborted streaming run as cancelled", async () => {
		const callback = createLangChainTelemetryCallback({
			provider: "OPENAI_DIRECT",
			model: "gpt-5-mini",
		});
		const abort = new Error("private partial response");
		abort.name = "ModelAbortError";
		await callback.handleChatModelStart?.({}, [], "run-abort");
		await callback.handleLLMError?.(abort, "run-abort");

		const [span] = exporter.getFinishedSpans();
		expect(span.status).toEqual({ code: SpanStatusCode.UNSET });
		expect(span.attributes["llm.outcome"]).toBe("cancelled");
		expect(exportedData(span)).not.toContain("private partial response");
	});

	it("is attached to models created at the shared provider choke point", () => {
		const model = createProviderModel({
			provider: "OPENAI_DIRECT",
			model: "gpt-4o-mini",
			apiKey: "test-key",
		});

		expect(Array.isArray(model.callbacks)).toBe(true);
		expect(
			(model.callbacks as any[]).some(
				(handler) => handler.name === "fabric_llm_telemetry",
			),
		).toBe(true);
	});
});
