import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	constructorArgs: [] as unknown[][],
	events: [] as Array<Record<string, unknown>>,
	metrics: [] as Array<Record<string, unknown>>,
	logs: [] as Array<Record<string, unknown>>,
	traces: [] as Array<Record<string, unknown>>,
	exceptions: [] as Array<Record<string, unknown>>,
	clients: [] as Array<{
		config: {
			azureMonitorOpenTelemetryOptions?: {
				resource?: { attributes: Record<string, unknown> };
			};
		};
	}>,
	// Snapshots, in call order, of whether `config.azureMonitorOpenTelemetryOptions`
	// was already populated at the moment each client's `initialize()` ran —
	// proves the resource is set BEFORE `initialize()`, not after.
	initializeSnapshots: [] as Array<{ hadResource: boolean; role?: unknown }>,
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

async function installDirectClientFactory({
	samplingLimit,
}: {
	samplingLimit?: number;
} = {}) {
	const telemetry = await import("../lib/app-insights");
	if (samplingLimit !== undefined) {
		telemetry.__setAppInsightsSamplingLimitForTests(samplingLimit);
	}
	telemetry.__setAppInsightsClientFactoryForTests(
		(connectionString, options) => {
			captured.constructorArgs.push([connectionString, options]);
			const client = {
				// Mirrors the real shim's `config` shape (see the citation on
				// `TelemetryClient` in app-insights.ts): an empty object until
				// `ensureDirectClient` sets `azureMonitorOpenTelemetryOptions`
				// on it, which must happen before `initialize()` runs.
				config: {} as {
					azureMonitorOpenTelemetryOptions?: {
						resource?: { attributes: Record<string, unknown> };
					};
				},
				initialize() {
					const resource =
						client.config.azureMonitorOpenTelemetryOptions
							?.resource;
					captured.initializeSnapshots.push({
						hadResource: resource !== undefined,
						role: resource?.attributes["service.name"],
					});
				},
				trackEvent(event: Record<string, unknown>) {
					captured.events.push(event);
				},
				trackMetric(metric: Record<string, unknown>) {
					captured.metrics.push(metric);
				},
				trackTrace(trace: Record<string, unknown>) {
					captured.traces.push(trace);
				},
				trackException(exception: Record<string, unknown>) {
					captured.exceptions.push(exception);
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
			captured.clients.push(client);
			return client;
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
	captured.traces = [];
	captured.exceptions = [];
	captured.clients = [];
	captured.initializeSnapshots = [];
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

describe("log forwarding (independent of feature-burn-rate-alerts)", () => {
	it("is a no-op without a connection string", async () => {
		const { initAppInsightsLogs, trackLog } =
			await installDirectClientFactory();

		initAppInsightsLogs({ cloudRoleName: "fabric.web" });
		trackLog("warn", "no client configured");

		expect(captured.constructorArgs).toHaveLength(0);
		expect(captured.traces).toHaveLength(0);
	});

	it("sets the OTel resource (AppRoleName) on the shared client BEFORE initialize()", async () => {
		// `context.tags[cloudRole]` — the SDK's older, non-OTel-based pattern —
		// is proven ineffective for AppRoleName against the installed 3.15
		// shim, whether set before or after `initialize()` (see the citation
		// on `TelemetryClient`/`applyCloudRole` in app-insights.ts). Only
		// `config.azureMonitorOpenTelemetryOptions.resource`, set before
		// `initialize()` runs, actually takes effect.
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs, getAppInsightsClient } =
			await installDirectClientFactory();

		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		// `getAppInsightsClient()` just returns the shared client, which
		// `ensureDirectClient()` sets regardless of `TRANSPORT` — so it is
		// populated here even though `initAppInsights()`/`TRANSPORT` were
		// never touched.
		expect(getAppInsightsClient()).not.toBeNull();
		expect(captured.clients).toHaveLength(1);
		expect(
			captured.clients[0]?.config.azureMonitorOpenTelemetryOptions
				?.resource?.attributes["service.name"],
		).toBe("fabric.web");
		// The mock's own `initialize()` reads `config` at the moment it runs —
		// this proves the resource was already there, not set afterward.
		expect(captured.initializeSnapshots).toEqual([
			{ hadResource: true, role: "fabric.web" },
		]);
	});

	it("stays silent (no boot diagnostic) without a connection string configured", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const { initAppInsightsLogs } = await installDirectClientFactory();

		initAppInsightsLogs({ cloudRoleName: "fabric.web" });
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		expect(info).not.toHaveBeenCalled();
	});

	it("emits exactly one boot diagnostic across repeated calls once log forwarding actually initializes", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs } = await installDirectClientFactory();

		initAppInsightsLogs({ cloudRoleName: "fabric.web" });
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		expect(info).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledWith(
			"[app-insights] log forwarding enabled",
			{ cloudRoleName: "fabric.web" },
		);
	});

	it("forwards warn/error/fatal through trackTrace with the mapped severity", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs, trackLog } =
			await installDirectClientFactory();
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		trackLog("warn", "warn message", { event: "test.warn" });
		trackLog("error", "error message", { event: "test.error" });
		trackLog("fatal", "fatal message", { event: "test.fatal" });

		expect(captured.traces).toEqual([
			{
				message: "warn message",
				severity: "Warning",
				properties: { event: "test.warn" },
			},
			{
				message: "error message",
				severity: "Error",
				properties: { event: "test.error" },
			},
			{
				message: "fatal message",
				severity: "Critical",
				properties: { event: "test.fatal" },
			},
		]);
	});

	it("forwards through trackException, exception included, severity defaulted to Error", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs, trackLogException } =
			await installDirectClientFactory();
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		const error = new Error("boom");
		trackLogException(error, { event: "test.exception" });

		expect(captured.exceptions).toEqual([
			{
				exception: error,
				severity: "Error",
				properties: { event: "test.exception" },
			},
		]);
	});

	it("uses the passed severity for trackException (Critical for fatal)", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs, trackLogException } =
			await installDirectClientFactory();
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		const error = new Error("fatal boom");
		trackLogException(error, { event: "test.fatal" }, "fatal");

		expect(captured.exceptions).toEqual([
			{
				exception: error,
				severity: "Critical",
				properties: { event: "test.fatal" },
			},
		]);
	});

	it("forwards logs even when feature-burn-rate-alerts is explicitly off", async () => {
		// The flag gates trackEvent/trackMetric only — log forwarding must not
		// notice it at all, whether or not initAppInsights() ever runs.
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		process.env.FABRIC_FEATURE_BURN_RATE_ALERTS = "false";
		const { initAppInsights, initAppInsightsLogs, trackLog, trackEvent } =
			await installDirectClientFactory();

		initAppInsights();
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });
		trackEvent("SyntheticProbeResult");
		trackLog("warn", "still forwarded");

		expect(captured.events).toHaveLength(0);
		expect(captured.traces).toHaveLength(1);
	});

	it("does not create a client at all when the connection string is invalid", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "garbage";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { initAppInsightsLogs, trackLog } =
			await installDirectClientFactory();

		initAppInsightsLogs({ cloudRoleName: "fabric.web" });
		trackLog("warn", "unreachable");

		expect(captured.constructorArgs).toHaveLength(0);
		expect(captured.traces).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(
			"[app-insights] invalid connection string; direct exporter disabled",
		);
	});

	it("never throws into the caller when the client itself throws", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const telemetry = await import("../lib/app-insights");
		telemetry.__setAppInsightsClientFactoryForTests(() => ({
			config: {},
			initialize() {},
			trackEvent() {},
			trackMetric() {},
			trackTrace() {
				throw new Error("SDK is down");
			},
			trackException() {
				throw new Error("SDK is down");
			},
			async flush() {},
			async shutdown() {},
		}));

		telemetry.initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		expect(() =>
			telemetry.trackLog("error", "will throw internally"),
		).not.toThrow();
		expect(() =>
			telemetry.trackLogException(new Error("boom")),
		).not.toThrow();
		expect(warn).toHaveBeenCalledWith(
			"[app-insights] trackLog failed",
			"SDK is down",
		);
		expect(warn).toHaveBeenCalledWith(
			"[app-insights] trackLogException failed",
			"SDK is down",
		);
	});
});

