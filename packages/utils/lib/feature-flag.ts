/**
 * Opt-in feature-flag parser: default OFF. INVERTED vs the kill-switch
 * reader in apps/web/.../shared/lib/feature-flags.ts — do NOT copy that one.
 * Only "true"/"1"/"on"/"yes" (case-insensitive, trimmed) enable. #1702.
 */
export function parseOptInFlag(raw: string | undefined): boolean {
	if (raw === undefined || raw === null) {
		return false;
	}
	const v = raw.trim().toLowerCase();
	return v === "true" || v === "1" || v === "on" || v === "yes";
}

/**
 * Context Summarization (compressed project history) master flag — opt-in,
 * default OFF. Every server surface that summarization touches (the Temporal
 * cron + workflow, the manual-trigger API, and the RAG read path) gates on
 * this. When off: no cron runs, the manual trigger 404s, and context retrieval
 * is byte-for-byte unchanged (rollback-safe). The UI mirrors it via
 * `NEXT_PUBLIC_FABRIC_FEATURE_CONTEXT_SUMMARIZATION`.
 */
export function isContextSummarizationEnabled(): boolean {
	return parseOptInFlag(process.env.FABRIC_FEATURE_CONTEXT_SUMMARIZATION);
}

/**
 * QA / Test Cases master flag — opt-in, default OFF.
 *
 * Deliberately STRICTER than `parseOptInFlag`: it requires the literal `"true"`,
 * because `assertTestCasesFeatureEnabled` in the API layer always has. A looser
 * reader here would let `FABRIC_FEATURE_TEST_CASES=1` start the pipeline sweep
 * calling a customer's CI while every procedure that could show the result still
 * answered NOT_FOUND — the worst of both states.
 *
 * Read in server activities only, never in workflow code (determinism). The UI
 * mirrors it via `NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES`.
 */
export function isTestCasesEnabled(): boolean {
	return process.env.FABRIC_FEATURE_TEST_CASES === "true";
}

/**
 * PM attachment sync master flag — opt-in, default OFF.
 *
 * Deliberately STRICTER than `parseOptInFlag`, for the same reason as
 * `isTestCasesEnabled` and with a sharper edge: the UI half of this feature is
 * a client flag, `NEXT_PUBLIC_FABRIC_FEATURE_PM_ATTACHMENT_SYNC`, and Next
 * inlines that one with a literal `=== "true"` comparison. A looser reader here
 * would let `FABRIC_FEATURE_PM_ATTACHMENT_SYNC=1` open the write path while the
 * toggle that is supposed to drive it stayed hidden — a project could be opted
 * in through the API with no surface anywhere showing it, which is precisely
 * the state this flag exists to prevent. Keep the two readers identical.
 *
 * Both halves shipped (Fizzy #1745). With this flag on, the GitLab REST sync
 * path (`gitlab-rest-story-sync.ts`) reads `Project.syncAttachments` and:
 * on PUSH, uploads unlocked attachments to the linked GitLab issue (locked
 * ones are skipped); on PULL, imports attachments the issue carries back into
 * Fabric as unlocked rows, subject to #1702's size, type and per-story limits,
 * recording conflicts and remote deletions as StoryAttachmentSyncIssue rows
 * rather than overwriting either side. That path is the ONLY reader of the
 * column — every other PM tool ignores it.
 */
export function isPmAttachmentSyncEnabled(): boolean {
	return process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC === "true";
}

/**
 * Living Documents auto-refresh master flag — opt-in, default OFF. Gates the
 * enrollment control, the enrollment procedures, and the hourly sweep's
 * find-due activity. The Temporal schedule is registered regardless; gating
 * lives in the handler so flipping the flag on takes effect on the next tick
 * with no redeploy. The UI mirrors it via
 * `NEXT_PUBLIC_FABRIC_FEATURE_LIVING_DOCS_REFRESH`.
 */
export function isLivingDocsRefreshEnabled(): boolean {
	return parseOptInFlag(process.env.FABRIC_FEATURE_LIVING_DOCS_REFRESH);
}

/**
 * Role/Function Tags (#1767) master flag — opt-in, default OFF. Introduced at
 * Stage 4 (AI context injection); Stage 5 (group mentions) reads the same flag.
 * OFF ⇒ no function-tag context is injected into any AI payload (tags remain in
 * the DB, simply unread — rollback-safe). Read ONLY in server activities/
 * procedures, never in workflow code (determinism).
 */
export function isFunctionTagsEnabled(): boolean {
	return parseOptInFlag(process.env.FABRIC_FEATURE_FUNCTION_TAGS);
}

/**
 * Project-level Databricks knowledge in "Update using context" retrieval —
 * opt-in, default OFF. Gates the Databricks branch of
 * `retrieveRelevantContextsForSpec` end-to-end: with the flag off, retrieval
 * for every bound project is byte-for-byte unchanged (rollback-safe kill
 * switch — the retrieval behavior of every bound project changes the moment
 * this ships, including on the unattended sweep, with no other rollback
 * lever). Tool exposure (`search_databricks_indexes` in chat/agent flows) is
 * NOT gated here — disconnecting the binding covers that path.
 */
export function isProjectDatabricksKnowledgeEnabled(): boolean {
	return parseOptInFlag(
		process.env.FABRIC_FEATURE_PROJECT_DATABRICKS_KNOWLEDGE,
	);
}

/**
 * Application-log context in bug analysis (Fizzy #1234) — opt-in, default OFF
 * in every environment, including production. Gates the whole log-access path
 * end to end: OFF ⇒ no log source is resolved, no log platform is contacted,
 * and the analysis prompt is byte-for-byte what it is today.
 *
 * This flag guards a RESEARCH PROTOTYPE. The card gates production rollout on
 * a feasibility report being reviewed and approved (FR4), so this must not be
 * turned on anywhere until that sign-off exists — see
 * `docs/adr/017-bug-analysis-log-context.md`. Read ONLY in server activities,
 * never in workflow code (determinism).
 */
export function isBugAnalysisLogContextEnabled(): boolean {
	return parseOptInFlag(process.env.FABRIC_FEATURE_BUG_ANALYSIS_LOG_CONTEXT);
}

// The UI-editable flags are not read here — they are DB-backed. Use
// `isFeatureEnabled(key)` from `@repo/database`, and see
// packages/utils/lib/feature-flag-registry.ts for the registered set. A flag
// that gates a rollout belongs there rather than in this file: every reader in
// this file needs a deploy to change its answer, and a kill switch you have to
// deploy is a kill switch you do not have. NEWSLETTER_APPROVAL_CHAT moved there
// for exactly that reason (Fizzy #2203).
