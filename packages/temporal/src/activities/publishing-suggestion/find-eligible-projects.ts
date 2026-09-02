/**
 * Publishing Suggestion — eligible-project sweep (Publishing Suite 1A, Task 10;
 * cadence gate added Phase 1C-1 Task 5; per-organization scoping added by the
 * org-scoped-flags slice, Task 8 + fix round 1). Also exports
 * `isPublishingSuiteEnabledForOrganizationUncached` (fix round 2, §E; its
 * org-level read reshaped to a single-row lookup in the Copilot-review
 * follow-up) — the SAME uncached global reader this sweep uses
 * (`resolvePublishingSuiteGlobalUncached`), plus a direct single-row
 * org-override read, so `dispatch-suggestion.ts`'s per-project F3 re-check
 * can never see a staler answer than this sweep did.
 *
 * The daily dispatcher's find step. Runs in a server activity (NOT the workflow)
 * so it can read the flag, the organization override rows, and "now" without
 * breaking workflow determinism (N6). Globally enabled sweeps every
 * organization EXCEPT one with an explicit `enabled: false` override — the
 * per-organization kill switch, honoured here because this is the one path
 * where ignoring it spends model-inference cost. Globally disabled restricts
 * the sweep to organizations with an enabled override instead. Either way, a
 * personal project (`organizationId: null`) is NEVER swept: per ADR-018 ("An
 * organization is the only tenant context",
 * docs/adr/018-organization-is-the-only-tenant-context.md) a project with no
 * organization has nothing here to resolve a flag against, and is excluded
 * unconditionally rather than falling through to the global answer — see the
 * `where`-clause comment below for why that exclusion cannot be left to
 * `notIn`'s NULL handling. The globally-disabled branch also returns before
 * the project table is ever touched when the enabled-organization set is
 * empty: an empty result reached by scanning the whole table would spend
 * exactly the cost this gate exists to avoid. The schedule itself is still
 * registered unconditionally; flipping either level of the flag takes effect
 * on the next tick with no redeploy.
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
	getDisabledOrganizationIds,
	getEnabledOrganizationIds,
	getGlobalFlagOverride,
	getLastCountedPublishingRuns,
	getOrganizationFlagOverrideUncached,
	isPublishingCycleDue,
} from "@repo/database";
import { resolveFlag } from "@repo/utils/feature-flag-registry";
import { heartbeat } from "@temporalio/activity";

const FLAG_KEY = "PUBLISHING_SUITE";

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

/**
 * The GLOBAL half of PUBLISHING_SUITE's resolution, read UNCACHED — shared by
 * `findEligibleProjects` and `isPublishingSuiteEnabledForOrganizationUncached`
 * below so the two can never see a different answer to the same question.
 *
 * `getGlobalFlagOverride` (an UNCACHED direct read) plus the same env/registry
 * fallback `isFeatureEnabled` applies — deliberately NOT `isFeatureEnabled`
 * itself, whose global read goes through `getFlagOverrides`'s 10-second TTL
 * cache. That cache is correct for hot request paths; it is wrong for the
 * two once-a-project, credit-spending decisions this file makes: a worker
 * holding a stale cached `true` after an admin globally disables the flag
 * would, for up to 10 seconds, act on the old value instead.
 */
async function resolvePublishingSuiteGlobalUncached(): Promise<boolean> {
	const globalOverride = await getGlobalFlagOverride(FLAG_KEY);
	return resolveFlag(FLAG_KEY, { global: globalOverride }, process.env)
		.enabled;
}