describe("process-wide shared state across a module re-evaluation", () => {
	// Bundlers (Next/Turbopack in particular) can compile app-insights.ts into
	// more than one module instance for one running process — confirmed as
	// the root cause of zero records reaching App Insights from apps/web in
	// staging: `instrumentation.ts`'s `register()` and a route handler ended
	// up with separate `CLIENT`/`TRANSPORT`/etc. Simulating that here with
	// `vi.resetModules()` (which clears the module cache but never touches
	// `globalThis`, where all state now lives) is the direct regression test.
	it("keeps the same client across a re-evaluation when the role does not change", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const first = await installDirectClientFactory();
		first.initAppInsightsLogs({ cloudRoleName: "fabric-api" });
		expect(captured.clients).toHaveLength(1);

		vi.resetModules();
		const second = await import("../lib/app-insights");
		second.initAppInsightsLogs({ cloudRoleName: "fabric-api" });
		second.trackLog("warn", "logged via the re-evaluated module instance");

		// No second client was constructed, and the trace landed on the one
		// client instance 1 created — proving instance 2 shares it rather
		// than starting from its own, empty module-scoped state.
		expect(captured.constructorArgs).toHaveLength(1);
		expect(captured.traces).toHaveLength(1);
		expect(second.getAppInsightsClient()).toBe(captured.clients[0]);
	});

	it("delivers a log through flushAppInsights() called from a re-evaluated module instance", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const first = await installDirectClientFactory();
		first.initAppInsightsLogs({ cloudRoleName: "fabric-api" });
		first.trackLog("warn", "queued before the re-evaluation");

		vi.resetModules();
		const second = await import("../lib/app-insights");
		await second.flushAppInsights();

		// Vercel's `after(() => flushAppInsights())` runs in the route
		// handler's module instance — this is what proves that call reaches
		// the SAME client `initAppInsightsLogs` (called from instrumentation's
		// instance) actually wrote to.
		expect(captured.flushCalls).toBe(1);
	});

	it("recreates the client — discarding the stale one — so a role supplied later still takes effect", async () => {
		// This is the exact staging sequence: `initObservability`/`initAppInsights()`
		// (the feature-burn-rate-alerts path) runs first and has no role of its
		// own, so it would otherwise leave the client stuck reporting
		// AppRoleName "fabric" — a role the WEB app never wanted. This is how
		// `initAppInsightsLogs`, called afterward with the real role (possibly
		// from a re-evaluated module instance), still gets that role applied:
		// `ensureDirectClient` notices the desired role no longer matches the
		// role the cached client was built with, shuts the stale client down,
		// and builds a new one with the correct resource.
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const first = await installDirectClientFactory();
		first.initAppInsights();
		expect(captured.clients).toHaveLength(1);
		expect(
			captured.clients[0]?.config.azureMonitorOpenTelemetryOptions
				?.resource?.attributes["service.name"],
		).toBe("fabric");

		vi.resetModules();
		const second = await import("../lib/app-insights");
		second.initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		expect(captured.constructorArgs).toHaveLength(2);
		expect(captured.shutdownCalls).toBe(1);
		expect(second.getAppInsightsClient()).toBe(captured.clients[1]);
		expect(
			captured.clients[1]?.config.azureMonitorOpenTelemetryOptions
				?.resource?.attributes["service.name"],
		).toBe("fabric.web");
	});
});

