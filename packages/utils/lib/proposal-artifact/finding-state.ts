/**
 * The state of each analysis finding and of each answer to one, for a
 * Proposal (Fizzy #2946).
 *
 * An answer — a confirmation or a written response — belongs to a document
 * and a finding's stable key, not to a run, and stores the section key and
 * prose hash (`section-hash.ts`) it was given against. Whether it still
 * stands is derived here, at read time, from the answers, the body's
 * current section map and the run being shown; nothing is stored, so no
 * writer has to clear a flag. The analysis read and the settled-decisions
 * feed both call this one derivation, so the tab and the prompt never
 * disagree about which answers stand.
 *
 * An answer needs review when, in this order of precedence:
 *
 * 1. `SECTION_NOT_FOUND` — the body has no section with its key any more
 *    (the heading was renamed, moved under another parent, or removed);
 * 2. `SECTION_CHANGED` — the section's prose hash differs from the stored
 *    one; an answer to a finding that names no section compares against the
 *    document prose hash instead;
 * 3. `RAISED_AGAIN` — the shown run raises the answer's key again, is not
 *    the run the answer was given on (or mapped to), and was created after
 *    the answer was last updated. This holds even when the text is
 *    unchanged: the analysis is told not to re-raise settled points unless
 *    the document contradicts them. An older run shown after a Reject does
 *    not raise anything again.
 *
 * A stored key or hash written by another projection version can be neither
 * matched nor compared, so it reads as unknown, not as changed: the
 * comparison it blocks is skipped and `versionUnknown` is set. An unknown
 * key skips both section checks; an unknown hash under a current key still
 * reports a missing section. `RAISED_AGAIN` does not depend on the
 * projection and always applies.
 *
 * Pure and data-only: no database, no parser.
 */

import type {
	FindingResponseKind,
	FindingState,
	NeedsReviewReason,
	ResponseState,
} from "./finding-constants";
import {
	DOCUMENT_SECTION_KEY,
	isCurrentSectionVersion,
	type SectionMap,
} from "./section-hash";

export {
	FINDING_ANSWER_MAX_LENGTH,
	FINDING_RESPONSE_KINDS,
	FINDING_STATES,
	type FindingResponseKind,
	type FindingSeverity,
	type FindingState,
	type FindingType,
	NEEDS_REVIEW_REASONS,
	type NeedsReviewReason,
	PROPOSAL_FINDING_SEVERITIES,
	PROPOSAL_FINDING_TYPES,
	RESPONSE_STATES,
	type ResponseState,
} from "./finding-constants";

export interface FindingResponseInput {
	stableKey: string;
	kind: FindingResponseKind;
	/**
	 * Section key the answer was given against. `DOCUMENT_SECTION_KEY`, or
	 * `null`, for a finding that names no section.
	 */
	sectionKey: string | null;
	/** That section's prose hash, or the document prose hash, at the time. */
	sectionHash: string;
	/** The run the answer was given on, or the run a stale submit mapped to. */
	answeredRunId: string;
	updatedAt: Date | string;
}

export interface ShownRunInput {
	id: string;
	createdAt: Date | string;
	/** Stable keys of the findings the run raises, in display order. */
	findingKeys: readonly string[];
}

export interface DerivedResponse<
	R extends FindingResponseInput = FindingResponseInput,
> {
	response: R;
	state: ResponseState;
	/** Set exactly when `state` is `NEEDS_REVIEW`. */
	reason: NeedsReviewReason | null;
	/**
	 * The stored key or hash carries another projection version, so a
	 * section comparison was skipped rather than read as a change.
	 */
	versionUnknown: boolean;
}

export interface DerivedFinding<
	R extends FindingResponseInput = FindingResponseInput,
> {
	stableKey: string;
	state: FindingState;
	reason: NeedsReviewReason | null;
	/** The answer for this key, or `null` when the finding is unaddressed. */
	response: DerivedResponse<R> | null;
}

export interface FindingStates<
	R extends FindingResponseInput = FindingResponseInput,
> {
	/** One per finding of the shown run, in its order; none without a run. */
	findings: DerivedFinding<R>[];
	/** Answers whose key the shown run does not raise, in input order. */
	noLongerRaised: DerivedResponse<R>[];
	/** Every answer, one per stable key, in input order. */
	responses: DerivedResponse<R>[];
}

