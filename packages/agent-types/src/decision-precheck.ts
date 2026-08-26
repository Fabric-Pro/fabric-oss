/**
 * Decision pre-check result types.
 *
 * Framework-agnostic shapes for the async contradiction pre-check that runs
 * after an AI surface produces output and flags it against the project's
 * accepted/rejected architecture decisions. Kept here (not in a Temporal or
 * API package) so the producing activity, the persisting/serving procedures,
 * and the rendering web components all share one definition without importing
 * runtime internals.
 */

/**
 * One flagged contradiction between produced output and a specific logged
 * decision. Every field is resolved/normalized in code against the candidate
 * decision set — never a raw model echo.
 */
export interface DecisionConflictFinding {
	/** Candidate decision id. Validated against the candidate set; hallucinated ids are dropped. */
	decisionId: string;
	/** Human identifier (e.g. "ADR-012"), resolved from the candidate, not the model. */
	decisionIdentifier: string;
	/** Decision title, resolved from the candidate. */
	decisionTitle: string;
	/** One-line, model-authored explanation of how the output conflicts. */
	natureOfConflict: string;
	/** Normalized in code (never a model enum): violates an ACCEPTED decision or reintroduces a REJECTED one. */
	conflictType: "violates_accepted" | "reintroduces_rejected";
	/** Confidence in [0, 1], coerced/clamped in code. */
	confidence: number;
	/** Backlog only: which change this finding applies to (bounds-checked against the items array). */
	changeRef?: {
		index: number;
		title?: string;
	};
}

/**
 * The persisted outcome of one pre-check run over a generated artifact.
 * Absence of this object means the pre-check never ran; `status: "ok"` means
 * it ran and found no conflicts.
 */
export interface DecisionPrecheckResult {
	/** ISO timestamp of when the check ran. */
	checkedAt: string;
	/** "ok" = ran, no conflicts; "conflicts" = at least one finding. */
	status: "ok" | "conflicts";
	/** Flagged contradictions; empty when `status` is "ok". */
	findings: DecisionConflictFinding[];
	/**
	 * Document surface only: the content hash the findings were judged against,
	 * so a later edit/regeneration with a different hash marks them stale and
	 * the UI ignores them until the check reruns.
	 */
	checkedContentHash?: string;
}

/**
 * Bounds applied while narrowing untrusted persisted / client-relayed pre-check
 * data. `natureOfConflict` is a one-line explanation; cap it so a forged or
 * runaway string can't bloat the immutable WORM override ledger, and cap the
 * finding count so a forged payload can't fan out into unbounded audit rows.
 */
const NATURE_OF_CONFLICT_MAX_CHARS = 500;
const MAX_DECISION_FINDINGS = 50;

/** Clamp a possibly-forged confidence into the documented [0, 1] range. */
function clampConfidence(value: unknown): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return 0;
	}
	return Math.min(1, Math.max(0, value));
}

/**
 * Narrow an untyped persisted JSON value — a backlog proposal's
 * `sourceMetadata.decisionPrecheck` or a document's `decisionPrecheck` column —
 * into a `DecisionPrecheckResult`. The value is written by our own pre-check
 * module, but Prisma types it as `unknown`, so every field is guarded and each
 * finding is coerced; findings without a real `decisionId` are dropped rather
 * than trusted blindly. Confidence is clamped, `natureOfConflict` truncated, and
 * the finding count capped so forged/oversized data can't reach the WORM ledger.
 * Returns null when the value is absent or is not shaped like a pre-check result,
 * so every consumer degrades to "nothing shown" instead of throwing on malformed
 * persisted data.
 *
 * The single canonical narrower shared by the API override-logging path and the
 * web warning surfaces, so both agree on exactly which findings are valid.
 */
export function extractDecisionPrecheck(
	value: unknown,
): DecisionPrecheckResult | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const bag = value as Record<string, unknown>;
	if (bag.status !== "ok" && bag.status !== "conflicts") {
		return null;
	}

	const rawFindings = Array.isArray(bag.findings) ? bag.findings : [];
	const findings: DecisionConflictFinding[] = [];
	for (const raw of rawFindings) {
		if (findings.length >= MAX_DECISION_FINDINGS) {
			break;
		}
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const entry = raw as Record<string, unknown>;
		if (typeof entry.decisionId !== "string" || entry.decisionId === "") {
			continue;
		}
		findings.push({
			decisionId: entry.decisionId,
			decisionIdentifier:
				typeof entry.decisionIdentifier === "string"
					? entry.decisionIdentifier
					: entry.decisionId,
			decisionTitle:
				typeof entry.decisionTitle === "string"
					? entry.decisionTitle
					: "",
			natureOfConflict:
				typeof entry.natureOfConflict === "string"
					? entry.natureOfConflict.slice(
							0,
							NATURE_OF_CONFLICT_MAX_CHARS,
						)
					: "",
			conflictType:
				entry.conflictType === "reintroduces_rejected"
					? "reintroduces_rejected"
					: "violates_accepted",
			confidence: clampConfidence(entry.confidence),
			...(entry.changeRef &&
			typeof entry.changeRef === "object" &&
			!Array.isArray(entry.changeRef)
				? {
						changeRef: entry.changeRef as {
							index: number;
							title?: string;
						},
					}
				: {}),
		});
	}

	return {
		checkedAt:
			typeof bag.checkedAt === "string"
				? bag.checkedAt
				: new Date().toISOString(),
		status: bag.status,
		findings,
		...(typeof bag.checkedContentHash === "string"
			? { checkedContentHash: bag.checkedContentHash }
			: {}),
	};
}

/** Distinct decisions a set of findings references, for "N logged decision(s)". */
export function countDistinctDecisions(
	findings: DecisionConflictFinding[],
): number {
	return new Set(findings.map((finding) => finding.decisionId)).size;
}
