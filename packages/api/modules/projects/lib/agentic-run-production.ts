/**
 * What Fabric says when a run points at the customer's live system.
 *
 * The ruling (2026-07-27): a PRODUCTION target **warns, and the run proceeds**.
 * It previously refused unless the caller sent `confirmProduction`, a flag no
 * caller ever sent — so every production run was impossible, and the branch that
 * was supposed to handle one was unexercisable.
 *
 * Recorded plainly because the trade is real: nothing now stops an unattended
 * run against a live system. What stands in its place is this sentence, the
 * raised severity on the audit row, and `productionAcknowledged: false` in that
 * row's metadata — so an investigation can see the run went ahead on a warning
 * with no confirmation behind it.
 *
 * Its own module so the procedure and its test share one definition. A test that
 * restates the sentence proves only that someone can copy a string.
 */

/**
 * The warning to show and to audit, or null when the target is not production.
 *
 * Past tense on purpose: by the time anyone reads this the browser has already
 * been dispatched. "A run *will* act on your live system" implies a chance to
 * stop it, and there no longer is one.
 */
export function describeProductionRunWarning(environment: {
	name: string;
	type: string;
}): string | null {
	if (environment.type !== "PRODUCTION") {
		return null;
	}
	// Named, not just "a production environment": a team with EU and US live
	// targets has to know which one a run just touched.
	return `“${environment.name}” is a PRODUCTION environment. This run signed in and acted on your live system.`;
}
