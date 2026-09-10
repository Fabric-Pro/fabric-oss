import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	constructorArgs: [] as unknown[][],
	events: [] as Array<Record<string, unknown>>,
	metrics: [] as Array<Record<string, unknown>>,
	logs: [] as Array<Record<string, unknown>>,
	recordings: [] as Array<{
		name: string;
		value: number;
		attributes?: Record<string, unknown>;
	}>,
	flushError: undefined as unknown,
	shutdownError: undefined as unknown,
	flushCalls: 0,
	shutdownCalls: 0,
	loggerRequests: 0,
}));

vi.mock("@opentelemetry/api-logs", () => ({
	logs: {
		getLogger: () => {
			captured.loggerRequests++;
			return {
				emit: (record: Record<string, unknown>) =>
					captured.logs.push(record),
			};
		},
	},
	SeverityNumber: { INFO: 9 },
}));

vi.mock("@opentelemetry/api", () => ({
	metrics: {
		getMeter: () => ({
			createHistogram: (name: string) => ({
				record: (value: number, attributes?: Record<string, unknown>) =>
					captured.recordings.push({ name, value, attributes }),
			}),
		}),
	},
}));

const envKeys = [
	"APPLICATIONINSIGHTS_CONNECTION_STRING",
	"FABRIC_FEATURE_BURN_RATE_ALERTS",
	"OTEL_ENABLED",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_SERVICE_NAME",
] as const;
const originalEnv: Partial<Record<(typeof envKeys)[number], string>> = {};
const validConnectionString =
	"InstrumentationKey=00000000-0000-0000-0000-000000000001";

async function installDirectClientFactory() {
	const telemetry = await import("../lib/app-insights");
	telemetry.__setAppInsightsClientFactoryForTests(
		(connectionString, options) => {
			captured.constructorArgs.push([connectionString, options]);
			return {
				initialize() {},
				trackEvent(event) {
					captured.events.push(event);
				},
				trackMetric(metric) {
					captured.metrics.push(metric);
				},
				async flush() {
					captured.flushCalls++;
					if (captured.flushError) {
						throw captured.flushError;
					}
				},
				async shutdown() {
					captured.shutdownCalls++;
					if (captured.shutdownError) {
						throw captured.shutdownError;
					}
				},
			};
		},
	);
	return telemetry;
}

beforeEach(() => {
	for (const key of envKeys) {
		originalEnv[key] = process.env[key];
		delete process.env[key];
	}
	captured.constructorArgs = [];
	captured.events = [];
	captured.metrics = [];
	captured.logs = [];
	captured.recordings = [];
	captured.flushError = undefined;
	captured.shutdownError = undefined;
	captured.flushCalls = 0;
	captured.shutdownCalls = 0;
	captured.loggerRequests = 0;
});

afterEach(async () => {
	const telemetry = await import("../lib/app-insights");
	telemetry.__resetAppInsightsForTests();
	vi.restoreAllMocks();
	for (const key of envKeys) {
		if (originalEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = originalEnv[key];
		}
	}
});

describe("OpenTelemetry fallback", () => {
	it("emits custom events through the configured OTel logger when only the collector is configured", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4317";
		process.env.OTEL_SERVICE_NAME = "api";
		const { initAppInsights, trackEvent } = await import(
			"../lib/app-insights"
		);

		initAppInsights();
		expect(captured.loggerRequests).toBe(0);
		trackEvent("SyntheticProbeResult", {
			provider: "openai",
			durationMs: 42.5,
			success: true,
		});

		expect(captured.constructorArgs).toHaveLength(0);
		expect(captured.loggerRequests).toBe(1);
		expect(captured.logs).toHaveLength(1);
		expect(captured.logs[0]).toMatchObject({
			body: "Custom event: SyntheticProbeResult",
			severityNumber: 9,
			severityText: "INFO",
			attributes: {
				"event.name": "SyntheticProbeResult",
				"service.name": "api",
				provider: "openai",
				durationMs: 42.5,
				success: true,
			},
		});
		expect(
			(captured.logs[0]?.attributes as Record<string, unknown>)[
				"event.id"
			],
		).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("records custom metrics through the configured OTel meter", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4317";
		const { initAppInsights, trackMetric } = await import(
			"../lib/app-insights"
		);

		initAppInsights();
		trackMetric("HttpRequest", 1, { feature: "ai_generation" });

		expect(captured.recordings).toEqual([
			{
				name: "HttpRequest",
				value: 1,
				attributes: { feature: "ai_generation" },
			},
		]);
		expect(captured.logs).toHaveLength(0);
	});

	it("keeps the burn-rate kill switch authoritative", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4317";
		process.env.FABRIC_FEATURE_BURN_RATE_ALERTS = "false";
		const { initAppInsights, trackEvent, trackMetric } =
			await installDirectClientFactory();

		initAppInsights();
		trackEvent("SyntheticProbeResult");
		trackMetric("HttpRequest", 1);

		expect(captured.logs).toHaveLength(0);
		expect(captured.recordings).toHaveLength(0);
	});
});

