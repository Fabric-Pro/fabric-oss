import { SpanStatusCode } from "@opentelemetry/api";
import type {
	ReadableSpan,
	SpanExporter,
	TimedEvent,
} from "@opentelemetry/sdk-trace-base";

/**
 * `exception.type` of a Temporal cancellation. The SDK's OpenTelemetry
 * interceptors accept only `ContinueAsNew` as a normal ending, so every span a
 * cancelled workflow or activity had open is closed as ERROR with this
 * exception recorded — one cancelled indexing run produced over 300 error rows.
 * A cancellation is requested by a caller and is not a failure. Timeouts,
 * terminations and application failures have their own types and stay errors.
 */
const CANCELLED_FAILURE_TYPE = "CancelledFailure";

/**
 * A workflow awaiting an activity that was cancelled with it sees an
 * `ActivityFailure` instead, carrying this fixed message from the SDK core.
 * Activity failures with any other message stay errors.
 */
const CANCELLED_ACTIVITY_MESSAGE = "Activity cancelled";

function isCancellationEvent(event: TimedEvent): boolean {
	if (event.name !== "exception") {
		return false;
	}
	const type = event.attributes?.["exception.type"];
	const message = event.attributes?.["exception.message"];
	return (
		type === CANCELLED_FAILURE_TYPE ||
		(type === "ActivityFailure" && message === CANCELLED_ACTIVITY_MESSAGE)
	);
}

/**
 * The span without its cancellation exception events. When that was the
 * span's only exception, an ERROR status becomes UNSET; a span that also
 * recorded another exception keeps its status.
 */
export function withoutCancellationError(span: ReadableSpan): ReadableSpan {
	if (!span.events.some(isCancellationEvent)) {
		return span;
	}
	const events = span.events.filter((event) => !isCancellationEvent(event));
	const otherException = events.some((event) => event.name === "exception");
	const status =
		span.status.code === SpanStatusCode.ERROR && !otherException
			? { code: SpanStatusCode.UNSET }
			: span.status;
	return {
		name: span.name,
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanContext: span.parentSpanContext,
		startTime: span.startTime,
		endTime: span.endTime,
		status,
		attributes: span.attributes,
		links: span.links,
		events,
		duration: span.duration,
		ended: span.ended,
		resource: span.resource,
		instrumentationScope: span.instrumentationScope,
		droppedAttributesCount: span.droppedAttributesCount,
		droppedEventsCount: span.droppedEventsCount,
		droppedLinksCount: span.droppedLinksCount,
	};
}

/**
 * Wraps the worker's trace exporters so Temporal cancellations are exported
 * as ordinary span endings, not errors. It runs in the worker process after
 * the spans have left the workflow sandbox, so workflow code and replay are
 * unaffected.
 */
export class CancellationTolerantSpanExporter implements SpanExporter {
	constructor(private readonly inner: SpanExporter) {}

	export(
		spans: ReadableSpan[],
		resultCallback: Parameters<SpanExporter["export"]>[1],
	): void {
		this.inner.export(spans.map(withoutCancellationError), resultCallback);
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown();
	}

	async forceFlush(): Promise<void> {
		await this.inner.forceFlush?.();
	}
}
