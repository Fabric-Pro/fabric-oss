/**
 * How much of a feature's acceptance criteria has a test case behind it.
 *
 * This existed only in the browser, as part of drawing the traceability matrix.
 * That was fine while the number was decoration; it stops being fine the moment
 * something refuses an action because of it, since a figure computed on the
 * client is a figure the client can be wrong about — or lie about.
 *
 * Deliberately counts CRITERIA COVERED, not cases written. Ten cases all
 * pointing at criterion 1 is not 10 coverage, and a team that measured itself
 * that way would be rewarded for writing the same test repeatedly.
 */

import {
	criterionIndexFromRef,
	parseAcceptanceCriteria,
} from "@repo/utils/acceptance-criteria";
import { db } from "../../client";

export interface StoryCoverage {
	/** Criteria parsed out of the feature's acceptance-criteria text. */
	totalCriteria: number;
	/** Distinct criteria with at least one live case naming them. */
	coveredCriteria: number;
	/** 0–100, rounded down. 100 when the feature states no criteria at all. */
	percent: number;
}

/**
 * Coverage for one feature.
 *
 * A feature with no acceptance criteria reports 100%: there is nothing to
 * cover, and reporting 0 would block it behind a target it can never reach.
 * That is a real case — a spike or a chore legitimately has no criteria — and
 * refusing to let one close would make the gate the loudest thing in the
 * product for the least useful reason.
 */
export async function getStoryCoverage(input: {
	projectId: string;
	userStoryId: string;
}): Promise<StoryCoverage> {
	const story = await db.userStory.findFirst({
		where: { id: input.userStoryId, projectId: input.projectId },
		select: { acceptanceCriteria: true },
	});
	const criteria = parseAcceptanceCriteria(story?.acceptanceCriteria ?? "");
	const totalCriteria = criteria.length;
	if (totalCriteria === 0) {
		return { totalCriteria: 0, coveredCriteria: 0, percent: 100 };
	}

	const links = await db.testCaseWorkItemLink.findMany({
		// A link outlives the case it points at, so a soft-deleted case must not
		// count — otherwise deleting a case leaves its coverage behind.
		where: {
			userStoryId: input.userStoryId,
			testCase: { deletedAt: null },
		},
		select: { acceptanceCriterionRefs: true },
	});

	// `criterionIndexFromRef` is the same resolver the traceability matrix uses,
	// reused rather than reimplemented so the gate and the matrix can never
	// disagree about what a reference points at. It returns a 1-based index and
	// null for a ref carrying no number.
	//
	// A reference past the end of the criteria resolves to nothing here: that is
	// the "cannot place" state the matrix reports separately — usually a case
	// written against a longer specification that has since shrunk — and
	// counting it as coverage would let a stale reference satisfy the gate.
	const covered = new Set<number>();
	for (const link of links) {
		for (const ref of link.acceptanceCriterionRefs) {
			const oneBased = criterionIndexFromRef(ref);
			if (oneBased !== null && oneBased <= totalCriteria) {
				covered.add(oneBased);
			}
		}
	}

	return {
		totalCriteria,
		coveredCriteria: covered.size,
		// Floored, so a project asking for 80% is not satisfied by 79.6%.
		percent: Math.floor((covered.size / totalCriteria) * 100),
	};
}
