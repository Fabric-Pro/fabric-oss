import {
	type Context,
	type ContextManager,
	context,
	metrics,
	ROOT_CONTEXT,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";
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

/** Synchronous-only context manager, enough for a span active inside a callback. */
class StackContextManager implements ContextManager {
	private stack: Context[] = [ROOT_CONTEXT];
	active(): Context {
		return this.stack[this.stack.length - 1];
	}
	with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
		ctx: Context,
		fn: F,
		thisArg?: ThisParameterType<F>,
		...args: A
	): ReturnType<F> {
		this.stack.push(ctx);
		try {
			return fn.call(thisArg, ...args);
		} finally {
			this.stack.pop();
		}
	}
	bind<T>(_ctx: Context, target: T): T {
		return target;
	}
	enable(): this {
		return this;
	}
	disable(): this {
		return this;
	}
}

describe("LLM invocation spans", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;
	let metricExporter: InMemoryMetricExporter;
	let meterProvider: MeterProvider;

	beforeEach(() => {
		trace.disable();
		metrics.disable();
		context.disable();
		context.setGlobalContextManager(new StackContextManager());
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
		context.disable();
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

	type DataPoint = { attributes: Record<string, unknown>; value: unknown };

	async function exportedMetrics(): Promise<Map<string, DataPoint[]>> {
		await meterProvider.forceFlush();
		const exports = metricExporter.getMetrics();
		const latest = exports[exports.length - 1];
		const byName = new Map<string, DataPoint[]>();
		for (const metric of latest?.scopeMetrics.flatMap(
			(scope) => scope.metrics,
		) ?? []) {
			byName.set(
				metric.descriptor.name,
				metric.dataPoints.map((point) => ({
					attributes: point.attributes as Record<string, unknown>,
					value: point.value,
				})),
			);
		}
		return byName;
	}

	describe("decide invocations", () => {
		const ORGANIZATION_ID = "org-opaque-7f3a";

		it("emits an llm.decide span with request and answering model and decide-operation metrics", async () => {
			const invocation = llmInstrumentation.startInvocation({
				provider: "VERCEL_GATEWAY",
				model: "openai/example-decider",
				operation: "decide",
				context: {
					organizationId: ORGANIZATION_ID,
					projectId: "proj-1",
					featureKey: "maturation",
					jobType: "meeting-transcript-sync",
					questionCount: 3,
				},
			});

			invocation.succeed(
				{ inputTokens: 40, outputTokens: 6 },
				{ responseModel: "typesafe-ai/jev", refusalCount: 1 },
			);

			const [span] = exporter.getFinishedSpans();
			expect(span.name).toBe("llm.decide");
			expect(span.status.code).toBe(SpanStatusCode.OK);
			expect(span.attributes).toEqual({
				"gen_ai.system": "VERCEL_GATEWAY",
				"gen_ai.request.model": "openai/example-decider",
				"gen_ai.response.model": "typesafe-ai/jev",
				"gen_ai.usage.input_tokens": 40,
				"gen_ai.usage.output_tokens": 6,
				"llm.outcome": "success",
				"fabric.organization.id": ORGANIZATION_ID,
				"fabric.project.id": "proj-1",
				"fabric.feature_key": "maturation",
				"fabric.job_type": "meeting-transcript-sync",
				"llm.decision.question_count": 3,
				"llm.decision.refusal_count": 1,
			});

			const metricData = await exportedMetrics();
			for (const name of ["llm.requests", "llm.request.duration"]) {
				const points = metricData.get(name) ?? [];
				expect(points).toHaveLength(1);
				expect(points[0].attributes.operation).toBe("decide");
			}
			// organizationId is a span attribute only, never a metric label.
			expect(JSON.stringify([...metricData])).not.toContain(
				ORGANIZATION_ID,
			);
		});

		it("omits context attributes that are absent", () => {
			const invocation = llmInstrumentation.startInvocation({
				provider: "VERCEL_GATEWAY",
				model: "openai/example-decider",
				operation: "decide",
				context: { organizationId: ORGANIZATION_ID, projectId: "  " },
			});
			invocation.succeed({ inputTokens: 1, outputTokens: 1 });

			const [span] = exporter.getFinishedSpans();
			expect(span.attributes["fabric.organization.id"]).toBe(
				ORGANIZATION_ID,
			);
			for (const key of [
				"fabric.project.id",
				"fabric.feature_key",
				"fabric.job_type",
				"llm.decision.question_count",
				"gen_ai.response.model",
				"llm.decision.refusal_count",
			]) {
				expect(span.attributes).not.toHaveProperty(key);
			}
		});

		it("records a failed decide call as an error without the message", async () => {
			const invocation = llmInstrumentation.startInvocation({
				provider: "VERCEL_GATEWAY",
				model: "openai/example-decider",
				operation: "decide",
			});
			invocation.fail(new TypeError("sentinel-secret-state"));

			const [span] = exporter.getFinishedSpans();
			expect(span.name).toBe("llm.decide");
			expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
			expect(span.attributes).toMatchObject({
				"error.type": "TypeError",
				"llm.outcome": "error",
			});
			const metricData = await exportedMetrics();
			expect(metricData.get("llm.errors")?.[0].attributes).toEqual({
				provider: "VERCEL_GATEWAY",
				model: "openai/example-decider",
				operation: "decide",
				error_type: "TypeError",
			});
			expect(
				JSON.stringify({
					span: span.attributes,
					metrics: [...metricData],
				}),
			).not.toContain("sentinel-secret-state");
		});

		it("leaves the chat invocation unchanged when no operation is given", async () => {
			const invocation = llmInstrumentation.startInvocation({
				provider: "OPENAI_DIRECT",
				model: "gpt-5-mini",
			});
			invocation.succeed({ inputTokens: 3, outputTokens: 2 });

			const [span] = exporter.getFinishedSpans();
			expect(span.name).toBe("llm.chat");
			expect(span.attributes).toEqual({
				"gen_ai.system": "OPENAI_DIRECT",
				"gen_ai.request.model": "gpt-5-mini",
				"gen_ai.usage.input_tokens": 3,
				"gen_ai.usage.output_tokens": 2,
				"llm.outcome": "success",
			});
			const metricData = await exportedMetrics();
			expect(metricData.get("llm.requests")?.[0].attributes).toEqual({
				provider: "OPENAI_DIRECT",
				model: "gpt-5-mini",
				operation: "chat",
				status: "success",
			});
			expect(
				metricData.get("llm.request.duration")?.[0].attributes,
			).toEqual({
				provider: "OPENAI_DIRECT",
				model: "gpt-5-mini",
				operation: "chat",
			});
		});
	});

	describe("recordDecisionOutcome", () => {
		it("counts the outcome and samples confidence with only site, outcome and model labels", async () => {
			llmInstrumentation.recordDecisionOutcome({
				site: "classify-work-item",
				outcome: "below_threshold",
				model: "typesafe-ai-jev",
				confidences: [0.72, 0.97],
				count: 2,
			});

			const metricData = await exportedMetrics();
			const outcomes = metricData.get("llm.decision.outcomes") ?? [];
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0].attributes).toEqual({
				site: "classify-work-item",
				outcome: "below_threshold",
				model: "typesafe-ai-jev",
			});
			expect(outcomes[0].value).toBe(2);

			const confidence = metricData.get("llm.decision.confidence") ?? [];
			expect(confidence).toHaveLength(1);
			expect(confidence[0].attributes).toEqual({
				site: "classify-work-item",
				model: "typesafe-ai-jev",
			});
			expect(confidence[0].value).toMatchObject({
				count: 2,
				min: 0.72,
				max: 0.97,
			});
		});

		it("drops confidence values outside 0..1 and records no sample when none are valid", async () => {
			llmInstrumentation.recordDecisionOutcome({
				site: "delivery-track",
				outcome: "malformed",
				model: "none",
				confidences: [1.5, -0.1, Number.NaN],
			});

			const metricData = await exportedMetrics();
			expect(metricData.get("llm.decision.outcomes")).toHaveLength(1);
			expect(metricData.has("llm.decision.confidence")).toBe(false);
		});

		it("sets the site, outcome and lowest confidence on the active span", () => {
			const tracer = trace.getTracer("test");
			tracer.startActiveSpan("parent", (parent) => {
				llmInstrumentation.recordDecisionOutcome({
					site: "backlog-routing",
					outcome: "accepted",
					model: "gpt-6-luna-decisions",
					confidences: [0.99, 0.93],
				});
				parent.end();
			});

			const parent = exporter
				.getFinishedSpans()
				.find((candidate) => candidate.name === "parent");
			expect(parent?.attributes).toEqual({
				"llm.decision.site": "backlog-routing",
				"llm.decision.outcome": "accepted",
				"llm.decision.confidence": 0.93,
			});
		});

		it("never throws, even for malformed input", () => {
			expect(() =>
				llmInstrumentation.recordDecisionOutcome({
					site: null as unknown as string,
					outcome: "accepted",
					model: "m",
				}),
			).not.toThrow();
		});
	});
});
