/**
 * A cancelled workflow or activity closes every open span the way the SDK's
 * OpenTelemetry interceptors close a failed one: ERROR status plus a recorded
 * exception. Spans here are ended the same way, through a real tracer, so the
 * `exception.type` the exporter matches is the one the SDK writes.
 */

import { SpanStatusCode } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	ActivityFailure,
	ApplicationFailure,
	CancelledFailure,
	RetryState,
	TerminatedFailure,
	TimeoutFailure,
	TimeoutType,
} from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { CancellationTolerantSpanExporter } from "../src/lib/cancellation-span-exporter";

function exportFailedSpans(...errors: Error[][]) {
	const sink = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [
			new SimpleSpanProcessor(new CancellationTolerantSpanExporter(sink)),
		],
	});
	const tracer = provider.getTracer("@temporalio/interceptor-workflow");
	for (const [index, spanErrors] of errors.entries()) {
		const span = tracer.startSpan(`span-${index}`);
		for (const error of spanErrors) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error.message,
			});
			span.recordException(error);
		}
		span.end();
	}
	return sink.getFinishedSpans();
}

function activityFailure(message: string) {
	return new ActivityFailure(
		message,
		"extractAndPersistMaterializedSymbolsActivity",
		"1",
		RetryState.NON_RETRYABLE_FAILURE,
		"worker-identity",
	);
}

function exceptionTypes(span: ReadableSpan) {
	return span.events
		.filter((event) => event.name === "exception")
		.map((event) => event.attributes?.["exception.type"]);
}

describe("CancellationTolerantSpanExporter", () => {
	it("exports a cancelled span with no error and no exception", () => {
		const [span] = exportFailedSpans([
			new CancelledFailure("Workflow cancelled"),
		]);

		expect(span).toBeDefined();
		if (!span) return;
		expect(span.status.code).toBe(SpanStatusCode.UNSET);
		expect(exceptionTypes(span)).toEqual([]);
		expect(span.name).toBe("span-0");
		expect(span.spanContext().spanId).toMatch(/^[0-9a-f]{16}$/);
	});

	it("exports an activity cancelled with its workflow with no error", () => {
		const [span] = exportFailedSpans([
			activityFailure("Activity cancelled"),
		]);

		expect(span).toBeDefined();
		if (!span) return;
		expect(span.status.code).toBe(SpanStatusCode.UNSET);
		expect(exceptionTypes(span)).toEqual([]);
	});

	it.each([
		["ActivityFailure", activityFailure("Activity task failed")],
		["ActivityFailure", activityFailure("Activity task timed out")],
		[
			"TimeoutFailure",
			new TimeoutFailure(
				"Activity task timed out",
				undefined,
				TimeoutType.START_TO_CLOSE,
			),
		],
		["TerminatedFailure", new TerminatedFailure("Terminated by operator")],
		[
			"ApplicationFailure",
			ApplicationFailure.create({ message: "Indexing failed" }),
		],
	])("keeps a %s span as an error with its exception", (type, error) => {
		const [span] = exportFailedSpans([error]);

		expect(span).toBeDefined();
		if (!span) return;
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(exceptionTypes(span)).toEqual([type]);
	});

	it("keeps the error when a real failure was recorded with the cancellation", () => {
		const [span] = exportFailedSpans([
			ApplicationFailure.create({ message: "Indexing failed" }),
			new CancelledFailure("Workflow cancelled"),
		]);

		expect(span).toBeDefined();
		if (!span) return;
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(exceptionTypes(span)).toEqual(["ApplicationFailure"]);
	});

	it("filters each span of a batch on its own", () => {
		const spans = exportFailedSpans(
			[new CancelledFailure("Workflow cancelled")],
			[new TerminatedFailure("Terminated by operator")],
			[],
		);

		expect(spans.map((span) => span.status.code)).toEqual([
			SpanStatusCode.UNSET,
			SpanStatusCode.ERROR,
			SpanStatusCode.UNSET,
		]);
	});
});
