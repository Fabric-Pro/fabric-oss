/**
 * The coverage index behind the richer traceability matrix (spec §7.4 A4 / gap
 * G5).
 *
 * The shipped matrix could say a criterion had three cases and what fraction
 * passed. It could not say what KIND of coverage those three were, where the
 * automation lives, which commit last proved it, whether anyone captured
 * evidence, or whether the cases still match the feature they were drafted from.
 * "Three cases" means something very different when all three are manual
 * clickthroughs than when one is a unit test, one an integration test and one an
 * E2E run — and that difference is the question a team actually asks of a
 * coverage report.
 *
 * Almost none of this needed new storage. The pieces already existed and had
 * never been read together:
 *
 *  - the pyramid level was the one genuine gap → `TestCase.coverageType`;
 *  - the spec file is `automationFilePath`;
 *  - the last run is `currentResult` + `lastRunAt`;
 *  - the commit comes from the pipeline run that produced the newest result;
 *  - evidence is the agentic step logs under that result that captured a
 *    screenshot;
 *  - staleness is `draftedFromSpecHash` against the feature's fingerprint now.
 *
 * So this is a read model, not a new table. A materialised coverage index would
 * be a second copy of facts the rows above already hold, and every write path
 * would then owe it an update — which is how a coverage report starts lying.
 */

import { db } from "../../client";
import { fingerprintSpecText } from "./test-case-drift";

export interface CoverageIndexEntry {
	id: string;
	identifier: string;
	title: string;
	/** Every criterion this case claims to cover on the indexed story. */
	acceptanceCriterionRefs: string[];
	coverageType: "UNIT" | "INTEGRATION" | "E2E" | "MANUAL" | null;
	currentResult: string;
	lastRunAt: Date | null;
	/** Repo-relative path of the automation that covers this case. */
	specFilePath: string | null;
	/** Commit the newest result came from; null for manual and PM-synced runs. */
	commitSha: string | null;
	/** Screenshots captured by the newest run's steps. */
	evidenceCount: number;
	/**
	 * The feature's text changed since this case was drafted from it. Never true
	 * for a hand-authored case: it was not derived from that text, so it cannot
	 * have drifted from it.
	 */
	isStale: boolean;
}

export interface CoverageIndex {
	entries: CoverageIndexEntry[];
	/** The feature fingerprint every entry's staleness was judged against. */
	currentSpecHash: string;
}

/**
 * Build the coverage index for one feature.
 *
 * Returns entries in identifier order so the matrix renders stably; the caller
 * groups them by acceptance criterion.
 */
export async function getCoverageIndexForStory(input: {
	projectId: string;
	storyId: string;
	story: {
		title: string;
		description?: string | null;
		acceptanceCriteria?: string | null;
	};
}): Promise<CoverageIndex> {
	const currentSpecHash = fingerprintSpecText(input.story);

	const cases = await db.testCase.findMany({
		where: {
			projectId: input.projectId,
			deletedAt: null,
			workItemLinks: { some: { userStoryId: input.storyId } },
		},
		select: {
			id: true,
			identifier: true,
			title: true,
			coverageType: true,
			currentResult: true,
			lastRunAt: true,
			automationFilePath: true,
			draftedFromSpecHash: true,
			workItemLinks: {
				where: { userStoryId: input.storyId },
				select: { acceptanceCriterionRefs: true },
			},
			// The newest result carries the run provenance. The table is
			// append-only and the newest row is the current one — reporting a
			// commit from two runs back would be worse than reporting none,
			// because it reads as current.
			resultEvents: {
				orderBy: { occurredAt: "desc" },
				take: 1,
				select: {
					pipelineRun: { select: { commitSha: true } },
					// Counted rather than loaded: the matrix shows how many, and
					// pulling every step's payload to length an array would read
					// the whole run log for a number.
					_count: {
						select: {
							agenticSteps: {
								where: { evidenceKey: { not: null } },
							},
						},
					},
				},
			},
		},
		orderBy: { identifier: "asc" },
	});

	return {
		currentSpecHash,
		entries: cases.map((c) => {
			const latest = c.resultEvents[0];
			return {
				id: c.id,
				identifier: c.identifier,
				title: c.title,
				// Flattened across links rather than read off the first one.
				// The query already filters to this story, so there is normally
				// one link — but taking [0] would silently drop the rest if that
				// ever stopped being true, and the index is what coverage is
				// counted from.
				acceptanceCriterionRefs: c.workItemLinks.flatMap(
					(l) => l.acceptanceCriterionRefs,
				),
				coverageType: c.coverageType,
				currentResult: c.currentResult,
				lastRunAt: c.lastRunAt,
				specFilePath: c.automationFilePath,
				commitSha: latest?.pipelineRun?.commitSha ?? null,
				evidenceCount: latest?._count.agenticSteps ?? 0,
				// A case with no recorded hash was authored by hand. Comparing it
				// against the feature text would mark somebody's own work stale.
				isStale:
					c.draftedFromSpecHash !== null &&
					c.draftedFromSpecHash !== currentSpecHash,
			};
		}),
	};
}

/**
 * Coverage counts per pyramid level, for the matrix's summary line.
 *
 * `unknown` is reported alongside the named levels rather than folded into
 * MANUAL. They are different statements — "a person runs this" versus "nobody
 * has said" — and collapsing them would make an unclassified backlog look like
 * a deliberate manual-testing policy.
 */
export function summariseCoverageTypes(entries: CoverageIndexEntry[]): {
	unit: number;
	integration: number;
	e2e: number;
	manual: number;
	unknown: number;
} {
	const summary = { unit: 0, integration: 0, e2e: 0, manual: 0, unknown: 0 };
	for (const entry of entries) {
		switch (entry.coverageType) {
			case "UNIT":
				summary.unit += 1;
				break;
			case "INTEGRATION":
				summary.integration += 1;
				break;
			case "E2E":
				summary.e2e += 1;
				break;
			case "MANUAL":
				summary.manual += 1;
				break;
			default:
				summary.unknown += 1;
		}
	}
	return summary;
}