/**
 * Uncached, per-organization resolution of PUBLISHING_SUITE for ONE already-
 * known project's tenant — org override > global override > env var >
 * registry default. The global half still goes through
 * `resolvePublishingSuiteGlobalUncached`, the SAME reader `findEligibleProjects`
 * uses for its sweep; the org half reads the single override row for this
 * key and this organization directly (`getOrganizationFlagOverrideUncached`,
 * a `findUnique` on the table's `(key, organizationId)` primary key) rather
 * than reusing the sweep's list readers. The set-membership OUTCOME still
 * can never disagree with the sweep: a present row decides the question on
 * its own regardless of the global value, and an absent row falls through to
 * the same global answer the sweep would apply for that organization — only
 * the shape of the read differs, because a single project asks a one-row
 * question instead of "which organizations are opted in/out".
 *
 * The one caller today is `runPublishingSuggestionDispatch`'s F3 re-check
 * (Codex fix round 2, §E): a per-project gate immediately before that project
 * triggers an LLM generation must not be able to return a stale answer, which
 * ruled out `isFeatureEnabled` (10-second TTL cache) — the exact gap the
 * dispatcher's re-check exists to close.
 *
 * Per ADR-018 ("An organization is the only tenant context") a project with
 * no organization (`organizationId: null`) is refused outright — `false`,
 * with no flag read at all — mirroring how `findEligibleProjects` now
 * excludes personal projects from the sweep unconditionally. This function
 * used to resolve a null organization on the global value alone; that
 * fall-through was the pre-ADR-018 routing this dispatch-time re-check must
 * no longer reproduce. Do NOT restore it — a project that resolves to no
 * organization here is a bug in whatever failed to resolve one upstream, not
 * a personal context to fall back into.
 *
 * `getOrganizationFlagOverrideUncached` answers the direct question — is
 * there an override row for THIS key and THIS organization, and what does it
 * say — with a single indexed lookup. The previous shape called
 * `getEnabledOrganizationIds` / `getDisabledOrganizationIds`, each of which
 * fetches EVERY organization with an override for the key and then runs a
 * linear `.includes()` scan over that list to answer a one-row question:
 * that was one round trip, but not one unit of work, and the work grows with
 * the number of overridden organizations on every dispatched project,
 * immediately before that project triggers an LLM generation.
 */
export async function isPublishingSuiteEnabledForOrganizationUncached(
	organizationId: string | null,
): Promise<boolean> {
	if (organizationId === null) {
		return false;
	}
	const orgOverride = await getOrganizationFlagOverrideUncached(
		FLAG_KEY,
		organizationId,
	);
	if (orgOverride !== undefined) {
		return orgOverride;
	}
	return resolvePublishingSuiteGlobalUncached();
}

export async function findEligibleProjects(): Promise<FindEligibleProjectsOutput> {
	heartbeat("findEligibleProjects");

	// Resolve WHO this sweep may touch, once, before any paging. Read here in
	// the activity, never in workflow code (determinism).
	//
	// Globally enabled (dev/staging) means no organization ALLOW-list — but an
	// organization can still opt OUT of a globally-enabled feature via an
	// explicit `enabled: false` override row, and this is the one path where
	// not honouring that opt-out spends money, so it is enforced here as a
	// DENY-list instead. Globally disabled restricts the sweep to
	// organizations with an enabled override. Personal projects are excluded
	// in EITHER state — under ADR-018 they have no organization to enable and
	// must never be swept, not merely "have no override to carry" (see the
	// `where`-clause comment below).
	//
	// See `resolvePublishingSuiteGlobalUncached` above for why the global half
	// is read uncached rather than through `isFeatureEnabled`.
	const globallyEnabled = await resolvePublishingSuiteGlobalUncached();
	let organizationIds: string[] | null = null;
	let disabledOrganizationIds: string[] = [];
	if (!globallyEnabled) {
		organizationIds = await getEnabledOrganizationIds(FLAG_KEY);
		// Nothing enabled anywhere: return before touching the project table.
		// An empty result reached by scanning every project would cost exactly
		// what this gate exists to avoid.
		if (organizationIds.length === 0) {
			return { projects: [] };
		}
	} else {
		disabledOrganizationIds = await getDisabledOrganizationIds(FLAG_KEY);
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
			where: {
				status: "ACTIVE",
				deletedAt: null,
				...(organizationIds
					? { organizationId: { in: organizationIds } }
					: {
							// Globally enabled: sweep every organization except one with
							// an explicit `enabled: false` override — AND, per ADR-018
							// ("An organization is the only tenant context"), never a
							// project with no organization at all. That exclusion is
							// unconditional and explicit (`not: null`), not a side effect
							// of `notIn`'s three-valued NULL handling: SQL's `NOT IN` is
							// NULL — neither true nor false — for a NULL column value, so
							// a bare `organizationId: { notIn: disabledOrganizationIds }`
							// only happens to drop `organizationId: null` rows when the
							// list is non-empty. When nothing is explicitly disabled
							// (`disabledOrganizationIds` is `[]`), `notIn: []` matches
							// every row including nulls, and the old code took a `{}`
							// branch here with no exclusion at all — silently sweeping
							// personal projects on the common "nothing disabled" tick.
							// `not: null` below removes that dependency entirely: personal
							// projects are excluded whether or not anything is disabled.
							organizationId: {
								not: null,
								...(disabledOrganizationIds.length > 0
									? { notIn: disabledOrganizationIds }
									: {}),
							},
						}),
			},
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
