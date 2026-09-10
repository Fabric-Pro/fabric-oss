import type { Tracer } from "@opentelemetry/api";
import type { WorkflowClientInterceptor } from "@temporalio/client";
import { OpenTelemetryWorkflowClientInterceptor } from "@temporalio/interceptors-opentelemetry-v2";
import { makeCorrelationClientInterceptor } from "./correlation-interceptor";

export interface WorkflowClientTelemetryEnv {
	OTEL_ENABLED?: string;
	OTEL_EXPORTER_OTLP_ENDPOINT?: string;
	[key: string]: string | undefined;
}

function isWorkflowClientTelemetryEnabled(
	env: WorkflowClientTelemetryEnv,
): boolean {
	return env.OTEL_ENABLED !== "false" && !!env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

/** Build the shared client chain in outermost-to-innermost call order. */
export function buildWorkflowClientInterceptors(
	env: WorkflowClientTelemetryEnv = process.env,
	tracer?: Tracer,
): WorkflowClientInterceptor[] {
	const correlation = makeCorrelationClientInterceptor();
	if (!isWorkflowClientTelemetryEnabled(env)) {
		return [correlation];
	}
	return [
		new OpenTelemetryWorkflowClientInterceptor(
			tracer === undefined ? undefined : { tracer },
		),
		correlation,
	];
}
