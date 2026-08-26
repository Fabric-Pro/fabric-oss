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
 */
import { db } from "@repo/database";

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
	const existing = await db.integrationProviderRegistry.findUnique({
		where: { providerKey: input.providerKey },
		select: { currentHealth: true },
	});

	if (!existing) {
		// Registry row may not yet exist (Hono boot writes them all
		// idempotently). Best-effort no-op rather than throwing.
		return { updated: false };
	}

	const alreadyNotConfigured = existing.currentHealth === "NOT_CONFIGURED";

	await db.integrationProviderRegistry
		.update({
			where: { providerKey: input.providerKey },
			data: {
				currentHealth: "NOT_CONFIGURED",
				lastPolledAt: new Date(),
			},
		})
		.catch(() => {
			/* registry row may not exist yet — best-effort */
		});

	return { updated: !alreadyNotConfigured };
}
