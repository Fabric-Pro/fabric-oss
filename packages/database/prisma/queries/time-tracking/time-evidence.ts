/**
 * The evidence time suggestions are built from: a member's own activity in
 * one organization, read deterministically.
 *
 * Every source is narrowed three ways: to the member as its AUTHOR (never as
 * the owner of the project or the tenant row), to the organization, and to
 * the projects the caller passes in, which are the ones the member can still
 * discover and holds `time:log` on. The procedures decide that list; these
 * reads only apply it.
 *
 * The sources, and the field that makes the member the author:
 *
 *  - MEETING_SESSION: a meeting they had the meeting agent join themselves
 *    (`ParlumeMeetingSession.userId`, trigger MANUAL), from join to end. A
 *    session the agent joined on its own (trigger AUTO) is left out: it
 *    names the member who enabled automatic joining, which says nothing
 *    about whether they attended.
 *  - TEST_RUN: a test run they started (`TestAgenticRun.triggeredByUserId`),
 *    as an instant at its start. Only finished runs count, but the run's
 *    length is the machine's runtime, not the member's working time, so it
 *    never becomes a duration.
 *  - FEATURE_EDIT: a version of a feature they saved (`FeatureVersion.
 *    changedBy`, the person making the change when the version was written).
 *  - TEST_RESULT: a result they recorded by hand (`TestResultEvent.
 *    changedByUserId`); results synced from a project-management tool are
 *    left out.
 *  - TEST_CASE_ACTIVITY: a change they made to a test case
 *    (`TestCaseActivity.actorUserId`; AI drafting and syncs carry none).
 *  - PULL_REQUEST: a pull request on github.com they authored, once per head
 *    commit Fabric read (`PullRequestReview.authorLabel`, the GitHub login of
 *    the pull request's author), as an instant at the read. The login must be
 *    one of the member's own and no other member's (`github-identity.ts`);
 *    without one, nothing is read. GitHub Enterprise, GitLab and Azure DevOps
 *    reviews are left out: their author label is not a login a github.com
 *    credential proves.
 *
 * Document versions are not a source: a `DocumentVersion` row snapshots the
 * content that was live before an edit, so its `changedBy` names the author
 * of that earlier content while its time is when someone superseded it.
 *
 * Only ids and times are read, never content. Evidence already claimed by any
 * suggestion of the member, whatever its status, is left out, so confirmed
 * work is never suggested again and dismissed work only comes back with new
 * evidence.
 */

import type { TimeEvidenceKind } from "@repo/utils/time-suggestions";
import { db, type Prisma } from "../../client";
import {
	GITHUB_PULL_REQUEST_PROVIDER,
	GITHUB_PULL_REQUEST_URL_PREFIX,
	listVerifiedMemberGitHubLogins,
} from "./github-identity";

/** The most rows one source contributes to one generation. */
export const TIME_EVIDENCE_PER_SOURCE_LIMIT = 500;

/** One piece of a member's own activity, with what a suggestion shows of it. */
export interface CollectedTimeEvidence {
	kind: TimeEvidenceKind;
	sourceId: string;
	projectId: string;
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
	occurredAt: Date;
	startAt: Date | null;
	endAt: Date | null;
}

function instant(params: {
	kind: TimeEvidenceKind;
	sourceId: string;
	projectId: string;
	occurredAt: Date;
	story?: { id: string; identifier: string; title: string } | null;
}): CollectedTimeEvidence {
	return {
		kind: params.kind,
		sourceId: params.sourceId,
		projectId: params.projectId,
		storyId: params.story?.id ?? null,
		storyIdentifier: params.story?.identifier ?? null,
		storyTitle: params.story?.title ?? null,
		occurredAt: params.occurredAt,
		startAt: null,
		endAt: null,
	};
}

function span(params: {
	kind: TimeEvidenceKind;
	sourceId: string;
	projectId: string;
	startAt: Date | null;
	endAt: Date | null;
}): CollectedTimeEvidence[] {
	if (!params.startAt || !params.endAt) {
		return [];
	}
	return [
		{
			kind: params.kind,
			sourceId: params.sourceId,
			projectId: params.projectId,
			storyId: null,
			storyIdentifier: null,
			storyTitle: null,
			occurredAt: params.startAt,
			startAt: params.startAt,
			endAt: params.endAt,
		},
	];
}

/** Reviews of the member's own github.com pull requests, read in `window`. */
async function memberPullRequestReviews(params: {
	organizationId: string;
	userId: string;
	projectIds: string[];
	window: { gte: Date; lt: Date };
}) {
	const logins = await listVerifiedMemberGitHubLogins({
		organizationId: params.organizationId,
		userId: params.userId,
	});
	if (logins.length === 0) {
		return [];
	}
	const byAuthor: Prisma.PullRequestReviewWhereInput[] = logins.map(
		(login) => ({ authorLabel: { equals: login, mode: "insensitive" } }),
	);
	return db.pullRequestReview.findMany({
		where: {
			organizationId: params.organizationId,
			projectId: { in: params.projectIds },
			provider: GITHUB_PULL_REQUEST_PROVIDER,
			prUrl: { startsWith: GITHUB_PULL_REQUEST_URL_PREFIX },
			createdAt: params.window,
			OR: byAuthor,
		},
		select: { id: true, projectId: true, createdAt: true },
		orderBy: { createdAt: "asc" },
		take: TIME_EVIDENCE_PER_SOURCE_LIMIT,
	});
}

