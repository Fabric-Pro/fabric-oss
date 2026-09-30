import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exported = vi.hoisted(() => [] as ReadableLogRecord[]);

// Keep the real LoggerProvider and batch processor, replacing only the network
// exporter so assertions cover the records that would be sent to OTLP.
vi.mock("@opentelemetry/exporter-logs-otlp-grpc", () => ({
	OTLPLogExporter: class {
		export(
			records: ReadableLogRecord[],
			callback: (result: { code: number }) => void,
		) {
			exported.push(...records);
			callback({ code: 0 });
		}
		async shutdown() {}
	},
}));
vi.mock("@opentelemetry/sdk-node", () => ({
	NodeSDK: class {
		start() {}
		async shutdown() {}
	},
}));
vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
	getNodeAutoInstrumentations: () => [],
}));
vi.mock("@opentelemetry/sdk-metrics", () => ({
	AggregationType: { DROP: "drop" },
	PeriodicExportingMetricReader: class {},
}));
vi.mock("@opentelemetry/exporter-trace-otlp-grpc", () => ({
	OTLPTraceExporter: class {},
}));
vi.mock("@opentelemetry/exporter-metrics-otlp-grpc", () => ({
	OTLPMetricExporter: class {},
}));

const originalConsole = { ...console };
let shutdown: () => Promise<void>;

beforeEach(async () => {
	vi.resetModules();
	vi.stubEnv("OTEL_ENABLED", "true");
	for (const method of ["log", "info", "warn", "error", "debug"] as const) {
		vi.spyOn(console, method).mockImplementation(() => {});
	}
	const { logs } = await import("@opentelemetry/api-logs");
	logs.disable();
	const observability = await import("../lib/init");
	shutdown = observability.shutdownObservability;
	observability.initObservability({
		serviceName: "test-console",
		registerShutdownHooks: false,
	});
	exported.length = 0;
});

afterEach(async () => {
	await shutdown();
	const { logs } = await import("@opentelemetry/api-logs");
	logs.disable();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	Object.assign(console, originalConsole);
});

describe("console interception OTLP export", () => {
	it("preserves native timeout Error details in mixed console arguments", async () => {
		const error = new Error("Request timeout after 30000ms");
		console.error("[MCP Call] Error:", error);
		await shutdown();

		expect(exported).toHaveLength(1);
		expect(exported[0]).toMatchObject({
			severityText: "ERROR",
			body: '[MCP Call] Error: {"name":"Error","message":"Request timeout after 30000ms"}',
		});
	});

	it("redacts Error names and messages and excludes stack and extra fields", async () => {
		const error = Object.assign(
			new TypeError(
				"Request rejected: Bearer synthetic-token-123 password=synthetic-password",
			),
			{ credential: "synthetic-extra-secret" },
		);
		error.name = "TypeError token=synthetic-name-secret";
		error.stack = "synthetic-private-stack";
		console.error(error);
		await shutdown();

		expect(exported.map((record) => record.body)).toEqual([
			'{"name":"TypeError token=[REDACTED]","message":"Request rejected: Bearer [REDACTED] password=[REDACTED]"}',
		]);
	});

	it("keeps non-Error argument serialization unchanged", async () => {
		console.info("status", { ok: true }, null, undefined, 42, false);
		await shutdown();

		expect(exported.map((record) => record.body)).toEqual([
			'status {"ok":true} null undefined 42 false',
		]);
	});

	it("isolates failed serialization and still exports the next console call", async () => {
		const payload: Record<string, unknown> = {};
		payload.self = payload;
		expect(() => console.error(payload)).not.toThrow();
		console.warn("next log");
		await shutdown();

		expect(exported.map((record) => record.body)).toEqual(["next log"]);
	});
});
