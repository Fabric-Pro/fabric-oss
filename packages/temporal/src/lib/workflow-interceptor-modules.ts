import { resolve } from "node:path";

/**
 * Workflow-side interceptor modules, in the one form the SDK actually
 * honours: `bundleWorkflowCode({ workflowInterceptorModules })`.
 *
 * `WorkerOptions.interceptors.workflowModules` reads like the place for
 * these, but the SDK discards that key whenever a worker is created from
 * a prebuilt `workflowBundle` — it logs a warning and carries on, so a
 * module registered there never runs. This worker bundles once at boot
 * and hands the same bundle to every task queue, which makes the bundler
 * the only registration point that works.
 *
 * Each entry must be a module whose `interceptors` export is a
 * `WorkflowInterceptorsFactory`, and which is safe to load inside the
 * workflow sandbox (no `node:` builtins).
 *
 * Paths are built with `resolve()` rather than `require.resolve()` and
 * are deliberately extensionless: webpack resolves the extension while
 * bundling, and Vitest — which does not patch Node's CJS resolver for
 * `.ts` — can still import this module to assert the wiring. The replay
 * test resolves `workflowsPath` the same way and for the same reason.
 */
export const WORKFLOW_INTERCEPTOR_MODULES: readonly string[] = [
	// Forwards the workflow's correlation header onto every activity,
	// child workflow and continue-as-new the workflow starts.
	resolve(__dirname, "..", "workflows", "correlation-workflow-interceptor"),
];