/**
 * The member's own activity that started in `[from, to)`, on `projectIds`
 * of the organization, that no suggestion of theirs has claimed yet.
 */
export async function collectUnclaimedTimeEvidence(params: {
	organizationId: string;
	userId: string;
	projectIds: readonly string[];
	from: Date;
	to: Date;
}): Promise<CollectedTimeEvidence[]> {
	if (params.projectIds.length === 0) {
		return [];
	}
	const { organizationId, userId } = params;
	const projectIds = [...params.projectIds];
	const window = { gte: params.from, lt: params.to };
	const inProjects = { in: projectIds };

	const [
		meetings,
		testRuns,
		featureEdits,
		testResults,
		testCaseChanges,
		pullRequests,
	] = await Promise.all([
		db.parlumeMeetingSession.findMany({
			where: {
				organizationId,
				userId,
				projectId: inProjects,
				trigger: "MANUAL",
				joinedAt: window,
				endedAt: { not: null },
			},
			select: {
				id: true,
				projectId: true,
				joinedAt: true,
				endedAt: true,
			},
			orderBy: { joinedAt: "asc" },
			take: TIME_EVIDENCE_PER_SOURCE_LIMIT,
		}),
		db.testAgenticRun.findMany({
			where: {
				organizationId,
				triggeredByUserId: userId,
				projectId: inProjects,
				startedAt: window,
				finishedAt: { not: null },
			},
			select: {
				id: true,
				projectId: true,
				startedAt: true,
				finishedAt: true,
			},
			orderBy: { startedAt: "asc" },
			take: TIME_EVIDENCE_PER_SOURCE_LIMIT,
		}),
		db.featureVersion.findMany({
			where: {
				changedBy: userId,
				createdAt: window,
				story: {
					projectId: inProjects,
					project: { organizationId },
				},
			},
			select: {
				id: true,
				createdAt: true,
				story: {
					select: {
						id: true,
						projectId: true,
						identifier: true,
						title: true,
					},
				},
			},
			orderBy: { createdAt: "asc" },
			take: TIME_EVIDENCE_PER_SOURCE_LIMIT,
		}),
		db.testResultEvent.findMany({
			where: {
				changedByUserId: userId,
				source: { not: "PM_SYNC" },
				occurredAt: window,
				testCase: {
					projectId: inProjects,
					deletedAt: null,
					project: { organizationId },
				},
			},
			select: {
				id: true,
				occurredAt: true,
				testCase: { select: { projectId: true } },
			},
			orderBy: { occurredAt: "asc" },
			take: TIME_EVIDENCE_PER_SOURCE_LIMIT,
		}),
		db.testCaseActivity.findMany({
			where: {
				actorUserId: userId,
				occurredAt: window,
				testCase: {
					projectId: inProjects,
					deletedAt: null,
					project: { organizationId },
				},
			},
			select: {
				id: true,
				occurredAt: true,
				testCase: { select: { projectId: true } },
			},
			orderBy: { occurredAt: "asc" },
			take: TIME_EVIDENCE_PER_SOURCE_LIMIT,
		}),
		memberPullRequestReviews({
			organizationId,
			userId,
			projectIds,
			window,
		}),
	]);

	const collected: CollectedTimeEvidence[] = [
		...meetings.flatMap((meeting) =>
			span({
				kind: "MEETING_SESSION",
				sourceId: meeting.id,
				projectId: meeting.projectId,
				startAt: meeting.joinedAt,
				endAt: meeting.endedAt,
			}),
		),
		...testRuns.flatMap((run) =>
			run.startedAt
				? [
						instant({
							kind: "TEST_RUN",
							sourceId: run.id,
							projectId: run.projectId,
							occurredAt: run.startedAt,
						}),
					]
				: [],
		),
		...featureEdits.map((version) =>
			instant({
				kind: "FEATURE_EDIT",
				sourceId: version.id,
				projectId: version.story.projectId,
				occurredAt: version.createdAt,
				story: version.story,
			}),
		),
		...testResults.map((event) =>
			instant({
				kind: "TEST_RESULT",
				sourceId: event.id,
				projectId: event.testCase.projectId,
				occurredAt: event.occurredAt,
			}),
		),
		...testCaseChanges.map((activity) =>
			instant({
				kind: "TEST_CASE_ACTIVITY",
				sourceId: activity.id,
				projectId: activity.testCase.projectId,
				occurredAt: activity.occurredAt,
			}),
		),
		...pullRequests.map((review) =>
			instant({
				kind: "PULL_REQUEST",
				sourceId: review.id,
				projectId: review.projectId,
				occurredAt: review.createdAt,
			}),
		),
	];
	if (collected.length === 0) {
		return [];
	}

	const claimed = await db.timeSuggestionEvidence.findMany({
		where: {
			userId,
			sourceId: { in: collected.map((evidence) => evidence.sourceId) },
		},
		select: { kind: true, sourceId: true },
	});
	const claimedKeys = new Set(
		claimed.map((row) => `${row.kind}:${row.sourceId}`),
	);
	return collected.filter(
		(evidence) => !claimedKeys.has(`${evidence.kind}:${evidence.sourceId}`),
	);
}
