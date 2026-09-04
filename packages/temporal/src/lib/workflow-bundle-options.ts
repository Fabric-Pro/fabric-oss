import type { BundleOptions } from "@temporalio/worker";
import { getTelemetryInterceptors } from "../telemetry";
import { WORKFLOW_INTERCEPTOR_MODULES } from "./workflow-interceptor-modules";

/**
 * The exact options the worker bundles workflows with.
 *
 * Extracted from worker.ts, which self-executes on import and so cannot
 * be loaded by a test. Keeping the construction here means the bundling
 * test asserts against the object production actually passes to
 * `bundleWorkflowCode`, rather than a copy that can drift from it.
 *
 * `workflowsPath` is a parameter because the two callers resolve it
 * differently: the worker uses `require.resolve` under tsx, the test
 * uses `resolve()` because Vitest does not patch Node's CJS resolver
 * for `.ts`.
 *
 * The webpack hook fixes publicPath — Temporal's VM sandbox does not
 * support webpack's auto publicPath detection — and disables
 * minification, which is critical: workflows are looked up by their
 * exported function name at runtime, and under NODE_ENV=production
 * webpack would rename "directChatWorkflow" to "i".
 */
export function buildWorkflowBundleOptions(
	workflowsPath: string,
): BundleOptions {
	return {
		workflowsPath,
		// The only workflow-interceptor registration point the SDK honours
		// once a worker is created from a prebuilt bundle: it ignores
		// `WorkerOptions.interceptors.workflowModules` there. Whatever the
		// telemetry layer contributes is merged in for the same reason.
		workflowInterceptorModules: [
			...(getTelemetryInterceptors().interceptors?.workflowModules ?? []),
			...WORKFLOW_INTERCEPTOR_MODULES,
		],
		webpackConfigHook: (config) => {
			// Set publicPath to empty string to avoid "Automatic publicPath is not supported" error
			config.output = {
				...config.output,
				publicPath: "",
			};
			// Disable minification to preserve workflow function names
			// This is critical - Temporal looks up workflows by their exported function name
			// If minified, "directChatWorkflow" becomes "i" which breaks workflow lookup
			config.optimization = {
				...config.optimization,
				minimize: false,
			};
			return config;
		},
	};
}
