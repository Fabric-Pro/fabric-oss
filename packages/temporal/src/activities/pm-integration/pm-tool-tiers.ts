/**
 * PM Tool Tier Model — single source of truth (Task 0 capability-probe spike).
 *
 * Classifies each supported PM tool into one of three tiers based on whether it
 * exposes a single-item fetch (`taskGet`), which determines whether a push-time
 * conflict guard and pull-side state poll are possible:
 *
 * | Tier | Definition                                                        |
 * |------|-------------------------------------------------------------------|
 * | T1   | Full bidirectional flow: push + push-time conflict guard + poll.  |
 * | T2   | Happy-path: push + push-time conflict guard + on-demand pull.     |
 * | T3   | Push-only, no conflict guard (no `taskGet`).                       |
 *
 * The push-time conflict guard short-circuits to "no conflict" for adapters
 * without `taskGet` (`preview-pm-sync-conflict.ts:102` returns
 * `{ hasConflict: false }`), so the Review Center "Resolve" action is only ever
 * populated for T1/T2 tools — T3 conflicts cannot exist by construction.
 *
 * ## How tier membership was determined (capability-probe spike)
 *
 * `taskGet` membership is decided by whether a tool's MCP tool list exposes a
 * single-item fetch tool that matches `TASK_GET_PATTERNS` in
 * `tool-analyzer.ts:381` (the same patterns `detectTaskGetCapability`
 * (`tool-analyzer.ts:996`) runs at discovery time to populate the `taskGet`
 * field on the analyzed capability set (`tool-analyzer.ts:203`, `:542`)).
 *
 * Evidence per tool (canonical detected-type strings from
 * `PM_TYPE_PATTERNS`, `tool-analyzer.ts:495`):
 *
 * - **azure-devops** — `wit_get_work_item` matches `/get_work_item$/i`; the ADO
 *   poll explicitly fans out per-item `taskGet` calls
 *   (`pm-state-poll.ts:112`). Has `taskGet`. Fixed **T1** (the only full
 *   bidirectional tool for now — per decision).
 * - **fizzy** — `get_card` matches `/get_card$/i`
 *   (fixtures: `fetch-pm-ticket.test.ts:14`, `hierarchy-sync.test.ts:148`).
 *   Has `taskGet` → **T2**.
 * - **jira** — `getJiraIssue` matches `/getJiraIssue$/i` (Atlassian Rovo MCP;
 *   `hierarchy-sync.test.ts:546`). Has `taskGet` → **T2**.
 * - **gitlab** — the GitLab MCP shim exposes generic `get_issue`
 *   (`tool-analyzer.ts:533`) matching `/get_issue$/i`, and the REST fallback
 *   fetches single issues (`gitlab-rest-story-sync.ts`). Has `taskGet`, but is
 *   **explicitly NOT T1** (owned by another dev, kept minimal) → **T2**.
 * - **linear** — `getIssue` matches `/getIssue$/i` (camelCase Linear MCP). Has
 *   `taskGet` → **T2**.
 * - **clickup** — `get_task` matches `/get_task$/i`. Has `taskGet` → **T2**.
 * - **trello** — `get_card` matches `/get_card$/i` (Trello uses cards). Has
 *   `taskGet` → **T2**.
 *
 * **Concrete tier lists:**
 * - **T1:** `azure-devops`.
 * - **T2 (has `taskGet`):** `fizzy`, `jira`, `gitlab`, `linear`, `clickup`,
 *   `trello`.
 * - **T3 (no `taskGet`):** none among the spec's supported tool set — every
 *   tool Fabric supports today exposes a single-item fetch.
 *
 * **Out of scope for this spike (UNVERIFIED — no MCP fixture / static
 * declaration in-repo):** `github`, `asana`, `monday`, `notion` appear in
 * `PM_TYPE_PATTERNS` and prose comments but have no representative tool-name
 * evidence in the repo to ground a tier. They are deliberately omitted rather
 * than guessed; extend this map once a real adapter fixture exists. A consumer
 * looking up an unknown / unverified tool gets `undefined` and should treat it
 * conservatively (no conflict guard) until classified.
 */

export type PmToolTier = "T1" | "T2" | "T3";

/**
 * Maps each supported PM tool's canonical detected-type string (as produced by
 * `analyzePMToolCapabilities().detectedType`, `tool-analyzer.ts:534`) to its
 * tier. Keys are the exact `PM_TYPE_PATTERNS` type strings so downstream
 * callers can look up `capabilities.detectedType` directly.
 */
export const PM_TOOL_TIERS = {
	"azure-devops": "T1",
	fizzy: "T2",
	jira: "T2",
	gitlab: "T2",
	linear: "T2",
	clickup: "T2",
	trello: "T2",
} as const satisfies Record<string, PmToolTier>;

/** Canonical detected-type string for a PM tool with a known tier. */
export type KnownPmTool = keyof typeof PM_TOOL_TIERS;

/**
 * Resolve a tool's tier from its detected-type string. Returns `undefined` for
 * tools not yet classified (UNVERIFIED vendors) — callers should treat an
 * unknown tier conservatively (assume no push-time conflict guard).
 */
export function getPmToolTier(detectedType: string): PmToolTier | undefined {
	return (PM_TOOL_TIERS as Record<string, PmToolTier>)[detectedType];
}