describe("per-key sampling", () => {
	it("forwards up to the per-key limit and suppresses the rest of the window", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs, trackLog } =
			await installDirectClientFactory({ samplingLimit: 2 });
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		trackLog("warn", "line 1", { event: "hot.path" });
		trackLog("warn", "line 2", { event: "hot.path" });
		trackLog("warn", "line 3", { event: "hot.path" });
		trackLog("warn", "line 4", { event: "hot.path" });

		expect(captured.traces).toHaveLength(2);
		expect(captured.traces.map((t) => t.message)).toEqual([
			"line 1",
			"line 2",
		]);
	});

	it("buckets by properties.event, ignoring the message text", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs, trackLog } =
			await installDirectClientFactory({ samplingLimit: 1 });
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		trackLog("warn", "first distinct message", { event: "shared.key" });
		trackLog("warn", "second distinct message", { event: "shared.key" });

		expect(captured.traces).toHaveLength(1);
	});

	it("buckets an unkeyed record by severity + normalized message prefix", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs, trackLog } =
			await installDirectClientFactory({ samplingLimit: 1 });
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		// Identical for the first 60 characters (the normalized-prefix
		// window); only the trailing connection id differs.
		const prefix =
			"database timeout while querying the primary db replica, conn=";
		trackLog("warn", `${prefix}aaaa1111`);
		trackLog("warn", `${prefix}bbbb2222`);
		// A different severity is a different bucket even with the same text.
		trackLog("error", `${prefix}aaaa1111`);

		expect(captured.traces).toHaveLength(2);
	});

	it("emits exactly one suppressed-summary trace when the window rolls over", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		vi.useFakeTimers();
		try {
			const { initAppInsightsLogs, trackLog } =
				await installDirectClientFactory({ samplingLimit: 1 });
			initAppInsightsLogs({ cloudRoleName: "fabric.web" });

			trackLog("warn", "kept", { event: "rolling.key" });
			trackLog("warn", "suppressed 1", { event: "rolling.key" });
			trackLog("warn", "suppressed 2", { event: "rolling.key" });

			expect(captured.traces).toHaveLength(1);

			vi.advanceTimersByTime(60_000);
			trackLog("warn", "first of new window", { event: "rolling.key" });

			expect(captured.traces).toHaveLength(3);
			expect(captured.traces[1]).toMatchObject({
				message: 'Suppressed 2 similar records for key "rolling.key"',
				severity: "Warning",
				properties: {
					event: "app-insights.log-sampling-suppressed",
				},
			});
			expect(captured.traces[2]).toMatchObject({
				message: "first of new window",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("tracks each key's budget independently", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs, trackLog } =
			await installDirectClientFactory({ samplingLimit: 1 });
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		trackLog("warn", "a", { event: "key.a" });
		trackLog("warn", "a again — suppressed", { event: "key.a" });
		trackLog("warn", "b", { event: "key.b" });

		expect(captured.traces.map((t) => t.message)).toEqual(["a", "b"]);
	});

	it("does not let one noisy procedure starve another's budget under the same event", async () => {
		// The regression this guards: keying purely on `properties.event`
		// put every "rpc.error" record — every procedure, every status —
		// in ONE 20/min bucket, so a hot 403 on one route silently dropped
		// 5xx alerting for every other route.
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs, trackLog } =
			await installDirectClientFactory({ samplingLimit: 20 });
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		for (let i = 0; i < 30; i++) {
			trackLog("warn", `noisy call ${i}`, {
				event: "rpc.error",
				procedure: "billing/status",
				code: "FORBIDDEN",
				status: 403,
			});
		}
		for (let i = 0; i < 30; i++) {
			trackLog("error", `db call ${i}`, {
				event: "rpc.error",
				procedure: "prompts/list",
				code: "INTERNAL_SERVER_ERROR",
				status: 500,
			});
		}

		const byProcedure = (procedure: string) =>
			captured.traces.filter(
				(t) =>
					(t.properties as Record<string, unknown>)?.procedure ===
					procedure,
			);
		expect(byProcedure("billing/status")).toHaveLength(20);
		expect(byProcedure("prompts/list")).toHaveLength(20);
	});

	it("still buckets by event alone when no discriminant fields are present", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const { initAppInsightsLogs, trackLog } =
			await installDirectClientFactory({ samplingLimit: 1 });
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		trackLog("warn", "first", { event: "shared.key" });
		trackLog("warn", "second — suppressed", { event: "shared.key" });

		expect(captured.traces).toHaveLength(1);
	});
});

