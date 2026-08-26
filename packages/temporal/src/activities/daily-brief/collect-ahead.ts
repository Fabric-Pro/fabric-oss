/**
 * Daily Brief — Ahead Collector
 *
 * Emits forward-looking `AheadItem[]` for the UI's "Ahead" panel. Purely
 * SQL-backed (no LLM, no external API).
 *
 * Current implementation:
 *   1. story_about_to_transition — stories in an active status with ≥80% of
 *      their tasks completed (via StoryTask.agentCompletedAt) but not yet
 *      moved to the Done column. High-signal "this is about to ship" hint.
 *
 * Future extensions (require schema additions — not in this task):
 *   - upcoming_meeting — needs a scheduled-start column on
 *     ProjectLinkedMeeting (or a Microsoft Graph API fetch). Not wired yet.
 *   - proposal_expiring — needs an `expiresAt` column on
 *     PendingBacklogProposal. Not wired yet.
 *
 * The pure `shouldIncludeMeeting` helper and `AHEAD_LOOKAHEAD_HOURS` constant
 * are exported now so Task 5.3's UI + a future upcoming-meeting extension
 * share the same threshold.
 */
import { type AheadItem, db } from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { ACTIVE_STATUS_NAME_RE } from "./detect-priority-actions";

export const AHEAD_LOOKAHEAD_HOURS = 24;
const TRANSITION_COMPLETION_RATIO = 0.8;

export interface CollectAheadInput {
	projectId: string;
	organizationId: string | null;
}

export function shouldIncludeMeeting(params: {
	start: Date;
	now?: Date;
}): boolean {
	const now = params.now ?? new Date();
	const endOfWindow = new Date(
		now.getTime() + AHEAD_LOOKAHEAD_HOURS * 60 * 60 * 1000,
	);
	return params.start >= now && params.start <= endOfWindow;
}

export async function collectAhead(
	input: CollectAheadInput,
): Promise<AheadItem[]> {
	const { projectId, organizationId } = input;
	heartbeat("collectAhead: starting");

	const items: AheadItem[] = [];
	const now = new Date();

	// ---------------------------------------------------------------------------
	// Stories about to transition: active status + >= 80% of tasks completed.
	// ---------------------------------------------------------------------------
	const statuses = await db.projectStoryStatus.findMany({
		where: {
			projectId,
			project: { organizationId },
		},
		select: { id: true, name: true },
	});
	const activeStatusIds = statuses
		.filter((s) => ACTIVE_STATUS_NAME_RE.test(s.name))
		.map((s) => s.id);

	if (activeStatusIds.length > 0) {
		const activeStories = await db.userStory.findMany({
			where: {
				projectId,
				project: { organizationId },
				statusId: { in: activeStatusIds },
			},
			select: {
				id: true,
				identifier: true,
				title: true,
				tasks: {
					select: { id: true, agentCompletedAt: true },
				},
			},
			take: 100,
		});

		for (const s of activeStories) {
			if (s.tasks.length === 0) {
				continue;
			}
			const completed = s.tasks.filter(
				(t) => t.agentCompletedAt !== null,
			).length;
			const ratio = completed / s.tasks.length;
			if (
				ratio >= TRANSITION_COMPLETION_RATIO &&
				completed < s.tasks.length
			) {
				items.push({
					kind: "story_about_to_transition",
					title: s.title,
					occursAt: now,
					fabricLink: `/app/projects/${projectId}/stories/${s.id}`,
					targetCuid: s.id,
					targetIdentifier: s.identifier,
					context: `${completed}/${s.tasks.length} tasks completed`,
				});
			}
		}
	}

	items.sort((a, b) => a.occursAt.getTime() - b.occursAt.getTime());
	logger.info("[DailyBrief/collectAhead] Complete", {
		projectId,
		total: items.length,
	});
	return items;
}
