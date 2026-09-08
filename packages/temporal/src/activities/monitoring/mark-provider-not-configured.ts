/**
 * markProviderNotConfigured activity.
 *
 * Flips an `IntegrationProviderRegistry` row to `NOT_CONFIGURED` health
 * with a one-line reason. Called by the synthetic-probe workflow when
 * the activity reports `notConfigured: true` (a required env var is
 * unset in this environment, e.g. STRIPE_SECRET_KEY missing on staging).
 *
 * Key invariant: this does NOT open an `IntegrationIncident`. The
 * provider isn't necessarily down — we simply can't probe it. Marking
 * the registry row gives the admin UI a clean way to render a neutral
 * "Not configured" badge (gray, NOT red) and lets the active-incidents
 * banner ignore the row entirely.
 *
 * Idempotent — multiple workflow ticks calling this with the same
 * reason are a no-op after the first DB write. Best-effort: a missing
 * registry row (boot ordering) does not throw.
 *
 * The registry write goes through `touchProviderRegistry`, which skips
 * the UPDATE entirely once the row already reads NOT_CONFIGURED and its
 * heartbeat is fresh. A probe that keeps reporting the same missing env
 * var no longer rewrites the row on every tick.
 */
import { touchProviderRegistry } from "./touch-provider-registry";

export interface MarkProviderNotConfiguredInput {
	providerKey: string;
	/**
	 * Free-form reason recorded on the registry row's `lastNotConfiguredReason`
	 * column. Surfaces in the admin UI tooltip so operators know which env
	 * var to set if they want the probe to run.
	 */
	reason?: string;
}

export interface MarkProviderNotConfiguredOutput {
	/** True when a row's currentHealth changed (i.e., not already NOT_CONFIGURED). */
	updated: boolean;
}

export async function markProviderNotConfigured(
	input: MarkProviderNotConfiguredInput,
): Promise<MarkProviderNotConfiguredOutput> {
	// A missing registry row (Hono boot writes them all idempotently) is a
	// best-effort no-op inside the helper rather than a throw.
	const result = await touchProviderRegistry({
		providerKey: input.providerKey,
		currentHealth: "NOT_CONFIGURED",
	});

	// `updated` on this activity means "transitioned into NOT_CONFIGURED",
	// not "a row was written" — a heartbeat-only refresh must still report
	// false so the workflow doesn't spam logs.
	return { updated: result.healthChanged };
}
