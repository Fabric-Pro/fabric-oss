/**
 * Build the story-details route for a given backlog story.
 *
 * Returns a relative path so callers that pass it to
 * `window.open(url, '_blank', ...)` or `router.push(url)` automatically
 * resolve against the current document origin — i.e., production
 * deploys inherit the production domain without any per-environment
 * configuration. See spec
 * `2026-05-25-backlog-context-menu-open-in-new-tab` §7.2.
 *
 * The helper itself does NOT URL-encode `projectId` / `storyId` and
 * does NOT return `null`. The FR-13 silent-no-op behavior for missing
 * inputs is implemented at the call site (e.g.,
 * `if (!projectId || !storyId) return;` before invocation).
 *
 * Examples:
 *   buildStoryDetailsRoute("/app/acme", "proj_1", "story_2")
 *     -> "/app/acme/projects/proj_1/stories/story_2"
 *   buildStoryDetailsRoute("/app", "proj_1", "story_2")
 *     -> "/app/projects/proj_1/stories/story_2"
 *
 * @param basePath  The org-or-personal route base (e.g., "/app/acme" or "/app").
 * @param projectId Project ID.
 * @param storyId   UserStory ID.
 * @returns The relative path string.
 */
export function buildStoryDetailsRoute(
	basePath: string,
	projectId: string,
	storyId: string,
): string {
	return `${basePath}/projects/${projectId}/stories/${storyId}`;
}

/**
 * Build the project "Settings" tab route — the destination for the
 * PM-credentials / "Check Configuration" CTAs shown when a PM tool is
 * missing, expired, or otherwise unavailable.
 *
 * The settings tab lives on the project DETAIL route as a `?tab=settings`
 * query param. It does NOT exist on project subroutes (`/kanban`,
 * `/roadmap`, `/documents/:id`, `/stories/:id`, …). Building this href from
 * the current `usePathname()` therefore breaks whenever the CTA is rendered
 * from a subroute — e.g. it produced `/projects/:id/kanban?tab=settings`,
 * which never opens PM settings. Always build it from the context base
 * (`/app` or `/app/{slug}`) + projectId so it is correct regardless of the
 * route the CTA happens to render on.
 *
 * Examples:
 *   buildProjectSettingsRoute("/app/acme", "proj_1")
 *     -> "/app/acme/projects/proj_1?tab=settings"
 *   buildProjectSettingsRoute("/app", "proj_1")
 *     -> "/app/projects/proj_1?tab=settings"
 *
 * @param basePath  The org-or-personal route base (e.g., "/app/acme" or "/app").
 * @param projectId Project ID.
 * @returns The relative path string.
 */
export function buildProjectSettingsRoute(
	basePath: string,
	projectId: string,
): string {
	return `${basePath}/projects/${projectId}?tab=settings`;
}

/**
 * Query param addressing the sync log, which lives inside the roadmap's
 * change-history modal and so has no route of its own. Consumed once by
 * `useSyncLogDeepLink` in the roadmap, which then strips it.
 */
export const SYNC_LOG_PARAM = "history";
export const SYNC_LOG_PARAM_VALUE = "sync";

/**
 * Build the route that opens the roadmap change-history modal on its Sync
 * History tab — the destination for the Project Management settings link and
 * the Review Center's "View all in Sync History" footer.
 *
 * Built from the context base rather than `usePathname()` for the same reason
 * as `buildProjectSettingsRoute`: the roadmap tab only exists on the project
 * DETAIL route, so a href derived from a subroute would never open it.
 *
 * Examples:
 *   buildProjectSyncLogRoute("/app/acme", "proj_1")
 *     -> "/app/acme/projects/proj_1?tab=stories&history=sync"
 */
export function buildProjectSyncLogRoute(
	basePath: string,
	projectId: string,
): string {
	return `${basePath}/projects/${projectId}?tab=stories&${SYNC_LOG_PARAM}=${SYNC_LOG_PARAM_VALUE}`;
}

/**
 * Query param selecting a tab inside the feature workspace. The workspace's
 * maturation tabs are client state with no route of their own, so a link that
 * wants to land on a specific one has to say so out of band. Consumed once on
 * mount by the workspace, which then strips it — otherwise a refresh or a
 * back-navigation would keep forcing the tab and the user could never leave it.
 */
export const STORY_TAB_PARAM = "storyTab";
const STORY_TAB_DECISION_LOG = "decisionLog";

/**
 * Build the route that opens a feature on its Decision Log.
 *
 * The roadmap's Priority layout links here from the open-questions it shows on
 * a row: the row lists the questions, and this is where they get answered.
 *
 * Degrades on purpose. The Decision Log tab only exists under Maturation V2, so
 * when that is off the param finds no tab and the user simply lands on the
 * feature — a slightly less specific destination, never a broken one.
 *
 * Examples:
 *   buildStoryDecisionLogRoute("/app/acme", "proj_1", "story_2")
 *     -> "/app/acme/projects/proj_1/stories/story_2?storyTab=decisionLog"
 */
export function buildStoryDecisionLogRoute(
	basePath: string,
	projectId: string,
	storyId: string,
): string {
	return `${buildStoryDetailsRoute(basePath, projectId, storyId)}?${STORY_TAB_PARAM}=${STORY_TAB_DECISION_LOG}`;
}

const STORY_TAB_QA = "qa";

/**
 * Build the route that opens a feature on its QA tab — the case→criterion
 * direction of the traceability matrix. Used by the Test
 * Cases surface's work-item links, which otherwise land a QA reader on the
 * default tab and leave them hunting for the criterion by hand.
 *
 * Degrades on purpose, like the Decision Log route: the QA tab only exists
 * under Maturation V2 with the Test Cases flag on and only for features, so
 * when any of that is off the param finds no tab and the user simply lands on
 * the feature.
 */
export function buildStoryQaRoute(
	basePath: string,
	projectId: string,
	storyId: string,
): string {
	return `${buildStoryDetailsRoute(basePath, projectId, storyId)}?${STORY_TAB_PARAM}=${STORY_TAB_QA}`;
}

/**
 * Query param addressing a backlog proposal. Proposals live in a drawer on the
 * Roadmap with no route of their own, so this is how a link elsewhere in the
 * app points at one — the roadmap opens the drawer and selects it.
 *
 * Consumed once and stripped, like the sync-log param: left in place it would
 * re-open the drawer on every render and the user could never close it.
 */
export const PROPOSAL_PARAM = "proposal";

/**
 * Build the route that opens a specific backlog proposal.
 *
 * Used by the roadmap's Priority layout to link a work item back to the
 * proposal that created it. Works for proposals in any state: the drawer's
 * detail view fetches by id rather than reading the review queue, so an
 * already-applied proposal — the usual case for a link like this — still opens.
 *
 * Examples:
 *   buildProjectProposalRoute("/app/acme", "proj_1", "prop_2")
 *     -> "/app/acme/projects/proj_1?tab=stories&proposal=prop_2"
 */
export function buildProjectProposalRoute(
	basePath: string,
	projectId: string,
	proposalId: string,
): string {
	return `${basePath}/projects/${projectId}?tab=stories&${PROPOSAL_PARAM}=${encodeURIComponent(proposalId)}`;
}
