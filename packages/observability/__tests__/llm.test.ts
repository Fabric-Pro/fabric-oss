import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { llmInstrumentation } from "../lib/instrumentations/llm";

describe("LLM invocation spans", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;
	let metricExporter: InMemoryMetricExporter;
	let meterProvider: MeterProvider;

	beforeEach(() => {
		trace.disable();
		metrics.disable();
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		trace.setGlobalTracerProvider(provider);
		metricExporter = new InMemoryMetricExporter(
			AggregationTemporality.CUMULATIVE,
		);
		meterProvider = new MeterProvider({
			readers: [
				new PeriodicExportingMetricReader({
					exporter: metricExporter,
					exportIntervalMillis: 60_000,
				}),
			],
		});
		metrics.setGlobalMeterProvider(meterProvider);
	});

	afterEach(async () => {
		await provider.shutdown();
		await meterProvider.shutdown();
		trace.disable();
		metrics.disable();
	});

	it("emits bounded success attributes and token usage", () => {
		const invocation = llmInstrumentation.startInvocation({
			provider: "OPENAI_DIRECT",
			model: `model-${"x".repeat(300)}`,
		});

		invocation.succeed({ inputTokens: 12, outputTokens: 7 });

		const [span] = exporter.getFinishedSpans();
		expect(span.name).toBe("llm.chat");
		expect(span.status.code).toBe(SpanStatusCode.OK);
		expect(span.attributes).toMatchObject({
			"gen_ai.system": "OPENAI_DIRECT",
			"gen_ai.usage.input_tokens": 12,
			"gen_ai.usage.output_tokens": 7,
			"llm.outcome": "success",
		});
		expect(
			String(span.attributes["gen_ai.request.model"]).length,
		).toBeLessThanOrEqual(128);
		expect(span.events).toEqual([]);
	});

	it("marks failures without recording raw error contents", () => {
		const invocation = llmInstrumentation.startInvocation({
			provider: "ANTHROPIC_DIRECT",
			model: "claude-sonnet",
		});

		const error = new Error(
			"credential sk-secret must never enter telemetry",
		);
		error.name = "Credential-sk-secret";
		invocation.fail(error);

		const [span] = exporter.getFinishedSpans();
		expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
		expect(span.attributes).toMatchObject({
			"gen_ai.usage.input_tokens": 0,
			"gen_ai.usage.output_tokens": 0,
			"error.type": "Error",
			"llm.outcome": "error",
		});
		expect(
			JSON.stringify({
				attributes: span.attributes,
				status: span.status,
				events: span.events,
			}),
		).not.toContain("sk-secret");
		expect(span.events).toEqual([]);
	});

	it("marks cancellation without recording an LLM error metric", async () => {
		const invocation = llmInstrumentation.startInvocation({
			provider: "GROQ",
			model: "llama",
		});

		invocation.cancel();
		invocation.succeed({ inputTokens: 100, outputTokens: 200 });

		const [span] = exporter.getFinishedSpans();
		expect(exporter.getFinishedSpans()).toHaveLength(1);
		expect(span.status).toEqual({ code: SpanStatusCode.UNSET });
		expect(span.attributes).toMatchObject({
			"gen_ai.usage.input_tokens": 0,
			"gen_ai.usage.output_tokens": 0,
			"llm.outcome": "cancelled",
		});
		await meterProvider.forceFlush();
		const metricNames = metricExporter
			.getMetrics()
			.flatMap((resource) => resource.scopeMetrics)
			.flatMap((scope) => scope.metrics)
			.map((metric) => metric.descriptor.name);
		expect(metricNames).not.toContain("llm.errors");
	});

	it("binds request metrics after the application registers its meter provider", async () => {
		const invocation = llmInstrumentation.startInvocation({
			provider: "OPENAI_DIRECT",
			model: "gpt-5-mini",
		});
		invocation.succeed({ inputTokens: 4, outputTokens: 2 });

		await meterProvider.forceFlush();
		const metricNames = metricExporter
			.getMetrics()
			.flatMap((resource) => resource.scopeMetrics)
			.flatMap((scope) => scope.metrics)
			.map((metric) => metric.descriptor.name);
		expect(metricNames).toEqual(
			expect.arrayContaining([
				"llm.requests",
				"llm.tokens",
				"llm.request.duration",
			]),
		);
	});

	it("degrades to a no-op when malformed telemetry attributes cannot be normalized", () => {
		expect(() => {
			const invocation = llmInstrumentation.startInvocation({
				provider: null as unknown as string,
				model: "gpt-5-mini",
			});
			invocation.succeed();
		}).not.toThrow();
	});
});
