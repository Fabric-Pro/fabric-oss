/**
 * "Is this feature ready to sign off?" — answered before the evidence for it.
 *
 * The feature's Testing tab shows a warnings list, a traceability matrix, a
 * linked-case table, CI runs and an analysis, each of which is one input to that
 * question and none of which answers it. A reader had to assemble the verdict
 * themselves from five sections, and the most common way to get it wrong was to
 * read a green-looking matrix without noticing the analysis predated the current
 * spec.
 *
 * Pure, so the rules are testable without rendering the panel.
 */

export type TestingVerdictInput = {
	/** Acceptance criteria parsed from the specification. */
	criteriaCount: number;
	/** Criteria with no linked test case at all. */
	uncoveredCount: number;
	/** Criteria carrying an under-specification warning. */
	ambiguousCount: number;
	/** The analysis was generated before the current spec. */
	analysisStale: boolean;
	/** No analysis has ever been generated for this feature. */
	analysisMissing: boolean;
	/** Linked cases whose latest result is a failure. */
	failingCases: number;
	/**
	 * True when the linked-case list is paginated and not fully loaded — the
	 * counts above then describe what was loaded, not the whole set.
	 */
	casesTruncated: boolean;
};

type VerdictLevel = "blocked" | "caution" | "ready" | "unknown";

export type TestingVerdict = {
	level: VerdictLevel;
	/** i18n key suffix under `projects.stories.maturation.qa.verdict`. */
	headlineKey: string;
	/** The specific reasons, in the order a reader should act on them. */
	reasons: {
		key: "uncovered" | "ambiguous" | "failing" | "stale" | "missing";
		count: number;
	}[];
};

/**
 * Rank the reasons by how much they block a sign-off.
 *
 * A failing test outranks a missing one: a criterion nobody wrote a case for is
 * an unknown, while a criterion whose case fails is a known defect. Staleness
 * comes last but is never dropped — it is the reason a page that looks clean can
 * be describing a spec that no longer exists.
 */
export function computeTestingVerdict(
	input: TestingVerdictInput,
): TestingVerdict {
	const reasons: TestingVerdict["reasons"] = [];

	if (input.failingCases > 0) {
		reasons.push({ key: "failing", count: input.failingCases });
	}
	if (input.uncoveredCount > 0) {
		reasons.push({ key: "uncovered", count: input.uncoveredCount });
	}
	if (input.ambiguousCount > 0) {
		reasons.push({ key: "ambiguous", count: input.ambiguousCount });
	}
	if (input.analysisMissing) {
		reasons.push({ key: "missing", count: 0 });
	} else if (input.analysisStale) {
		reasons.push({ key: "stale", count: 0 });
	}

	// No criteria means there is nothing to be ready against — reporting "ready"
	// there would be the single most misleading thing this card could say.
	//
	// Guarded on `reasons` being empty, like the truncation check below. A
	// feature can have no parsed criteria AND a linked case whose last CI run
	// failed: `failingCases` is counted over the linked cases, not over the
	// matrix. Returning early there put the muted "Nothing to test against yet"
	// headline directly above the words "1 linked case is failing" — the card
	// contradicting itself, and downplaying a real defect.
	if (input.criteriaCount === 0 && reasons.length === 0) {
		return { level: "unknown", headlineKey: "noCriteria", reasons };
	}

	// A truncated case list cannot support a clean verdict: the failures that
	// would change it may be on a page nobody loaded.
	if (reasons.length === 0 && input.casesTruncated) {
		return { level: "unknown", headlineKey: "partial", reasons };
	}

	if (reasons.length === 0) {
		return { level: "ready", headlineKey: "ready", reasons };
	}

	// Anything that is a known defect or an untested criterion blocks. A merely
	// ambiguous or stale picture is a caution: it can still be signed off by
	// someone who reads it and decides it is fine.
	const blocking = reasons.some(
		(r) => r.key === "failing" || r.key === "uncovered",
	);
	return {
		level: blocking ? "blocked" : "caution",
		headlineKey: blocking ? "blocked" : "caution",
		reasons,
	};
}
