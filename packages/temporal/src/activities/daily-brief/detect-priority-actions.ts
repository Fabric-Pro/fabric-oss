/**
 * Daily Brief — Priority Action Detector (deterministic, SQL-backed)
 *
 * Runs four rule checks against the Fabric data model and returns an array
 * of `PriorityAction` objects. This activity performs NO LLM calls — it
 * only identifies which items are "priority" and why (by `kind`). The AI
 * summarizer that consumes this output is responsible for filling in the
 * human-readable `whyItMatters` prose.
 *
 * Rules (as documented in the daily brief spec):
 *   0. security_findings       — OPEN HIGH/CRITICAL security findings from
 *                                the latest COMPLETED project scan.
 *   1. blocker                 — UserStory whose ProjectStoryStatus name
 *                                matches /blocked/i (case-insensitive).
 *                                StoryTask has no status column, so we only
 *                                evaluate this at the story level.
 *   2. decisions_proposed      — Project architecture decisions currently
 *                                in PROPOSED status (aggregated to one
 *                                action linking to the Decisions tab).
 *   3. due_date_risk           — NOT IMPLEMENTED. The current StoryTask
 *                                schema has no `dueDate` column; emitting
 *                                `[]` per the task brief. See TODO below.
 *   4. missing_ownership       — UserStory where assigneeId IS NULL and the
 *                                story's ProjectStoryStatus name matches
 *                                /in.?progress/i (case-insensitive).
 *   5. unresolved_dependency   — NOT IMPLEMENTED. The current schema has no
 *                                dependency / blockedBy / dependsOn table
 *                                between stories or tasks; emitting `[]`
 *                                per the task brief. See TODO below.
 *
 * Tenant isolation: activities run via the worker's superuser connection
 * that bypasses RLS, so we apply a belt-and-suspenders filter on
 * project.organizationId in addition to projectId.
 */

