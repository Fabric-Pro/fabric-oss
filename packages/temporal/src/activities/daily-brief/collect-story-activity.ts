/**
 * Daily Brief — Story & Task Collector Activity
 *
 * Reads UserStory, StoryTask, and FeatureVersion rows that were created or
 * genuinely edited inside the given time window for a specific project. Returns
 * typed StoryChangeItem[] and TaskChangeItem[] arrays that conform to the
 * shared daily-brief schema in @repo/database.
 *
 * DB-local: no LLM, no external HTTP. Intended to run fast as a standard
 * Temporal activity; a single heartbeat is emitted at the start for
 * progress registration.
 */

import { db, type StoryChangeItem, type TaskChangeItem } from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

// =============================================================================
// Types
// =============================================================================

export interface CollectStoryActivityInput {
	projectId: string;
	organizationId: string | null;
	timeWindowStart: Date | string;
	timeWindowEnd: Date | string;
}

export interface CollectStoryActivityOutput {
	stories: StoryChangeItem[];
	tasks: TaskChangeItem[];
}

// =============================================================================
// Activity
// =============================================================================

/**
 * Collect story + task changes for the Daily Brief.
 *
 * Source data:
 *   - UserStory rows created in window           -> "created"
 *   - UserStory rows genuinely edited in window  -> "content_changed"
 *   - FeatureVersion rows created in window      -> "content_changed" (versioned edits)
 *   - StoryTask rows created in window           -> "created"
 *   - StoryTask rows completed in window         -> "completed"
 *   - StoryTask rows otherwise updated in window -> "status_changed"
 *
 * Tenant belt-and-suspenders: project.organizationId is compared even though
 * activities run via the worker's superuser connection that bypasses RLS.
 */
/**
 * Row caps for the three queries below.
 *
 * These bound what crosses the Temporal activity boundary (Fizzy #1997): the
 * whole `sections` aggregate travels to the summarizer inside ONE gRPC
 * message, and the frontend rejects anything past 4 MiB. Every query is
 * ordered newest-first, so a cap keeps the most recent activity — which is
 * what a daily brief is for — and drops the long tail a reader would not
 * scroll to anyway. The prompt itself only ever shows 25 per source.
 */
const MAX_STORY_ROWS = 200;
const MAX_VERSION_ROWS = 200;
const MAX_TASK_ROWS = 200;

