/**
 * Collect a member's unclaimed evidence over a range of work dates and group
 * it into the blocks of time to suggest. Deterministic: no model is involved,
 * and the duration of each block comes only from evidence with a time span.
 */

import {
	collectUnclaimedTimeEvidence,
	listAuthorLoggedTime,
} from "@repo/database";
import { groupTimeEvidence, zonedMidnight } from "@repo/utils/time-suggestions";
import { addDays } from "@repo/utils/time-tracking";
import type { TimeSuggestionCandidate } from "./types";

/**
 * The most blocks one generation suggests. The newest work dates are kept;
 * evidence of the rest stays unclaimed for the next generation.
 */
export const MAX_TIME_SUGGESTION_CANDIDATES = 100;

export interface CollectTimeSuggestionCandidatesInput {
	organizationId: string;
	userId: string;
	fromDate: string;
	toDate: string;
	timezone: string;
	/**
	 * The projects the member could discover and log time on when the run
	 * started, with their names.
	 */
	projects: { id: string; name: string }[];
}

export async function collectTimeSuggestionCandidatesActivity(
	input: CollectTimeSuggestionCandidatesInput,
): Promise<TimeSuggestionCandidate[]> {
	const from = zonedMidnight(input.fromDate, input.timezone);
	const to = zonedMidnight(addDays(input.toDate, 1), input.timezone);
	const projectNames = new Map(
		input.projects.map((project) => [project.id, project.name]),
	);

	const [evidence, logged] = await Promise.all([
		collectUnclaimedTimeEvidence({
			organizationId: input.organizationId,
			userId: input.userId,
			projectIds: [...projectNames.keys()],
			from,
			to,
		}),
		listAuthorLoggedTime({
			organizationId: input.organizationId,
			userId: input.userId,
			from,
			to,
			fromDate: input.fromDate,
			toDate: input.toDate,
		}),
	]);
	if (evidence.length === 0) {
		return [];
	}

	const stories = new Map<
		string,
		{ identifier: string | null; title: string | null }
	>();
	for (const item of evidence) {
		if (item.storyId) {
			stories.set(item.storyId, {
				identifier: item.storyIdentifier,
				title: item.storyTitle,
			});
		}
	}

	const groups = groupTimeEvidence({
		evidence,
		timeZone: input.timezone,
		loggedIntervals: logged.intervals,
		loggedEntries: logged.entries,
	});

	return groups
		.reverse()
		.slice(0, MAX_TIME_SUGGESTION_CANDIDATES)
		.map((group) => {
			const story = group.storyId
				? stories.get(group.storyId)
				: undefined;
			return {
				workDate: group.workDate,
				projectId: group.projectId,
				projectName: projectNames.get(group.projectId) ?? "",
				storyId: group.storyId,
				storyIdentifier: story?.identifier ?? null,
				storyTitle: story?.title ?? null,
				activity: group.activity,
				durationMinutes: group.durationMinutes,
				startAt: group.startAt?.toISOString() ?? null,
				stopAt: group.stopAt?.toISOString() ?? null,
				evidence: group.evidence.map((item) => ({
					kind: item.kind,
					sourceId: item.sourceId,
					occurredAt: item.occurredAt.toISOString(),
					startAt: item.startAt?.toISOString() ?? null,
					endAt: item.endAt?.toISOString() ?? null,
				})),
			};
		});
}
