/**
 * Pure helpers + types for a test case's run-result history (the editor drawer's
 * Runs section). No React here so the provenance resolver can be unit-tested
 * without a render tree or an i18n provider. Mirrors the `resultHistory`
 * procedure output shape (`TestResultEventListItem`).
 */

import type { TestResult } from "./constants";

/**
 * Where a run result came from — a manual mark, a PM-tool run ingest, or an
 * automated CI/pipeline run ingest.
 */
export type RunResultSource = "MANUAL" | "PM_SYNC" | "PIPELINE";

/** One run-history row as returned by `testCases.resultHistory` (newest-first). */
export type RunHistoryItem = {
	id: string;
	result: TestResult;
	source: RunResultSource;
	/** Serialized over oRPC as an ISO string; may arrive as a Date in tests. */
	occurredAt: string | Date;
	changedByUser: {
		id: string;
		name: string | null;
		email: string | null;
		image: string | null;
	} | null;
	actorLabel: string | null;
	testPlan: { id: string; identifier: string; name: string } | null;
	externalRunRef: string | null;
	externalRunUrl: string | null;
	note: string | null;
};

/** The resolved "who/what to credit" for a run event. */
export type RunActor = {
	source: RunResultSource;
	/** Display label, already trimmed; null when nothing is attributable. */
	label: string | null;
};

/**
 * Resolve who/what produced a run event, with safe fallbacks so a row never
 * renders a blank actor:
 *   - PM_SYNC / PIPELINE → the provider provenance `actorLabel` (e.g. "Azure
 *     DevOps · run 123" or "GitHub Actions · run 42"), else null.
 *   - MANUAL  → the acting Fabric user's display name, else their email, else
 *     null.
 * The caller substitutes an "unknown actor" copy when the label is null, so this
 * stays i18n-free and pure.
 */
export function resolveRunActor(item: {
	source: RunResultSource;
	actorLabel: string | null;
	changedByUser: { name: string | null; email: string | null } | null;
}): RunActor {
	if (item.source === "PM_SYNC" || item.source === "PIPELINE") {
		return { source: item.source, label: item.actorLabel?.trim() || null };
	}
	const user = item.changedByUser;
	return {
		source: "MANUAL",
		label: user?.name?.trim() || user?.email?.trim() || null,
	};
}
