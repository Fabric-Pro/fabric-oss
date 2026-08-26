/**
 * Hybrid test-case <-> automated-test linkage.
 *
 * Resolves an incoming automated-test result to a Fabric test case by a cascade,
 * FIRST HIT WINS, strongest signal first:
 *   1. tag   — an explicit `@TC-###` marker in the test name/classname, matched
 *              against `TestCase.identifier`. Survives renames; the only tier a
 *              team opts into by annotating a test.
 *   2. path  — the case is file-qualified (`automationFilePath` set) AND its
 *              `automationRef` matches the test name / classname. The Azure
 *              "Test Function Name" style: precise when tests map 1:1 to cases.
 *   3. title — `automationRef` or the case title matches the test's describe/it
 *              text, with no file qualifier. The broad practice from the team
 *              discussion; weakest, brittle to wording drift.
 *
 * The chosen tier is returned so a weak title-only match is visibly weaker than
 * a tagged one (callers can surface / down-weight it). A result matching nothing
 * returns `null` — the caller buckets it as "unmatched" rather than guessing.
 * Pure over the candidate cases passed in.
 */

export type LinkableCase = {
	id: string;
	identifier: string; // "TC-001"
	title: string;
	automationRef: string | null;
	automationFilePath: string | null;
};

type MatchTier = "tag" | "path" | "title";

export type LinkMatch = {
	caseId: string;
	tier: MatchTier;
	/** The value that produced the match — provenance for debugging / display. */
	matchedOn: string;
};

/** `@TC-14`, `TC-014`, `[tc-7]` … — the case identifier embedded in a test. */
const TC_TAG = /\bTC-0*(\d+)\b/i;

/**
 * The case NUMBER carried by a `TC-###` tag or identifier, or null.
 *
 * Numeric, never a string compare: identifiers are minted zero-padded to three
 * digits (`TC-007` — see `nextTestCaseIdentifierFrom` in test-cases.ts) while an
 * author writes the natural number in a test name (`@TC-7`). Comparing the two as
 * strings silently failed every case below TC-100, and because a tag that names no
 * case is deliberately NOT downgraded to a title guess (see the cascade below),
 * tagging a test made matching strictly WORSE than leaving it untagged.
 */
export function parseTcTagNumber(
	text: string | undefined | null,
): number | null {
	const m = text?.match(TC_TAG);
	return m ? Number(m[1]) : null;
}

/** Collapse case + whitespace so titles compare regardless of formatting. */
function norm(s: string | undefined | null): string {
	return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolve one normalized test result to a case via the cascade. `cases` is the
 * candidate set (e.g. the project's cases); matching never mutates it.
 */
export function resolveAutomationLink(
	result: { name: string; classname?: string },
	cases: LinkableCase[],
): LinkMatch | null {
	const hay = `${result.classname ?? ""} ${result.name}`;
	const nName = norm(result.name);
	const nHay = norm(hay);

	// Tier 1 — explicit @TC-### tag → identifier. Strongest.
	const tagNumber = parseTcTagNumber(hay);
	if (tagNumber !== null) {
		const byId = cases.find(
			(c) => parseTcTagNumber(c.identifier) === tagNumber,
		);
		if (byId) {
			// Report the case's own identifier, not the tag as typed: `@TC-7`
			// and `TC-007` are the same case, and the canonical form is the
			// more useful provenance.
			return { caseId: byId.id, tier: "tag", matchedOn: byId.identifier };
		}
		// A tag that names no case is deliberately NOT downgraded to a fuzzy
		// title match — the author asserted a specific case that doesn't exist,
		// so this is an unmatched result, not a title guess.
		return null;
	}

	// Tier 2 — file-qualified: the case has a spec-file path AND its ref matches
	// the test name/classname. Precise 1:1 automation link.
	const byPath = cases.find(
		(c) =>
			c.automationFilePath != null &&
			c.automationRef != null &&
			(norm(c.automationRef) === nName ||
				norm(c.automationRef) === norm(result.classname) ||
				norm(c.automationRef) === nHay),
	);
	if (byPath?.automationRef) {
		return {
			caseId: byPath.id,
			tier: "path",
			matchedOn: byPath.automationRef,
		};
	}

	// Tier 3 — title/ref fuzzy, no file qualifier. Weakest; brittle to renames.
	const byTitle = cases.find(
		(c) =>
			(c.automationRef != null &&
				(norm(c.automationRef) === nName ||
					norm(c.automationRef) === nHay)) ||
			norm(c.title) === nName ||
			norm(c.title) === nHay,
	);
	if (byTitle) {
		return { caseId: byTitle.id, tier: "title", matchedOn: result.name };
	}

	return null;
}