export async function collectStoryActivity(
	input: CollectStoryActivityInput,
): Promise<CollectStoryActivityOutput> {
	const { projectId, organizationId } = input;
	// Temporal serializes Date payloads to ISO strings on the wire. `new Date()`
	// copies Dates and parses strings, so this works regardless of input form.
	const timeWindowStart = new Date(input.timeWindowStart);
	const timeWindowEnd = new Date(input.timeWindowEnd);

	heartbeat("collectStoryActivity: starting");

	logger.info("[DailyBrief/collectStoryActivity] Starting", {
		projectId,
		organizationId,
		timeWindowStart: timeWindowStart.toISOString(),
		timeWindowEnd: timeWindowEnd.toISOString(),
	});

	// -------------------------------------------------------------------------
	// Stories — creation and genuine edits only. Operational writes must not
	// manufacture daily-brief content changes.
	// -------------------------------------------------------------------------
	const storyRows = await db.userStory.findMany({
		where: {
			projectId,
			project: { organizationId },
			OR: [
				{ createdAt: { gte: timeWindowStart, lte: timeWindowEnd } },
				{ lastEditedAt: { gte: timeWindowStart, lte: timeWindowEnd } },
			],
		},
		select: {
			id: true,
			identifier: true,
			title: true,
			createdById: true,
			createdAt: true,
			lastEditedAt: true,
			status: { select: { name: true } },
		},
		orderBy: [
			{ lastEditedAt: { sort: "desc", nulls: "last" } },
			{ createdAt: "desc" },
		],
		take: MAX_STORY_ROWS,
	});

	const stories: StoryChangeItem[] = [];
	for (const s of storyRows) {
		const wasCreatedInWindow =
			s.createdAt >= timeWindowStart && s.createdAt <= timeWindowEnd;
		if (wasCreatedInWindow) {
			stories.push({
				kind: "created",
				occurredAt: s.createdAt,
				title: s.title,
				storyCuid: s.id,
				storyIdentifier: s.identifier,
				toValue: s.status?.name,
				changedByUserId: s.createdById ?? undefined,
			});
		} else if (s.lastEditedAt) {
			stories.push({
				kind: "content_changed",
				occurredAt: s.lastEditedAt,
				title: s.title,
				storyCuid: s.id,
				storyIdentifier: s.identifier,
				toValue: s.status?.name,
			});
		}
	}

	// -------------------------------------------------------------------------
	// Feature/Story versions — granular content-change events. These are the
	// authoritative record of a description / AC edit, so they can show up in
	// addition to the row-level semantic edit event above (UI will dedupe by cuid
	// + occurredAt if needed).
	// -------------------------------------------------------------------------
	const versionRows = await db.featureVersion.findMany({
		where: {
			createdAt: { gte: timeWindowStart, lte: timeWindowEnd },
			story: {
				projectId,
				project: { organizationId },
			},
		},
		select: {
			id: true,
			version: true,
			changeDescription: true,
			changedBy: true,
			createdAt: true,
			story: {
				select: {
					id: true,
					identifier: true,
					title: true,
				},
			},
		},
		orderBy: { createdAt: "desc" },
		take: MAX_VERSION_ROWS,
	});

	for (const v of versionRows) {
		stories.push({
			kind: "content_changed",
			occurredAt: v.createdAt,
			title: v.story.title,
			storyCuid: v.story.id,
			storyIdentifier: v.story.identifier,
			toValue: v.changeDescription ?? `v${v.version}`,
			changedByUserId: v.changedBy ?? undefined,
		});
	}

	// -------------------------------------------------------------------------
	// Tasks — every StoryTask touched in the window. Classify by completion
	// state + createdAt.
	// -------------------------------------------------------------------------
	const taskRows = await db.storyTask.findMany({
		where: {
			story: {
				projectId,
				project: { organizationId },
			},
			OR: [
				{ createdAt: { gte: timeWindowStart, lte: timeWindowEnd } },
				{ updatedAt: { gte: timeWindowStart, lte: timeWindowEnd } },
				{
					agentCompletedAt: {
						gte: timeWindowStart,
						lte: timeWindowEnd,
					},
				},
			],
		},
		select: {
			id: true,
			identifier: true,
			title: true,
			isCompleted: true,
			agentStatus: true,
			agentCompletedAt: true,
			createdAt: true,
			updatedAt: true,
			story: {
				select: {
					id: true,
					identifier: true,
				},
			},
		},
		orderBy: { updatedAt: "desc" },
		take: MAX_TASK_ROWS,
	});

	const tasks: TaskChangeItem[] = [];
	for (const t of taskRows) {
		const createdInWindow =
			t.createdAt >= timeWindowStart && t.createdAt <= timeWindowEnd;
		const completedInWindow =
			t.isCompleted &&
			t.updatedAt >= timeWindowStart &&
			t.updatedAt <= timeWindowEnd;

		if (createdInWindow) {
			tasks.push({
				kind: "created",
				occurredAt: t.createdAt,
				title: t.title,
				taskCuid: t.id,
				taskIdentifier: t.identifier,
				storyCuid: t.story.id,
				storyIdentifier: t.story.identifier,
				toValue: t.agentStatus ?? undefined,
			});
		} else if (completedInWindow) {
			tasks.push({
				kind: "completed",
				occurredAt: t.updatedAt,
				title: t.title,
				taskCuid: t.id,
				taskIdentifier: t.identifier,
				storyCuid: t.story.id,
				storyIdentifier: t.story.identifier,
				toValue: "completed",
			});
		} else {
			tasks.push({
				kind: "status_changed",
				occurredAt: t.updatedAt,
				title: t.title,
				taskCuid: t.id,
				taskIdentifier: t.identifier,
				storyCuid: t.story.id,
				storyIdentifier: t.story.identifier,
				toValue: t.agentStatus ?? undefined,
			});
		}
	}

	logger.info("[DailyBrief/collectStoryActivity] Complete", {
		projectId,
		storyChangeCount: stories.length,
		taskChangeCount: tasks.length,
	});

	return { stories, tasks };
}
