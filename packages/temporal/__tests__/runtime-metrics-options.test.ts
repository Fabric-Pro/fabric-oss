/**
 * `buildRuntimeMetricsOptions` decides whether the Temporal runtime is
 * installed with a core-metrics exporter. It is pure over the env so these
 * tests never instantiate the native runtime.
 */
import { describe, expect, it } from "vitest";
import { buildRuntimeMetricsOptions } from "../src/telemetry";

describe("buildRuntimeMetricsOptions", () => {
	it("exports core metrics over OTLP/gRPC to the configured collector", () => {
		const options = buildRuntimeMetricsOptions({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4317",
		});
		expect(options).toEqual({
			telemetryOptions: {
				metrics: {
					otel: {
						url: "http://otel-collector:4317",
						metricsExportInterval: "60s",
					},
				},
			},
		});
	});

	it("returns null when no collector endpoint is configured", () => {
		expect(buildRuntimeMetricsOptions({})).toBeNull();
		expect(
			buildRuntimeMetricsOptions({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }),
		).toBeNull();
	});

	it("returns null when telemetry is switched off, even with an endpoint", () => {
		expect(
			buildRuntimeMetricsOptions({
				OTEL_ENABLED: "false",
				OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4317",
			}),
		).toBeNull();
	});

	it("treats any OTEL_ENABLED value other than 'false' as enabled", () => {
		expect(
			buildRuntimeMetricsOptions({
				OTEL_ENABLED: "true",
				OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4317",
			}),
		).not.toBeNull();
	});
});
