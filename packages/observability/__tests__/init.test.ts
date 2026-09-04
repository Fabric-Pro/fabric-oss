/**
 * Tests for `initObservability`'s resource-detector configuration and for how
 * it reports a failed shutdown flush.
 *
 * The SDK's default detector set includes `hostDetector`, whose `host.id`
 * lookup reads `/etc/machine-id` and `/var/lib/dbus/machine-id`. Slim container
 * images ship neither, and because resource detection runs *after*
 * `registerInstrumentations()`, `@opentelemetry/instrumentation-fs` turns each
 * miss into a recorded span exception — which App Insights then stores as a
 * real exception. These tests pin the detector list so that regression can't
 * come back silently.
 *
 * The shutdown tests cover the other half: the local collector is torn down
 * alongside the application container, so the final flush routinely fails with
 * a gRPC UNAVAILABLE / ECONNREFUSED that nobody can act on. That belongs on
 * stdout at info level, while any other shutdown failure has to keep its
 * error-level line.
 *
 * The OTel SDK modules are stubbed out so nothing real starts; the
 * `@opentelemetry/resources` module is left real so detector identities can be
 * compared by reference.
 */

import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	sdkConfig: undefined as Record<string, unknown> | undefined,
	loggerShutdownError: undefined as unknown,
	sdkShutdownError: undefined as unknown,
	shutdownsCalled: [] as string[],
}));

vi.mock("@opentelemetry/sdk-node", () => ({
	NodeSDK: class {
		constructor(config: Record<string, unknown>) {
			captured.sdkConfig = config;
		}
		start() {}
		async shutdown() {
			captured.shutdownsCalled.push("sdk");
			if (captured.sdkShutdownError) {
				throw captured.sdkShutdownError;
			}
		}
	},
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
	LoggerProvider: class {
		// `initObservability` registers this as the global logger provider and
		// immediately calls `logs.getLogger()` to wire console interception.
		getLogger() {
			return { emit() {} };
		}
		async shutdown() {
			captured.shutdownsCalled.push("logger");
			if (captured.loggerShutdownError) {
				throw captured.loggerShutdownError;
			}
		}
	},
	BatchLogRecordProcessor: class {},
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
vi.mock("@opentelemetry/exporter-logs-otlp-grpc", () => ({
	OTLPLogExporter: class {},
}));

vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
	getNodeAutoInstrumentations: () => [],
}));

/**
 * `initObservability` is a module-level singleton and patches `console`, so
 * each test needs a fresh module graph plus a console restore.
 */
async function initWithFreshModules() {
	vi.resetModules();
	const resources = await import("@opentelemetry/resources");
	const observability = await import("../lib/init");
	observability.initObservability({ serviceName: "test-agent" });
	return { resources, observability, sdkConfig: captured.sdkConfig };
}

/**
 * `init.ts` binds the console methods it reports through at import time, so the
 * spies have to be installed before the module graph is rebuilt — otherwise it
 * holds references to the real console and the assertions see nothing.
 */
async function initWithConsoleSpies() {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const { observability } = await initWithFreshModules();
	return { log, error, observability };
}

const originalConsole = { ...console };
const envKeys = ["OTEL_ENABLED", "OTEL_NODE_RESOURCE_DETECTORS"] as const;
const originalEnv: Record<string, string | undefined> = {};

// Each init registers its own SIGTERM/SIGINT shutdown handler. Left in place
// they accumulate across tests towards Node's listener warning, and a signal
// arriving mid-run would fire every stale shutdown closure — so drop the ones
// this file adds while leaving vitest's own handlers alone.
const signals = ["SIGTERM", "SIGINT"] as const;
const preexistingSignalListeners = new Map<string, unknown[]>();

