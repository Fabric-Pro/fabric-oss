/**
 * Guards the only workflow-interceptor registration point that works here.
 *
 * Every worker in this process is created from one prebuilt
 * `workflowBundle`, and in that configuration the SDK silently discards
 * `WorkerOptions.interceptors.workflowModules` — it logs a warning at boot
 * and carries on. Correlation propagation was registered there and so
 * never ran at all (Fizzy #2400). The modules have to reach
 * `bundleWorkflowCode` instead.
 *
 * The assertions run against `buildWorkflowBundleOptions()`, the same
 * object `worker.ts` hands the bundler, so the test cannot pass on a
 * copy that has drifted from production.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundleWorkflowCode } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import { buildWorkflowBundleOptions } from "../src/lib/workflow-bundle-options";
import { WORKFLOW_INTERCEPTOR_MODULES } from "../src/lib/workflow-interceptor-modules";

// Resolved the same way the replay test resolves its workflows path, and
// for the same reason: Vitest does not patch Node's CJS resolver for .ts,
// so `require.resolve` would fail here. Webpack resolves the extension.
const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");

describe("workflow bundle options", () => {
	it("carries every workflow interceptor module", () => {
		const options = buildWorkflowBundleOptions(WORKFLOWS_PATH);
		for (const module of WORKFLOW_INTERCEPTOR_MODULES) {
			expect(options.workflowInterceptorModules).toContain(module);
		}
	});

	it("includes the correlation interceptor among them", () => {
		expect([...WORKFLOW_INTERCEPTOR_MODULES]).toContain(
			resolve(WORKFLOWS_PATH, "correlation-workflow-interceptor"),
		);
	});

	it("produces a bundle that carries the interceptor", async () => {
		const bundle = await bundleWorkflowCode(
			buildWorkflowBundleOptions(WORKFLOWS_PATH),
		);

		// The generated entrypoint only exposes interceptor modules through
		// importInterceptors(); if the module had been dropped, the bundle
		// would still build and this is what would differ.
		expect(bundle.code).toContain("importInterceptors");
		expect(bundle.code).toContain("CorrelationWorkflowOutboundInterceptor");
		expect(bundle.code).toContain("x-correlation-id");
	}, 120_000);
});

describe("worker.ts interceptor wiring", () => {
	const WORKER_SOURCE = readFileSync(
		join(__dirname, "..", "src", "worker.ts"),
		"utf8",
	);

	it("builds its bundle from those options", () => {
		// The one hop the assertions above cannot reach: that worker.ts
		// actually calls the builder rather than constructing its own
		// options inline.
		expect(WORKER_SOURCE).toMatch(
			/bundleWorkflowCode\(\s*buildWorkflowBundleOptions\(/,
		);
	});

	it("does not register workflow modules on the worker itself", () => {
		// Any value assigned to `workflowModules` on worker options is thrown
		// away by the SDK, not just an array literal — so drop the one
		// legitimate mention (the destructure that strips the telemetry
		// layer's copy) and require that nothing else remains.
		const withoutTheDestructure = WORKER_SOURCE.replace(
			/workflowModules:\s*_bundledAtBuildTime/,
			"",
		);
		expect(withoutTheDestructure).not.toMatch(/workflowModules\s*:/);
	});
});