describe("direct Application Insights transport", () => {
	it.each(["garbage", "InstrumentationKey=not-a-uuid"])(
		"keeps the OTel fallback active for malformed connection string %s",
		async (connectionString) => {
			process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
				connectionString;
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
				"http://otel-collector:4317";
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { getAppInsightsClient, initAppInsights, trackEvent } =
				await import("../lib/app-insights");

			initAppInsights();
			trackEvent("SyntheticProbeResult", { success: false });

			expect(getAppInsightsClient()).toBeNull();
			expect(captured.logs).toHaveLength(1);
			expect(warn).toHaveBeenCalledWith(
				"[app-insights] invalid connection string; direct exporter disabled",
			);
		},
	);

	it("prefers the bundle-local SDK edge without resolving the workspace fallback", async () => {
		const { __loadApplicationInsightsForTests } = await import(
			"../lib/app-insights"
		);
		const localSdk = { TelemetryClient: class {} };
		const loadFromBundle = vi.fn(() => localSdk);
		const loadFromObservability = vi.fn(() => {
			throw new Error("workspace fallback should stay lazy");
		});

		const loaded = __loadApplicationInsightsForTests(
			loadFromBundle,
			loadFromObservability,
		);

		expect(loaded).toBe(localSdk);
		expect(loadFromBundle).toHaveBeenCalledWith("applicationinsights");
		expect(loadFromObservability).not.toHaveBeenCalled();
	});

	it("falls back to the observability package only for MODULE_NOT_FOUND", async () => {
		const { __loadApplicationInsightsForTests } = await import(
			"../lib/app-insights"
		);
		const moduleNotFound = Object.assign(
			new Error("SDK is not app-local"),
			{
				code: "MODULE_NOT_FOUND",
			},
		);
		const fallbackSdk = { TelemetryClient: class {} };
		const loadFromBundle = vi.fn(() => {
			throw moduleNotFound;
		});
		const loadFromObservability = vi.fn(() => fallbackSdk);

		const loaded = __loadApplicationInsightsForTests(
			loadFromBundle,
			loadFromObservability,
		);

		expect(loaded).toBe(fallbackSdk);
		expect(loadFromObservability).toHaveBeenCalledWith(
			"applicationinsights",
		);
	});

	it("does not mask non-resolution failures from the app-local loader", async () => {
		const { __loadApplicationInsightsForTests } = await import(
			"../lib/app-insights"
		);
		const loadFailure = Object.assign(new Error("SDK evaluation failed"), {
			code: "ERR_MODULE_INIT_FAILED",
		});
		const loadFromObservability = vi.fn();

		expect(() =>
			__loadApplicationInsightsForTests(() => {
				throw loadFailure;
			}, loadFromObservability),
		).toThrow(loadFailure);
		expect(loadFromObservability).not.toHaveBeenCalled();
	});

	it("loads the compatibility SDK from ESM without initializing it", async () => {
		const { __loadApplicationInsightsForTests } = await import(
			"../lib/app-insights"
		);

		const appInsights = __loadApplicationInsightsForTests() as {
			TelemetryClient?: unknown;
		};

		expect(appInsights.TelemetryClient).toBeTypeOf("function");
		expect(captured.constructorArgs).toHaveLength(0);
	});

	it("uses an isolated manual client and does not duplicate into OTel", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4317";
		const { initAppInsights, trackEvent, trackMetric } =
			await installDirectClientFactory();

		initAppInsights();
		trackEvent("CircuitBreakerStateChange", { state: "open" });
		trackMetric("AppError", 1, { feature: "auth" });

		expect(captured.constructorArgs).toEqual([
			[validConnectionString, { useGlobalProviders: false }],
		]);
		expect(captured.events).toHaveLength(1);
		expect(captured.events[0]).toMatchObject({
			name: "CircuitBreakerStateChange",
			properties: { state: "open" },
		});
		expect(
			(captured.events[0]?.properties as Record<string, unknown>)[
				"event.id"
			],
		).toMatch(/^[0-9a-f-]{36}$/);
		expect(captured.metrics).toEqual([
			{ name: "AppError", value: 1, properties: { feature: "auth" } },
		]);
		expect(captured.logs).toHaveLength(0);
		expect(captured.recordings).toHaveLength(0);
	});

	it("flushes and shuts down without allowing exporter failures to escape", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { initAppInsights, shutdownAppInsights } =
			await installDirectClientFactory();
		initAppInsights();
		captured.flushError = new Error("flush failed");
		captured.shutdownError = new Error("shutdown failed");

		await expect(shutdownAppInsights()).resolves.toBeUndefined();

		expect(captured.flushCalls).toBe(1);
		expect(captured.shutdownCalls).toBe(1);
		expect(warn).toHaveBeenCalledWith(
			"[app-insights] flush failed",
			"flush failed",
		);
		expect(warn).toHaveBeenCalledWith(
			"[app-insights] shutdown failed",
			"shutdown failed",
		);
	});
});
