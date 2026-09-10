import {
	type Context,
	type ContextManager,
	context,
	propagation,
	ROOT_CONTEXT,
	type TextMapPropagator,
	trace,
} from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { runWithCorrelationId } from "@repo/utils/correlation-id";
import { defaultPayloadConverter } from "@temporalio/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkflowClientInterceptors } from "../client-interceptors";
import { TEMPORAL_CORRELATION_HEADER } from "../correlation-interceptor";

class SynchronousContextManager implements ContextManager {
	private current = ROOT_CONTEXT;

	active(): Context {
		return this.current;
	}

	with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
		ctx: Context,
		fn: F,
		thisArg?: ThisParameterType<F>,
		...args: A
	): ReturnType<F> {
		const previous = this.current;
		this.current = ctx;
		try {
			return fn.call(thisArg, ...args);
		} finally {
			this.current = previous;
		}
	}

	bind<T>(_ctx: Context, target: T): T {
		return target;
	}

	enable(): this {
		return this;
	}

	disable(): this {
		this.current = ROOT_CONTEXT;
		return this;
	}
}

const traceContextPropagator: TextMapPropagator = {
	fields: () => ["traceparent"],
	inject(ctx, carrier, setter) {
		const spanContext = trace.getSpanContext(ctx);
		if (!spanContext) {
			return;
		}
		setter.set(
			carrier,
			"traceparent",
			`00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags
				.toString(16)
				.padStart(2, "0")}`,
		);
	},
	extract(ctx) {
		return ctx;
	},
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
	exporter = new InMemorySpanExporter();
	provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	context.setGlobalContextManager(new SynchronousContextManager());
	trace.setGlobalTracerProvider(provider);
	// The Temporal interceptor serializes whichever global propagator is active
	// into `_tracer-data`; install a deterministic W3C-shaped propagator here.
	propagation.setGlobalPropagator(traceContextPropagator);
});

afterEach(async () => {
	await provider.shutdown();
	context.disable();
	trace.disable();
	propagation.disable();
});

describe("buildWorkflowClientInterceptors", () => {
	it("keeps correlation propagation when telemetry is disabled", () => {
		const interceptors = buildWorkflowClientInterceptors({
			OTEL_ENABLED: "false",
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4317",
		});

		expect(interceptors).toHaveLength(1);
		expect(interceptors[0]?.constructor).toBe(Object);
	});

	it("adds trace context while preserving correlation and the active parent trace", async () => {
		const tracer = provider.getTracer("temporal-client-test");
		const interceptors = buildWorkflowClientInterceptors(
			{
				OTEL_ENABLED: "true",
				OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4317",
			},
			tracer,
		);
		expect(interceptors).toHaveLength(2);
		const [telemetryInterceptor, correlationInterceptor] = interceptors;
		if (!telemetryInterceptor?.start || !correlationInterceptor?.start) {
			throw new Error("Expected start interceptors");
		}

		const parent = tracer.startSpan("http-parent");
		const parentContext = parent.spanContext();
		let outgoingHeaders: Record<string, unknown> | undefined;
		const terminal = async (input: {
			headers: Record<string, unknown>;
		}) => {
			outgoingHeaders = input.headers;
			return "run-123";
		};
		const invokeCorrelation = (input: never) =>
			correlationInterceptor.start?.(input, terminal as never);

		await context.with(trace.setSpan(ROOT_CONTEXT, parent), () =>
			runWithCorrelationId("req_temporal_123", () =>
				telemetryInterceptor.start?.(
					{
						workflowType: "testWorkflow",
						options: { workflowId: "workflow-123" },
						headers: {},
					} as never,
					invokeCorrelation as never,
				),
			),
		);
		parent.end();

		const tracerCarrier = defaultPayloadConverter.fromPayload(
			outgoingHeaders?.["_tracer-data"] as never,
		) as Record<string, string>;
		const traceparent = tracerCarrier.traceparent.split("-");
		expect(traceparent[1]).toBe(parentContext.traceId);
		expect(traceparent[2]).not.toBe(parentContext.spanId);
		expect(
			defaultPayloadConverter.fromPayload(
				outgoingHeaders?.[TEMPORAL_CORRELATION_HEADER] as never,
			),
		).toBe("req_temporal_123");

		const startSpan = exporter
			.getFinishedSpans()
			.find((span) => span.name === "StartWorkflow:testWorkflow");
		expect(startSpan?.parentSpanContext?.spanId).toBe(parentContext.spanId);
		expect(startSpan?.attributes.temporalWorkflowId).toBe("workflow-123");
	});
});
