/**
 * Synthetic probe shared utilities.
 *
 * Each probe runs the cheapest possible operation against a provider
 * SDK / API:
 *   - increments `synthetic_probe_result_total{provider, outcome}` once.
 *   - observes `synthetic_probe_duration_seconds{provider}` once.
 *   - returns a normalized `{ success, latencyMs, error? }` to the workflow.
 *
 * Probes NEVER throw — the workflow treats success/failure as data, not
 * an exception. Errors are stringified to the `error` field so the
 * workflow can pass them through to upsertIntegrationIncident for the
 * audit log.
 */
import {
	type SyntheticProbeOutcomeLabel,
	syntheticProbeDuration,
	syntheticProbeResult,
	trackEvent,
} from "@repo/observability";

export interface SyntheticProbeOutput {
	success: boolean;
	latencyMs: number;
	error?: string;
	/**
	 * True when the probe was skipped because a required environment
	 * variable was not set in this environment (e.g., `STRIPE_SECRET_KEY`
	 * unset on staging). The workflow MUST NOT count this as a probe
	 * failure: it does not increment the failure counter and does not
	 * open an incident. Instead, the registry row is marked
	 * `NOT_CONFIGURED` so the admin UI can render a neutral "Not
	 * configured" badge and the active-incidents banner ignores it.
	 *
	 * Distinct from `success === false` — a real probe failure (timeout,
	 * non-2xx response, SDK error) still flows through the standard
	 * SEV-1 escalation path.
	 */
	notConfigured?: boolean;
}

/**
 * Run a probe body under the standard metric instrumentation. Caller
 * owns the actual SDK call inside `body`. We wrap it in a timeout-aware
 * try/catch and emit the metric pair exactly once.
 */
export async function runProbe(
	providerKey: string,
	body: () => Promise<void>,
	options: { timeoutMs?: number } = {},
): Promise<SyntheticProbeOutput> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const start = Date.now();

	let outcome: SyntheticProbeOutcomeLabel = "success";
	let errorMessage: string | undefined;
	let timedOut = false;

	const controller = new AbortController();
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		await Promise.race([
			body(),
			new Promise<never>((_, reject) => {
				controller.signal.addEventListener("abort", () => {
					reject(new Error("probe-timeout"));
				});
			}),
		]);
	} catch (err) {
		outcome = timedOut ? "timeout" : "failure";
		errorMessage = err instanceof Error ? err.message : String(err);
	} finally {
		clearTimeout(timer);
	}

	const latencyMs = Date.now() - start;
	syntheticProbeDuration.observe({ provider: providerKey }, latencyMs / 1000);
	syntheticProbeResult.inc({ provider: providerKey, outcome });

	// App Insights — feeds the `SyntheticProbeFailing` KQL alert rule in
	// `deployment/azure/modules/monitoring.bicep` (runs every 5m over the
	// last 15m window, fires when count >= 3 per provider).
	trackEvent("SyntheticProbeResult", {
		provider: providerKey,
		outcome,
		durationMs: latencyMs,
	});

	return {
		success: outcome === "success",
		latencyMs,
		error: errorMessage,
	};
}

/**
 * Resolve an environment variable that the synthetic probe needs. We
 * deliberately do NOT throw — a missing key returns `null` so the
 * activity records a failure with a clear error message rather than
 * blowing up the worker.
 */
export function probeSecret(name: string): string | null {
	const value = process.env[name];
	if (!value) {
		return null;
	}
	return value;
}
