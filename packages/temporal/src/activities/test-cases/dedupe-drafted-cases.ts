/**
 * Keep the drafter from re-creating cases a feature already has.
 *
 * Drafting appends. Run it once and you get a set of cases; run it again after
 * the feature changes and you get that set AGAIN, alongside the originals —
 * near-duplicates differing by a word, which a human then has to reconcile by
 * hand. The spec names this as the trap blocking TDD step 6 ("Test Case Updates
 * adjusted to the actually implemented flows"): step 6 needs an update path, and
 * an update path is impossible while a second draft pass silently doubles the
 * suite.
 *
 * This is the floor, not the ceiling: it prevents the duplicate, it does not yet
 * *update* the existing case to match a changed flow. That remains step 6's real
 * work — but it is now a solvable problem rather than one buried under twenty
 * copies.
 *
 * Pure and dependency-free, so the matching rule is testable without a model
 * call or a database.
 */

/**
 * A case the model just produced, or one that already exists on the feature.
 *
 * Both sides speak the link's own plural shape (`acceptanceCriterionRefs`):
 * the drafter names at most one criterion per case, but a stored link can carry
 * several, and a re-draft naming any of them must still match.
 */
export interface DedupeCaseKey {
	title: string;
	/** Criteria this case covers; empty means it names none. */
	acceptanceCriterionRefs?: readonly string[];
}

/**
 * Reduce a title to what actually identifies it.
 *
 * Two drafting runs describe the same check with cosmetically different words:
 * "Verify the user can reset their password." vs "verify user can reset their
 * password". Matching raw strings would treat those as different cases, which is
 * the whole problem. So: case-folded, punctuation dropped, whitespace collapsed,
 * and the filler verbs QA titles open with removed — they carry no information
 * and vary freely between runs.
 *
 * Deliberately NOT stemming or fuzzy-matching. An over-eager rule silently
 * discards a genuinely new case, which is far worse than leaving a near-duplicate
 * for a human to merge: one loses coverage, the other only costs tidying.
 */
export function normaliseCaseTitle(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.replace(/\s+/g, " ")
			.trim()
			.replace(
				/^(verify|check|ensure|validate|confirm|test)\s+(that\s+)?/u,
				"",
			)
			// Articles ANYWHERE, not just leading: one run writes "rejects an expired
			// token" and the next "rejects expired token". Safe to drop wholesale —
			// an article never distinguishes two cases, whereas the words around it
			// ("expired" vs "malformed") still do.
			//
			// The word boundaries are load-bearing: without them this strips the
			// letter "a" out of the middle of every word, mangling the title and
			// potentially colliding two genuinely different cases.
			.replace(/\b(?:the|an?)\b/gu, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/**
 * Reduce a stored ref to what the traceability resolver would resolve it to,
 * so two spellings of one criterion deduplicate as one. Mirrors
 * `criterionIndexFromRef` (first integer, ≥1): "AC 3", "3", "criterion 3" and
 * "AC 3 (retry policy)" all resolve to criterion 3, so they must share a key —
 * otherwise every novel spelling of the same criterion re-creates the case on
 * the next draft. A ref the resolver cannot place (no number) shares the
 * no-ref bucket, which is where the resolver puts it too. Empty on failure.
 */
function canonicalCriterionKey(ref: string): string {
	const trimmed = ref.trim();
	if (!trimmed) {
		return "";
	}
	const match = trimmed.match(/\d+/);
	if (!match) {
		return "";
	}
	const index = Number.parseInt(match[0], 10);
	// Parse rather than keep the digit run: "AC 03" and "AC 3" resolve to the
	// same criterion, so they must share a key too.
	return index >= 1 ? String(index) : "";
}

/**
 * Every key a case deduplicates on: its normalised title under each criterion
 * it covers, falling back to a shared no-criterion bucket.
 *
 * Scoped by AC deliberately. "Rejects an invalid input" is a reasonable case
 * title under two different criteria, and those are two different cases — a
 * title-only key would drop the second and quietly lose coverage. A case whose
 * refs the resolver cannot place falls into a shared bucket, which is the
 * conservative direction: at worst it declines to create something a human can
 * add by hand.
 */
export function draftDedupeKeys(c: DedupeCaseKey): string[] {
	const title = normaliseCaseTitle(c.title);
	const refs = [
		...new Set(
			(c.acceptanceCriterionRefs ?? [])
				.map(canonicalCriterionKey)
				.filter((ref) => ref !== ""),
		),
	];
	if (refs.length === 0) {
		return [`::${title}`];
	}
	return refs.map((ref) => `${ref}::${title}`);
}

export interface DedupeResult<T> {
	/** Cases to create — nothing here duplicates an existing case. */
	toCreate: T[];
	/** Titles skipped, for the run summary. Never silently dropped. */
	skippedTitles: string[];
}

/**
 * Split a drafting run's output into what to create and what already exists.
 *
 * A candidate is skipped when it shares a criterion with an existing case of the
 * same normalised title. Also deduplicates WITHIN the run: a model asked twice
 * for the same criterion can emit the same case twice in one response, and
 * creating both would be this bug in miniature.
 *
 * Skipped titles are returned rather than dropped, because "we generated 12 and
 * created 3" is information the person who pressed the button needs — silently
 * creating 3 looks like the model underperformed.
 */
export function dedupeDraftedCases<T extends DedupeCaseKey>(
	drafted: T[],
	existing: DedupeCaseKey[],
): DedupeResult<T> {
	const seen = new Set<string>();
	for (const e of existing) {
		for (const key of draftDedupeKeys(e)) {
			seen.add(key);
		}
	}

	const toCreate: T[] = [];
	const skippedTitles: string[] = [];

	for (const candidate of drafted) {
		const keys = draftDedupeKeys(candidate);
		if (keys.some((key) => seen.has(key))) {
			skippedTitles.push(candidate.title);
			continue;
		}
		for (const key of keys) {
			seen.add(key);
		}
		toCreate.push(candidate);
	}

	return { toCreate, skippedTitles };
}