export interface DeriveFindingStatesInput<R extends FindingResponseInput> {
	responses: readonly R[];
	/** The current body's map (`buildSectionMap`). */
	sectionMap: SectionMap;
	/** The run the tab shows, or `null` when there is none. */
	shownRun: ShownRunInput | null;
}

/**
 * Every answer's derived state, and every shown finding's. Two answers for
 * one stable key should not exist; if they do, the one updated last wins.
 */
export function deriveFindingStates<R extends FindingResponseInput>(
	input: DeriveFindingStatesInput<R>,
): FindingStates<R> {
	const hashes = sectionHashes(input.sectionMap);
	const raised = new Set(input.shownRun?.findingKeys ?? []);

	const latest = new Map<string, R>();
	for (const response of input.responses) {
		const held = latest.get(response.stableKey);
		if (!held || epoch(response.updatedAt) > epoch(held.updatedAt)) {
			latest.set(response.stableKey, response);
		}
	}

	const byKey = new Map<string, DerivedResponse<R>>();
	const responses: DerivedResponse<R>[] = [];
	const noLongerRaised: DerivedResponse<R>[] = [];
	for (const response of input.responses) {
		if (latest.get(response.stableKey) !== response) {
			continue;
		}
		const derived = derive(
			response,
			hashes,
			input.sectionMap.documentProseHash,
			input.shownRun,
		);
		byKey.set(response.stableKey, derived);
		responses.push(derived);
		if (!raised.has(response.stableKey)) {
			noLongerRaised.push(derived);
		}
	}

	const findings: DerivedFinding<R>[] = [];
	for (const stableKey of raised) {
		const response = byKey.get(stableKey) ?? null;
		findings.push({
			stableKey,
			state: response ? response.state : "UNADDRESSED",
			reason: response ? response.reason : null,
			response,
		});
	}

	return { findings, noLongerRaised, responses };
}

/** One answer's derived state against the current body and shown run. */
function derive<R extends FindingResponseInput>(
	response: R,
	hashes: ReadonlyMap<string, string>,
	documentHash: string,
	shownRun: ShownRunInput | null,
): DerivedResponse<R> {
	const needsReview = (
		reason: NeedsReviewReason,
		versionUnknown: boolean,
	) => ({
		response,
		state: "NEEDS_REVIEW" as const,
		reason,
		versionUnknown,
	});

	const hashKnown = isCurrentSectionVersion(response.sectionHash);
	let versionUnknown = !hashKnown;
	if (
		response.sectionKey === null ||
		response.sectionKey === DOCUMENT_SECTION_KEY
	) {
		if (hashKnown && response.sectionHash !== documentHash) {
			return needsReview("SECTION_CHANGED", false);
		}
	} else if (isCurrentSectionVersion(response.sectionKey)) {
		const current = hashes.get(response.sectionKey);
		if (current === undefined) {
			return needsReview("SECTION_NOT_FOUND", versionUnknown);
		}
		if (hashKnown && response.sectionHash !== current) {
			return needsReview("SECTION_CHANGED", false);
		}
	} else {
		versionUnknown = true;
	}

	if (shownRun && raisedAgain(response, shownRun)) {
		return needsReview("RAISED_AGAIN", versionUnknown);
	}
	return { response, state: response.kind, reason: null, versionUnknown };
}

/**
 * The shown run raises the answer's key, is not the run it was given on,
 * and is newer than the answer. A time that cannot be read counts as newer,
 * so an unreadable row asks for review rather than standing unchecked.
 */
function raisedAgain(
	response: FindingResponseInput,
	shownRun: ShownRunInput,
): boolean {
	return (
		shownRun.findingKeys.includes(response.stableKey) &&
		shownRun.id !== response.answeredRunId &&
		!(epoch(shownRun.createdAt) <= epoch(response.updatedAt))
	);
}

function sectionHashes(map: SectionMap): Map<string, string> {
	return new Map(
		map.sections.map((section) => [section.key, section.proseHash]),
	);
}

function epoch(value: Date | string): number {
	return value instanceof Date ? value.getTime() : Date.parse(value);
}
