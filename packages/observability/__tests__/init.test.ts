/**
 * Tests for the resource-detector configuration in `initObservability`.
 *
 * The SDK's default detector set includes `hostDetector`, whose `host.id`
 * lookup reads `/etc/machine-id` and `/var/lib/dbus/machine-id`. Slim container
 * images ship neither, and because resource detection runs *after*
 * `registerInstrumentations()`, `@opentelemetry/instrumentation-fs` turns each
 * miss into a recorded span exception — which App Insights then stores as a
 * real exception. These tests pin the detector list so that regression can't
 * come back silently.
 *
 * The OTel SDK modules are stubbed out so nothing real starts; the
 * `@opentelemetry/resources` module is left real so detector identities can be
 * compared by reference.
 */

import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	sdkConfig: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@opentelemetry/sdk-node", () => ({
	NodeSDK: class {
		constructor(config: Record<string, unknown>) {
			captured.sdkConfig = config;
		}
		start() {}
		async shutdown() {}
	},
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
	LoggerProvider: class {
		// `initObservability` registers this as the global logger provider and
		// immediately calls `logs.getLogger()` to wire console interception.
		getLogger() {
			return { emit() {} };
		}
		async shutdown() {}
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
	const { initObservability } = await import("../lib/init");
	initObservability({ serviceName: "test-agent" });
	return { resources, sdkConfig: captured.sdkConfig };
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

	for (const signal of signals) {
		preexistingSignalListeners.set(signal, [...process.listeners(signal)]);
	}
});

afterEach(() => {
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