import {
	db,
	getLatestProjectScan,
	listArchitectureDecisions,
	type PriorityAction,
	type PriorityActionKind,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

// =============================================================================
// Types
// =============================================================================

export interface DetectPriorityActionsInput {
	projectId: string;
	organizationId: string | null;
}

export type DetectPriorityActionsOutput = PriorityAction[];

// =============================================================================
// Constants
// =============================================================================

export const STORY_STALE_THRESHOLD_DAYS = 5;
/** Most stale stories the daily brief will surface at once. */
const STALE_STORY_CAP = 20;
export const PR_REVIEW_STALE_THRESHOLD_DAYS = 3;

export const ACTIVE_STATUS_NAME_RE = /in.?progress|in.?review|ready/i;

export function isStoryStale(params: {
	statusName: string;
	updatedAt: Date;
	now?: Date;
}): boolean {
	const { statusName, updatedAt } = params;
	const now = params.now ?? new Date();
	if (!ACTIVE_STATUS_NAME_RE.test(statusName)) {
		return false;
	}
	const ageMs = now.getTime() - updatedAt.getTime();
	return ageMs > STORY_STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
}

export function isPrReviewStale(params: {
	state: "open" | "closed" | "merged";
	updatedAt: Date;
	now?: Date;
}): boolean {
	const { state, updatedAt } = params;
	const now = params.now ?? new Date();
	if (state !== "open") {
		return false;
	}
	const ageMs = now.getTime() - updatedAt.getTime();
	return ageMs > PR_REVIEW_STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Priority order for sorting the final output.
 * Security findings surface first, followed by blockers and proposed
 * architecture decisions.
 */
const KIND_SORT_ORDER: Record<PriorityActionKind, number> = {
	security_findings: 0,
	blocker: 1,
	decisions_proposed: 2,
	story_stale: 3,
	due_date_risk: 4,
	missing_ownership: 5,
	pr_review_stale: 6,
	unresolved_dependency: 7,
};

/**
 * Matches a ProjectStoryStatus name that represents a "blocked" column.
 * Projects use custom statuses — there is no canonical enum value — so we
 * detect semantically by name. Case-insensitive.
 */
const BLOCKED_STATUS_NAME_RE = /blocked/i;

/**
 * Matches a ProjectStoryStatus name that represents an "in progress"
 * column. Tolerates "In Progress", "in-progress", "inprogress".
 */
const IN_PROGRESS_STATUS_NAME_RE = /in.?progress/i;

// =============================================================================
// Link helpers
// =============================================================================

/**
 * Build a relative Fabric link to a story workspace page.
 *
 * The app has two mount points for project routes:
 *   - personal:     /app/projects/{projectId}/stories/{storyId}
 *   - organization: /app/{orgSlug}/projects/{projectId}/stories/{storyId}
 *
 * This activity only receives `organizationId` (not the slug), and the
 * daily-brief render layer is the right place to rewrite relative paths
 * for the current tenant context. We therefore emit the personal-style
 * path — consumers prefix the org slug when appropriate.
 */
function buildStoryLink(params: {
	projectId: string;
	storyCuid: string;
}): string {
	return `/app/projects/${params.projectId}/stories/${params.storyCuid}`;
}

// =============================================================================
// Activity
// =============================================================================

/**
 * Detect priority actions for a single project.
 *
 * Returns one `PriorityAction` per (targetCuid, kind) pair — a single
 * story can appear twice if it matches two kinds (e.g. blocked AND
 * missing ownership). `whyItMatters` is always empty on the objects this
 * activity emits; the LLM summarizer fills it in downstream.
 */
export async function detectPriorityActionsActivity(
	input: DetectPriorityActionsInput,
): Promise<DetectPriorityActionsOutput> {
	const { projectId, organizationId } = input;

	heartbeat("detectPriorityActionsActivity: starting");

	logger.info("[DailyBrief/detectPriorityActions] Starting", {
		projectId,
		organizationId,
	});

	// ---------------------------------------------------------------------------
	// Resolve the project's status taxonomy. Stories use a custom per-project
	// ProjectStoryStatus table (no canonical "blocked" enum), so we pre-compute
	// which statusIds mean "blocked" and which mean "in progress" by name.
	// ---------------------------------------------------------------------------
	const projectStatuses = await db.projectStoryStatus.findMany({
		where: {
			projectId,
			project: { organizationId },
		},
		select: { id: true, name: true },
	});

	const blockedStatusIds = projectStatuses
		.filter((s) => BLOCKED_STATUS_NAME_RE.test(s.name))
		.map((s) => s.id);

	const inProgressStatusIds = projectStatuses
		.filter((s) => IN_PROGRESS_STATUS_NAME_RE.test(s.name))
		.map((s) => s.id);

	// ---------------------------------------------------------------------------
	// Rule 1 — security_findings
	// If the project has a completed scan with OPEN HIGH/CRITICAL security
	// findings, surface a single priority action pointing at the Security tab.
	// Severity gating keeps low-signal findings from outranking true blockers.
	// ---------------------------------------------------------------------------
	const securityFindingActions: Array<PriorityAction & { _updatedAt: Date }> =
		[];

	const latestCompletedScan = await getLatestProjectScan(projectId, {
		status: "COMPLETED",
	});
	if (latestCompletedScan) {
		const count = await db.scanFinding.count({
			where: {
				scanId: latestCompletedScan.id,
				projectId,
				project: { organizationId },
				category: "SECURITY",
				status: "OPEN",
				severity: { in: ["CRITICAL", "HIGH"] },
			},
		});

		if (count > 0) {
			securityFindingActions.push({
				kind: "security_findings",
				title: `${count} high-severity security finding${count === 1 ? "" : "s"} need attention`,
				whyItMatters: "",
				targetCuid: latestCompletedScan.id,
				targetIdentifier: "Security",
				targetType: "scan",
				fabricLink: `/app/projects/${projectId}/security`,
				_updatedAt:
					latestCompletedScan.completedAt ??
					latestCompletedScan.createdAt,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Rule 2 — decisions_proposed
	// If the project has PROPOSED architecture decisions (awaiting team review),
	// surface a single priority action linking to the Decisions tab so the team
	// is reminded to accept, reject, or refine them.
	// ---------------------------------------------------------------------------
	const decisionsProposedActions: Array<
		PriorityAction & { _updatedAt: Date }
	> = [];

	const proposedResult = await listArchitectureDecisions({
		projectId,
		status: "PROPOSED",
		limit: 50,
	});
	if (proposedResult.total > 0) {
		const count = proposedResult.total;
		// Use the most-recently-updated proposed decision as the representative cuid.
		const representative = proposedResult.items[0];
		decisionsProposedActions.push({
			kind: "decisions_proposed",
			title: `${count} architecture decision${count === 1 ? "" : "s"} awaiting review`,
			whyItMatters: "",
			targetCuid: representative?.id ?? projectId,
			targetIdentifier: "Decisions",
			targetType: "architecture_decision",
			fabricLink: `/app/projects/${projectId}/decisions`,
			_updatedAt: representative?.updatedAt ?? new Date(),
		});
	}

	// ---------------------------------------------------------------------------
	// Rule 3 — blocker
	// Stories sitting in a "blocked"-named status column.
	// ---------------------------------------------------------------------------
	const blockerActions: Array<PriorityAction & { _updatedAt: Date }> = [];

	if (blockedStatusIds.length > 0) {
		const blockedStories = await db.userStory.findMany({
			where: {
				projectId,
				project: { organizationId },
				statusId: { in: blockedStatusIds },
			},
			select: {
				id: true,
				identifier: true,
				title: true,
				assigneeId: true,
				createdAt: true,
				lastEditedAt: true,
			},
			orderBy: [
				{ lastEditedAt: { sort: "desc", nulls: "last" } },
				{ createdAt: "desc" },
			],
		});

		for (const s of blockedStories) {
			blockerActions.push({
				kind: "blocker",
				title: s.title,
				whyItMatters: "",
				targetCuid: s.id,
				targetIdentifier: s.identifier,
				targetType: "story",
				fabricLink: buildStoryLink({ projectId, storyCuid: s.id }),
				...(s.assigneeId ? { assigneeUserId: s.assigneeId } : {}),
				_updatedAt: s.lastEditedAt ?? s.createdAt,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Rule 3 — due_date_risk
	//
	// TODO(daily-brief): StoryTask has no `dueDate` column in the current
	// schema (and no equivalent field on UserStory). Implementing this rule
	// requires a schema migration to add a due-date field — out of scope
	// for Task 4. Emitting `[]` so the rest of the pipeline can proceed.
	// ---------------------------------------------------------------------------
	const dueDateRiskActions: Array<PriorityAction & { _updatedAt: Date }> = [];

	// ---------------------------------------------------------------------------
	// Rule 4 — missing_ownership
	// Unassigned stories currently sitting in an "in progress"-named column.
	// ---------------------------------------------------------------------------
	const missingOwnershipActions: Array<
		PriorityAction & { _updatedAt: Date }
	> = [];

	if (inProgressStatusIds.length > 0) {
		const unownedInProgressStories = await db.userStory.findMany({
			where: {
				projectId,
				project: { organizationId },
				statusId: { in: inProgressStatusIds },
				assigneeId: null,
			},
			select: {
				id: true,
				identifier: true,
				title: true,
				createdAt: true,
				lastEditedAt: true,
			},
			orderBy: [
				{ lastEditedAt: { sort: "desc", nulls: "last" } },
				{ createdAt: "desc" },
			],
		});

		for (const s of unownedInProgressStories) {
			missingOwnershipActions.push({
				kind: "missing_ownership",
				title: s.title,
				whyItMatters: "",
				targetCuid: s.id,
				targetIdentifier: s.identifier,
				targetType: "story",
				fabricLink: buildStoryLink({ projectId, storyCuid: s.id }),
				_updatedAt: s.lastEditedAt ?? s.createdAt,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Rule 5 — story_stale
	// Stories in any "active" status (In Progress / In Review / Ready) whose
	// last genuine edit (or creation when never edited) is older than the threshold.
	// ---------------------------------------------------------------------------
	const staleStoryActions: Array<PriorityAction & { _updatedAt: Date }> = [];
	const activeStatusIds = projectStatuses
		.filter((s) => ACTIVE_STATUS_NAME_RE.test(s.name))
		.map((s) => s.id);
	if (activeStatusIds.length > 0) {
		const threshold = new Date();
		threshold.setDate(threshold.getDate() - STORY_STALE_THRESHOLD_DAYS);
		// Cap to keep the panel useful on old projects, oldest offenders first.
		//
		// A compound `lastEditedAt asc nulls first, createdAt asc` would NOT
		// give that order: it ranks every never-edited story ahead of every
		// edited one, so a story created just past the threshold would outrank
		// one genuinely untouched for years and the cap would drop the real
		// offenders — the rows this rule exists to surface. Read each partition
		// on the key that decides its own rows' position instead, then merge.
		const staleScope = {
			projectId,
			project: { organizationId },
			statusId: { in: activeStatusIds },
		};
		const staleSelect = {
			id: true,
			identifier: true,
			title: true,
			assigneeId: true,
			createdAt: true,
			lastEditedAt: true,
		} as const;
		const [editedStale, neverEditedStale] = await Promise.all([
			db.userStory.findMany({
				where: { ...staleScope, lastEditedAt: { lt: threshold } },
				select: staleSelect,
				orderBy: { lastEditedAt: "asc" },
				take: STALE_STORY_CAP,
			}),
			db.userStory.findMany({
				where: {
					...staleScope,
					lastEditedAt: null,
					createdAt: { lt: threshold },
				},
				select: staleSelect,
				orderBy: { createdAt: "asc" },
				take: STALE_STORY_CAP,
			}),
		]);
		const stale = [...editedStale, ...neverEditedStale]
			.sort(
				(a, b) =>
					(a.lastEditedAt ?? a.createdAt).getTime() -
					(b.lastEditedAt ?? b.createdAt).getTime(),
			)
			.slice(0, STALE_STORY_CAP);
		for (const s of stale) {
			staleStoryActions.push({
				kind: "story_stale",
				title: s.title,
				whyItMatters: "",
				targetCuid: s.id,
				targetIdentifier: s.identifier,
				targetType: "story",
				fabricLink: buildStoryLink({ projectId, storyCuid: s.id }),
				...(s.assigneeId ? { assigneeUserId: s.assigneeId } : {}),
				_updatedAt: s.lastEditedAt ?? s.createdAt,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Rule 6 — unresolved_dependency
	//
	// TODO(daily-brief): No dependency / blockedBy / dependsOn / parentTaskId
	// relation exists between UserStory or StoryTask rows in the current
	// schema (checked schema.prisma and prisma/queries/projects/stories.ts).
	// StorySubtask is a 1:N child of StoryTask, not a dependency link.
	// Implementing this rule requires a new link-table migration — out of
	// scope for Task 4. Emitting `[]` for now.
	// ---------------------------------------------------------------------------
	const unresolvedDependencyActions: Array<
		PriorityAction & { _updatedAt: Date }
	> = [];

	// ---------------------------------------------------------------------------
	// Assemble + sort: kind priority first, then most recently updated within
	// each kind. Dedupe is inherent — each rule populates its own list and we
	// emit one PriorityAction per (targetCuid, kind) pair. A story matching
	// two kinds legitimately appears twice under different `kind` values.
	// ---------------------------------------------------------------------------
	const combined = [
		...securityFindingActions,
		...decisionsProposedActions,
		...blockerActions,
		...staleStoryActions,
		...dueDateRiskActions,
		...missingOwnershipActions,
		...unresolvedDependencyActions,
	];

	combined.sort((a, b) => {
		const kindDelta = KIND_SORT_ORDER[a.kind] - KIND_SORT_ORDER[b.kind];
		if (kindDelta !== 0) {
			return kindDelta;
		}
		return b._updatedAt.getTime() - a._updatedAt.getTime();
	});

	const actions: PriorityAction[] = combined.map(
		({ _updatedAt: _omit, ...action }) => action,
	);

	logger.info("[DailyBrief/detectPriorityActions] Complete", {
		projectId,
		total: actions.length,
		security_findings: securityFindingActions.length,
		decisions_proposed: decisionsProposedActions.length,
		blocker: blockerActions.length,
		story_stale: staleStoryActions.length,
		due_date_risk: dueDateRiskActions.length,
		missing_ownership: missingOwnershipActions.length,
		unresolved_dependency: unresolvedDependencyActions.length,
	});

	return actions;
}

/**
 * Sort a merged PriorityAction[] by kind priority. Exported so the workflow
 * can apply the same ordering to actions from multiple sources
 * (detectPriorityActionsActivity output + stale-PR actions from the GitHub
 * collector) without duplicating KIND_SORT_ORDER.
 *
 * Note: the workflow (daily-brief-generation-workflow.ts) runs in a Temporal
 * sandbox that cannot import runtime values from activity modules. It maintains
 * a local KIND_ORDER copy. If you update KIND_SORT_ORDER here you must also
 * update that copy. Tests for sortPriorityActions act as the canonical
 * ordering contract for both.
 *
 * Stable: Array.prototype.sort preserves input order within a kind.
 */
export function sortPriorityActions(
	actions: PriorityAction[],
): PriorityAction[] {
	return [...actions].sort(
		(a, b) => KIND_SORT_ORDER[a.kind] - KIND_SORT_ORDER[b.kind],
	);
}
