/**
 * Publishing Suggestion — eligible-project sweep (Publishing Suite 1A, Task 10;
 * cadence gate added Phase 1C-1 Task 5).
 *
 * The daily dispatcher's find step. Runs in a server activity (NOT the workflow)
 * so it can read the master flag and "now" without breaking workflow
 * determinism (N6). Flag-gated: with `FABRIC_FEATURE_PUBLISHING_SUITE` off it
 * returns an empty due-list, so the schedule can be registered unconditionally
 * and flipping the flag on takes effect on the next tick with no redeploy.
 *
 * Cadence: the Temporal schedule itself still fires daily (system schedules are
 * registered create-only in this repo, so editing the cron would not update an
 * already-registered schedule) — cadence is therefore an elapsed-interval filter
 * applied here, on top of the daily tick, via `isPublishingCycleDue` against
 * each project's `PublishingSuiteSettings.cadence` (falling back to
 * `DEFAULT_PUBLISHING_CADENCE` — currently `MANUAL` — when no settings row
 * exists, so a project never enabled through the settings surface is not swept)
 * and its last counted run from `getLastCountedPublishingRuns`. The fallback
 * tracks the shared constant rather than a literal so the two can never drift
 * apart again. A MANUAL cadence never needs a cycle read — it is decided
 * before that batched query is even issued.
 *
 * Returns **minimal identifiers only** (`{ projectId }`) — never tenant/owner
 * fields (H4). `dispatchPublishingSuggestion` re-reads the project fresh and
 * XOR-normalizes the tenant tuple at point of use, because a project can be
 * deleted, transferred, or org-changed between this sweep and the dispatch.
 */

import {
	DEFAULT_PUBLISHING_CADENCE,
	db,
	getLastCountedPublishingRuns,
	isPublishingCycleDue,
} from "@repo/database";
import { isPublishingSuiteEnabled } from "@repo/utils/feature-flag";
import { heartbeat } from "@temporalio/activity";

export interface EligibleProject {
	projectId: string;
}

export interface FindEligibleProjectsOutput {
	projects: EligibleProject[];
}

// Bounded, cursor-paginated so a large workspace never loads the whole project
// table into one query nor into workflow history in a single unbounded page.
const PAGE_SIZE = 500;
const MAX_PROJECTS = 20_000;

export async function findEligibleProjects(): Promise<FindEligibleProjectsOutput> {
	heartbeat("findEligibleProjects");
	// Gate the sweep here (server context) so the flag is never read in workflow
	// code. Off ⇒ no cycle is ever created and no LLM cost is incurred.
	if (!isPublishingSuiteEnabled()) {
		return { projects: [] };
	}

	// Time is read HERE (server activity), never in the dispatcher workflow (N6).
	const now = new Date();
	const projects: EligibleProject[] = [];
	// `projects` only accumulates DUE projects (below), not every scanned row —
	// so it can NOT double as a "how much work has this sweep done" counter the
	// way it used to. In the steady state most projects are not due on any
	// given tick, so `projects.length` alone would almost never reach
	// MAX_PROJECTS, and the loop would page through the ENTIRE project table
	// every single day. `scanned` tracks rows actually read from the db and is
	// the bound that limits per-sweep work; `projects.length` separately still
	// bounds the output size. BOTH checks are required — collapsing this back
	// to a single `projects.length < MAX_PROJECTS` looks like a harmless
	// simplification but reintroduces the unbounded-scan regression.
	let scanned = 0;
	let cursor: string | undefined;
	while (scanned < MAX_PROJECTS && projects.length < MAX_PROJECTS) {
		const rows = await db.project.findMany({
			where: { status: "ACTIVE", deletedAt: null },
			select: { id: true },
			orderBy: { id: "asc" },
			take: PAGE_SIZE,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		});
		if (rows.length === 0) {
			break;
		}
		// Every page counts toward the scan bound, including the final short page.
		scanned += rows.length;
		// Report progress once per page — Fix 1 makes this loop page through the
		// whole table on a quiet day, and an activity that stops heartbeating
		// past its timeout is killed.
		heartbeat("findEligibleProjects");

		const pageIds = rows.map((r) => r.id);
		const settingsRows = await db.publishingSuiteSettings.findMany({
			where: { projectId: { in: pageIds } },
			select: { projectId: true, cadence: true },
		});
		const cadenceByProject = new Map(
			settingsRows.map((s) => [s.projectId, s.cadence]),
		);

		// MANUAL never runs on the sweep, so it needs no cycle read. Asking only
		// for the rest keeps the batched query proportional to what can actually
		// become due.
		const scheduledIds = pageIds.filter(
			(id) =>
				(cadenceByProject.get(id) ?? DEFAULT_PUBLISHING_CADENCE) !==
				"MANUAL",
		);
		// Tenant scoping, "counts as a run", and one-row-per-project all live in
		// this helper — see its doc comment. A project ABSENT from the map has
		// never had a counted run under its CURRENT tenant, which is due.
		const lastRunByProject =
			scheduledIds.length > 0
				? await getLastCountedPublishingRuns(scheduledIds)
				: new Map<string, Date>();

		for (const id of scheduledIds) {
			const cadence =
				cadenceByProject.get(id) ?? DEFAULT_PUBLISHING_CADENCE;
			const lastStartedAt = lastRunByProject.get(id) ?? null;
			if (isPublishingCycleDue({ cadence }, lastStartedAt, now)) {
				projects.push({ projectId: id });
			}
		}

		if (rows.length < PAGE_SIZE) {
			break;
		}
		cursor = rows[rows.length - 1].id;
	}
	return { projects };
}