beforeEach(() => {
	for (const key of envKeys) {
		originalEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.OTEL_ENABLED = "true";
	captured.sdkConfig = undefined;
	captured.loggerShutdownError = undefined;
	captured.sdkShutdownError = undefined;
	captured.shutdownsCalled = [];

	for (const signal of signals) {
		preexistingSignalListeners.set(signal, [...process.listeners(signal)]);
	}
});

afterEach(() => {
	vi.restoreAllMocks();
	Object.assign(console, originalConsole);

	for (const signal of signals) {
		const preexisting = preexistingSignalListeners.get(signal) ?? [];
		for (const listener of process.listeners(signal)) {
			if (!preexisting.includes(listener)) {
				process.removeListener(
					signal,
					listener as NodeJS.SignalsListener,
				);
			}
		}
	}

	for (const key of envKeys) {
		if (originalEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = originalEnv[key];
		}
	}
});

describe("initObservability resource detectors", () => {
	it("drops hostDetector so container starts never probe machine-id", async () => {
		const { resources, sdkConfig } = await initWithFreshModules();

		expect(sdkConfig?.resourceDetectors).toEqual([
			resources.envDetector,
			resources.processDetector,
		]);
		expect(sdkConfig?.resourceDetectors).not.toContain(
			resources.hostDetector,
		);
	});

	it("defers to the SDK when OTEL_NODE_RESOURCE_DETECTORS is set", async () => {
		process.env.OTEL_NODE_RESOURCE_DETECTORS = "all";

		const { sdkConfig } = await initWithFreshModules();

		// `undefined` lets NodeSDK fall through to its own env-var handling
		// rather than pinning our reduced list over the operator's choice.
		expect(sdkConfig?.resourceDetectors).toBeUndefined();
	});

	it("sets host.name and host.arch explicitly in place of hostDetector", async () => {
		const { sdkConfig } = await initWithFreshModules();

		const attributes = (
			sdkConfig?.resource as { attributes: Record<string, unknown> }
		).attributes;

		// Record<string, string> rather than an inline literal: `os.arch()` is a
		// union covering every Node platform, so indexing a literal typed from
		// just these three keys is a type error on the rest.
		const archAliases: Record<string, string> = {
			arm: "arm32",
			ppc: "ppc32",
			x64: "amd64",
		};
		const expectedArch = archAliases[os.arch()] ?? os.arch();

		expect(attributes["host.arch"]).toBe(expectedArch);
		expect(attributes["host.name"]).toBeTruthy();
		expect(attributes["host.name"]).not.toBe("unknown");
	});
});

describe("shutdown flush reporting", () => {
	// Verbatim from a production container's stderr: the status arrives as the
	// message text of a plain Error, not as a structured `code`.
	const collectorGone = new Error(
		"14 UNAVAILABLE: No connection established. Last error: Error: connect ECONNREFUSED 127.0.0.1:4317",
	);

	it("reports an unreachable collector on stdout instead of as an error", async () => {
		captured.loggerShutdownError = collectorGone;
		captured.sdkShutdownError = collectorGone;

		const { log, error, observability } = await initWithConsoleSpies();
		await observability.shutdownObservability();

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Collector unreachable at shutdown"),
		);
		expect(error).not.toHaveBeenCalled();
	});

	it("recognises the failure by gRPC status code alone", async () => {
		captured.loggerShutdownError = Object.assign(
			new Error("flush failed"),
			{
				code: 14,
			},
		);

		const { log, error, observability } = await initWithConsoleSpies();
		await observability.shutdownObservability();

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Collector unreachable at shutdown"),
		);
		expect(error).not.toHaveBeenCalled();
	});

	it("recognises a socket failure wrapped in a cause chain", async () => {
		captured.sdkShutdownError = new Error("export failed", {
			cause: Object.assign(new Error("connect failed"), {
				code: "ECONNREFUSED",
			}),
		});

		const { log, error, observability } = await initWithConsoleSpies();
		await observability.shutdownObservability();

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Collector unreachable at shutdown"),
		);
		expect(error).not.toHaveBeenCalled();
	});

	it("keeps error level for a shutdown failure that is not the collector", async () => {
		const bug = new TypeError("processors is not iterable");
		captured.loggerShutdownError = bug;

		const { error, observability } = await initWithConsoleSpies();
		await observability.shutdownObservability();

		expect(error).toHaveBeenCalledWith(
			"[Observability] Shutdown error:",
			bug,
		);
	});

	it("keeps error level for a message that merely mentions the status word", async () => {
		// Matching "UNAVAILABLE" as a bare substring downgraded ordinary bugs
		// like this one, which need their stack.
		const bug = new TypeError(
			"Cannot read properties of undefined (reading 'UNAVAILABLE')",
		);
		captured.loggerShutdownError = bug;

		const { error, observability } = await initWithConsoleSpies();
		await observability.shutdownObservability();

		expect(error).toHaveBeenCalledWith(
			"[Observability] Shutdown error:",
			bug,
		);
	});

	it("keeps error level for an aggregate that mixes in a real failure", async () => {
		const mixed = new AggregateError([
			collectorGone,
			new TypeError("processor is not iterable"),
		]);
		captured.sdkShutdownError = mixed;

		const { error, observability } = await initWithConsoleSpies();
		await observability.shutdownObservability();

		expect(error).toHaveBeenCalledWith(
			"[Observability] Shutdown error:",
			mixed,
		);
	});

	it("downgrades an aggregate whose members are all the dead collector", async () => {
		captured.sdkShutdownError = new AggregateError([
			collectorGone,
			collectorGone,
		]);

		const { log, error, observability } = await initWithConsoleSpies();
		await observability.shutdownObservability();

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Collector unreachable at shutdown"),
		);
		expect(error).not.toHaveBeenCalled();
	});

	it("still flushes the SDK when the logger provider fails", async () => {
		captured.loggerShutdownError = collectorGone;

		const { observability } = await initWithConsoleSpies();
		await observability.shutdownObservability();

		// The two used to run in sequence, so the logger's rejection took the
		// trace and metric flush down with it.
		expect(captured.shutdownsCalled).toContain("logger");
		expect(captured.shutdownsCalled).toContain("sdk");
	});

	it("does not attempt a second shutdown after a failed flush", async () => {
		captured.loggerShutdownError = collectorGone;

		const { observability } = await initWithConsoleSpies();
		await observability.shutdownObservability();
		captured.shutdownsCalled = [];
		await observability.shutdownObservability();

		expect(captured.shutdownsCalled).toEqual([]);
	});
});
