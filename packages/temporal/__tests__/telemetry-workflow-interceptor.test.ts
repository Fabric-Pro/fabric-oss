/**
 * Guards the workflow half of OpenTelemetry tracing.
 *
 * The worker registered the `exporter` sink that workflow spans are exported
 * through, but never the interceptor module that produces them, so no
 * workflow span was ever created (Fizzy #2401). The module has to reach
 * `bundleWorkflowCode` — the worker discards it anywhere else (Fizzy #2400)
 * — and it has to be contributed only when telemetry is on, so the bundle
 * stays free of it otherwise.
 *
 * `OTEL_ENABLED` and the endpoint are read when the module loads, so every
 * case stubs the env first and then imports a fresh copy. The enabled case
 * runs the real `initTelemetry()` against a port nothing listens on: the OTLP
 * exporters connect lazily, so nothing is sent, and what is under test is the
 * interceptor options and the bundle they produce.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bundleWorkflowCode } from "@temporalio/worker";
import { afterEach, describe, expect, it, vi } from "vitest";

// Resolved the way the other bundling tests resolve it: Vitest does not
// patch Node's CJS resolver for .ts, so `require.resolve` would fail here.
const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");

type TelemetryEnv = {
	OTEL_ENABLED?: string;
	OTEL_EXPORTER_OTLP_ENDPOINT?: string;
};

async function loadWithEnv(env: TelemetryEnv) {
	vi.resetModules();
	vi.stubEnv("OTEL_ENABLED", env.OTEL_ENABLED);
	vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", env.OTEL_EXPORTER_OTLP_ENDPOINT);
	const telemetry = await import("../src/telemetry");
	const bundleOptions = await import("../src/lib/workflow-bundle-options");
	const interceptorModules = await import(
		"../src/lib/workflow-interceptor-modules"
	);
	return { ...telemetry, ...bundleOptions, ...interceptorModules };
}

describe("OTEL_WORKFLOW_INTERCEPTOR_MODULE", () => {
	it("resolves to the SDK's workflow interceptor module on disk", async () => {
		const { OTEL_WORKFLOW_INTERCEPTOR_MODULE } = await loadWithEnv({});
		expect(OTEL_WORKFLOW_INTERCEPTOR_MODULE).toMatch(
			/interceptors-opentelemetry-v2[\\/]lib[\\/]workflow-interceptors\.js$/,
		);
		expect(existsSync(OTEL_WORKFLOW_INTERCEPTOR_MODULE)).toBe(true);
	});
});

describe("getTelemetryInterceptors with telemetry off", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([
		["OTEL_ENABLED=false", { OTEL_ENABLED: "false" }],
		["no collector endpoint", { OTEL_EXPORTER_OTLP_ENDPOINT: undefined }],
	])(
		"contributes no workflow module when %s",
		async (_label, env: TelemetryEnv) => {
			const {
				initTelemetry,
				getTelemetryInterceptors,
				buildWorkflowBundleOptions,
				OTEL_WORKFLOW_INTERCEPTOR_MODULE,
				WORKFLOW_INTERCEPTOR_MODULES,
			} = await loadWithEnv({
				OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
				...env,
			});
			initTelemetry();

			expect(getTelemetryInterceptors()).toEqual({});

			const modules =
				buildWorkflowBundleOptions(
					WORKFLOWS_PATH,
				).workflowInterceptorModules;
			expect(modules).not.toContain(OTEL_WORKFLOW_INTERCEPTOR_MODULE);
			// Switching telemetry off must not take the other interceptors
			// with it.
			expect(modules).toEqual([...WORKFLOW_INTERCEPTOR_MODULES]);
		},
	);
});

describe("getTelemetryInterceptors with telemetry on", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("contributes the workflow module, and the bundle carries it", async () => {
		const {
			initTelemetry,
			shutdownTelemetry,
			getTelemetryInterceptors,
			buildWorkflowBundleOptions,
			OTEL_WORKFLOW_INTERCEPTOR_MODULE,
			WORKFLOW_INTERCEPTOR_MODULES,
		} = await loadWithEnv({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
		});
		initTelemetry();
		try {
			const options = getTelemetryInterceptors();
			// The three parts of the chain, together: the module that makes
			// the spans, the sink they leave the isolate through, and the
			// activity-side interceptor that continues the trace.
			expect(options.interceptors?.workflowModules).toEqual([
				OTEL_WORKFLOW_INTERCEPTOR_MODULE,
			]);
			expect(options.sinks?.exporter).toBeDefined();
			expect(options.interceptors?.activityInbound).toHaveLength(1);

			// The exact object worker.ts hands the bundler, not a copy.
			const bundleOptions = buildWorkflowBundleOptions(WORKFLOWS_PATH);
			expect(bundleOptions.workflowInterceptorModules).toEqual([
				OTEL_WORKFLOW_INTERCEPTOR_MODULE,
				...WORKFLOW_INTERCEPTOR_MODULES,
			]);

			// Bundle for real: proves the module resolves from the workflows
			// directory, that it lands in the sandbox next to the correlation
			// interceptor rather than displacing it, and that the SDK's
			// workflow-imports replacement took effect — the module imports
			// from @temporalio/workflow through a stub that the bundler swaps
			// for the real re-exports; the stub's own throw message is what
			// would be in the bundle if that swap had not happened.
			const bundle = await bundleWorkflowCode(bundleOptions);
			expect(bundle.code).toContain("OpenTelemetryInboundInterceptor");
			expect(bundle.code).toContain("DeterministicIdGenerator");
			expect(bundle.code).not.toContain(
				"Workflow.getRandomStream(...) may only be used from a Workflow Execution.",
			);
			expect(bundle.code).toContain(
				"CorrelationWorkflowOutboundInterceptor",
			);
		} finally {
			await shutdownTelemetry();
		}
	}, 120_000);
});
