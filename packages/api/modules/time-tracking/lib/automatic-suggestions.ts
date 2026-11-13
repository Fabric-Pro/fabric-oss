/**
 * Time suggestions Fabric starts without being asked, so a time and materials
 * project's "To confirm" list fills by itself:
 *
 *   - after a meeting the member had the meeting agent join ends
 *     ({@link startTimeSuggestionsAfterMeeting});
 *   - after Fabric reads a new head commit of a pull request the member
 *     authored ({@link startTimeSuggestionsAfterPullRequest});
 *   - when the member opens My time and has had no run for a while
 *     ({@link refreshTimeSuggestions}).
 *
 * All read only projects `suggestsTimeAutomatically` allows, through
 * `automaticSuggestionProjects`. A fixed bid project is never read here;
 * "Check my activity" still covers it.
 */

import {
	findLatestTimeSuggestionRunStart,
	findMemberByGitHubLogin,
	isGitHubDotComPullRequest,
	listMemberTimeZoneCandidates,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	DEFAULT_TIME_SUGGESTION_SPAN_DAYS,
	localDateOf,
} from "@repo/utils/time-suggestions";
import { addDays, isValidTimeZone } from "@repo/utils/time-tracking";
import {
	automaticSuggestionProjects,
	loggableSuggestionProjects,
	startTimeSuggestions,
} from "./suggestion-runs";

/**
 * How long after a member's newest full-range run opening My time starts no
 * new one.
 */
const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;

export type RefreshTimeSuggestionsResult =
	| { status: "started"; runId: string }
	| { status: "in-progress" | "unavailable" | "fresh" | "no-projects" };

/**
 * Refresh the member's suggestions over the 7 days ending today in
 * `timezone`, on their time and materials projects, unless their newest run
 * in the organization over at least that many days started less than 12
 * hours ago (`fresh`) or none of
 * the projects they can log on is time and materials (`no-projects`).
 */
export async function refreshTimeSuggestions(params: {
	organizationId: string;
	userId: string;
	timezone: string;
	now: Date;
}): Promise<RefreshTimeSuggestionsResult> {
	const { organizationId, userId, timezone, now } = params;
	// Only a run over the full default range counts: a one-day run after a
	// meeting must not hold off the weekly refresh.
	const latestStart = await findLatestTimeSuggestionRunStart({
		organizationId,
		userId,
		minSpanDays: DEFAULT_TIME_SUGGESTION_SPAN_DAYS,
	});
	if (
		latestStart &&
		now.getTime() - latestStart.getTime() < REFRESH_AFTER_MS
	) {
		return { status: "fresh" };
	}

	const projects = automaticSuggestionProjects(
		await loggableSuggestionProjects({ organizationId, userId }),
	);
	if (projects.length === 0) {
		return { status: "no-projects" };
	}

	const toDate = localDateOf(now, timezone);
	return startTimeSuggestions({
		organizationId,
		userId,
		fromDate: addDays(toDate, 1 - DEFAULT_TIME_SUGGESTION_SPAN_DAYS),
		toDate,
		timezone,
		projects,
		automatic: true,
	});
}

/**
 * The time zone the member's work dates are read in: their profile's when
 * set, otherwise the one they last recorded time or a run in. Null when no
 * valid one is stored: the caller skips rather than guess.
 */
async function memberTimeZone(params: {
	organizationId: string;
	userId: string;
}): Promise<string | null> {
	const candidates = await listMemberTimeZoneCandidates(params);
	return candidates.find(isValidTimeZone) ?? null;
}

/**
 * Suggest time for a meeting the member had the meeting agent join, once it
 * has ended: a run over the meeting's work date, on its project only, when
 * that project is time and materials and the member can still log time on it.
 *
 * Awaited by meeting finalization after the session is committed, which must
 * never fail with it: every outcome, including an error, ends here in a log
 * line.
 */
export async function startTimeSuggestionsAfterMeeting(meeting: {
	sessionId: string;
	organizationId: string;
	userId: string;
	projectId: string;
	joinedAt: Date | null;
}): Promise<void> {
	const logContext = {
		sessionId: meeting.sessionId,
		organizationId: meeting.organizationId,
		projectId: meeting.projectId,
	};
	try {
		// A bot that never got in has no meeting to suggest.
		if (!meeting.joinedAt) {
			return;
		}
		const member = {
			organizationId: meeting.organizationId,
			userId: meeting.userId,
		};
		const projects = automaticSuggestionProjects(
			await loggableSuggestionProjects(member),
		).filter((project) => project.id === meeting.projectId);
		if (projects.length === 0) {
			return;
		}
		const timezone = await memberTimeZone(member);
		if (!timezone) {
			logger.info(
				"[time-suggestions] after-meeting skipped: no time zone",
				{
					...logContext,
				},
			);
			return;
		}
		const workDate = localDateOf(meeting.joinedAt, timezone);
		const result = await startTimeSuggestions({
			...member,
			fromDate: workDate,
			toDate: workDate,
			timezone,
			projects,
			automatic: true,
		});
		logger.info("[time-suggestions] after-meeting start", {
			...logContext,
			status: result.status,
		});
	} catch (error) {
		logger.warn("[time-suggestions] after-meeting start failed", {
			...logContext,
			detail: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Suggest time for a new head commit of a pull request Fabric read: a run
 * over the read's work date, on its project only, for the member whose
 * GitHub login authored it, when that project is time and materials and the
 * member can still log time on it.
 *
 * Only a github.com pull request whose author login is one member's own
 * verified login is attributed (`findMemberByGitHubLogin`); anything else
 * starts nothing. Awaited by the pull request read after the review is
 * stored, which must never fail with it: every outcome, including an error,
 * ends here in a log line.
 */
export async function startTimeSuggestionsAfterPullRequest(review: {
	reviewId: string;
	organizationId: string | null;
	projectId: string;
	provider: string;
	prUrl: string | null;
	authorLabel: string | null;
	createdAt: Date;
}): Promise<void> {
	const logContext = {
		reviewId: review.reviewId,
		organizationId: review.organizationId,
		projectId: review.projectId,
	};
	try {
		if (
			!review.organizationId ||
			!review.authorLabel ||
			!isGitHubDotComPullRequest(review)
		) {
			return;
		}
		const userId = await findMemberByGitHubLogin({
			organizationId: review.organizationId,
			login: review.authorLabel,
		});
		if (!userId) {
			logger.info(
				"[time-suggestions] after-pull-request skipped: author is not one member",
				logContext,
			);
			return;
		}
		const member = { organizationId: review.organizationId, userId };
		const projects = automaticSuggestionProjects(
			await loggableSuggestionProjects(member),
		).filter((project) => project.id === review.projectId);
		if (projects.length === 0) {
			return;
		}
		const timezone = await memberTimeZone(member);
		if (!timezone) {
			logger.info(
				"[time-suggestions] after-pull-request skipped: no time zone",
				logContext,
			);
			return;
		}
		const workDate = localDateOf(review.createdAt, timezone);
		const result = await startTimeSuggestions({
			...member,
			fromDate: workDate,
			toDate: workDate,
			timezone,
			projects,
			automatic: true,
		});
		logger.info("[time-suggestions] after-pull-request start", {
			...logContext,
			status: result.status,
		});
	} catch (error) {
		logger.warn("[time-suggestions] after-pull-request start failed", {
			...logContext,
			detail: error instanceof Error ? error.message : String(error),
		});
	}
}