describe("flushAppInsights and suppressed summaries", () => {
	it("emits a suppressed summary on flush for a key that went quiet, without waiting for a new record", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		vi.useFakeTimers();
		try {
			const { initAppInsightsLogs, trackLog, flushAppInsights } =
				await installDirectClientFactory({ samplingLimit: 1 });
			initAppInsightsLogs({ cloudRoleName: "fabric.web" });

			trackLog("warn", "kept", { event: "quiet.key" });
			trackLog("warn", "suppressed 1", { event: "quiet.key" });
			trackLog("warn", "suppressed 2", { event: "quiet.key" });
			expect(captured.traces).toHaveLength(1);

			vi.advanceTimersByTime(60_000);
			// No new `trackLog` call for this key — a flush alone (Vercel's
			// `after()`, this process's own periodic flush) is the only
			// other place the summary can come from.
			await flushAppInsights();

			expect(captured.traces).toHaveLength(2);
			expect(captured.traces[1]).toMatchObject({
				message: 'Suppressed 2 similar records for key "quiet.key"',
				severity: "Warning",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not repeat a summary on a second flush with nothing new suppressed", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		vi.useFakeTimers();
		try {
			const { initAppInsightsLogs, trackLog, flushAppInsights } =
				await installDirectClientFactory({ samplingLimit: 1 });
			initAppInsightsLogs({ cloudRoleName: "fabric.web" });

			trackLog("warn", "kept", { event: "quiet.key" });
			trackLog("warn", "suppressed", { event: "quiet.key" });
			vi.advanceTimersByTime(60_000);

			await flushAppInsights();
			expect(captured.traces).toHaveLength(2);

			await flushAppInsights();
			expect(captured.traces).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does nothing on flush for a key whose window has not yet elapsed", async () => {
		process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
			validConnectionString;
		const {
			initAppInsightsLogs,
			trackLog,
			flushAppInsights,
			__setAppInsightsSamplingLimitForTests,
		} = await installDirectClientFactory();
		__setAppInsightsSamplingLimitForTests(1);
		initAppInsightsLogs({ cloudRoleName: "fabric.web" });

		trackLog("warn", "kept", { event: "fresh.key" });
		trackLog("warn", "suppressed", { event: "fresh.key" });
		await flushAppInsights();

		expect(captured.traces).toHaveLength(1);
	});
});
