/**
 * Audit-action catalog
 *
 * Plain-language descriptions for every action key the audit log can
 * emit. Powers two surfaces:
 *
 *  1. `AuditLogActionsHelpButton` — the (?) help dialog next to the
 *     Action filter that lets operators learn what each event means.
 *  2. Per-option hover tooltips inside the Action filter dropdown, so
 *     selecting from a long list doesn't require memorizing the
 *     closed-taxonomy keys.
 *
 * Keep entries:
 *  - **Specific** — name the trigger (e.g., "fired when a member
 *    accepts an org invite") rather than restating the label.
 *  - **Operator-friendly** — the audience is admins and SREs, not the
 *    developer who emitted the row. Cite the user-visible cause, not
 *    the internal procedure name.
 *  - **Short** — one sentence. If you need more, link to docs.
 *
 * If you add an action key to the taxonomy:
 *  1. Add a translation entry under `settings.auditLog.actions.*`.
 *  2. Add an entry here (key + categoryId + description).
 *  3. Append the categoryId to `CATEGORY_ORDER` if it's a new category.
 *
 * Spec: docs/audit-log/README.md §3 (event taxonomy).
 */

type AuditCategoryId =
	| "auth"
	| "org"
	| "account"
	| "project"
	| "story"
	| "audit"
	| "admin"
	| "incident"
	| "error"
	| "weave"
	| "newsletter"
	| "dailyBrief";

export interface AuditActionEntry {
	/** Canonical action key as stored in the database. */
	key: string;
	/** Category id — controls grouping in the help dialog. */
	categoryId: AuditCategoryId;
	/** Human-readable label translation key (under `settings.auditLog.actions.*`). */
	labelKey: string;
	/** One-line operator-facing description. */
	description: string;
}

export interface AuditCategory {
	id: AuditCategoryId;
	label: string;
	description: string;
}

/**
 * Display order for category sections in the help dialog. Frequency-
 * leading: auth + org + project + story (the everyday events) appear
 * before audit/admin (forensic events) and incident/error (failure
 * states).
 */
const CATEGORY_ORDER: AuditCategoryId[] = [
	"auth",
	"org",
	"account",
	"project",
	"story",
	"audit",
	"admin",
	"incident",
	"error",
	"weave",
	"newsletter",
	"dailyBrief",
];

const CATEGORIES: Record<AuditCategoryId, AuditCategory> = {
	auth: {
		id: "auth",
		label: "Authentication",
		description:
			"Sign-in, sign-out, MFA, password, and impersonation events.",
	},
	org: {
		id: "org",
		label: "Organization",
		description:
			"Organization lifecycle, members, API keys, and integration config.",
	},
	account: {
		id: "account",
		label: "Personal account",
		description: "Events scoped to a single user account (no org context).",
	},
	project: {
		id: "project",
		label: "Project",
		description: "Project lifecycle and project-level membership changes.",
	},
	story: {
		id: "story",
		label: "Feature",
		description:
			"Feature (a.k.a. user story) lifecycle — creation, edits, status, and PM-tool pushes.",
	},
	audit: {
		id: "audit",
		label: "Audit log",
		description:
			"Forensic events that record access to the audit log itself.",
	},
	admin: {
		id: "admin",
		label: "Staff actions",
		description:
			"Fabric staff cross-tenant actions taken via the admin surface.",
	},
	incident: {
		id: "incident",
		label: "Incidents",
		description:
			"Monitoring incident lifecycle from the error-rate, integration, and component streams.",
	},
	error: {
		id: "error",
		label: "Errors",
		description:
			"Synthesized rows that capture failed requests so operators can correlate without re-querying app logs.",
	},
	weave: {
		id: "weave",
		label: "Weave sessions",
		description:
			"Weave / CodingRun control-plane session lifecycle — clean teardowns at workflow exit and watchdog kills for stale runs.",
	},
	newsletter: {
		id: "newsletter",
		label: "Newsletter",
		description:
			"Release-notes newsletter public-exposure controls: the embeddable widget and the reviewer approval gate.",
	},
	dailyBrief: {
		id: "dailyBrief",
		label: "Daily Brief",
		description:
			"Per-project Daily Brief content curation — hiding or restoring a PR on the Release Notes panel.",
	},
};

export const AUDIT_ACTIONS: AuditActionEntry[] = [
	// ---- Authentication -------------------------------------------------
	{
		key: "auth.login.success",
		categoryId: "auth",
		labelKey: "settings.auditLog.actions.auth.login.success",
		description:
			"User signed in successfully — captures the session/correlation IDs for trace lookup.",
	},
	{
		key: "auth.login.failure",
		categoryId: "auth",
		labelKey: "settings.auditLog.actions.auth.login.failure",
		description:
			"Sign-in attempt failed (wrong credentials, expired magic link, locked account, etc.). Useful for brute-force investigations.",
	},
	{
		key: "auth.logout",
		categoryId: "auth",
		labelKey: "settings.auditLog.actions.auth.logout",
		description:
			"User signed out — either explicitly via the menu or because their session was invalidated.",
	},
	{
		key: "auth.mfa.enabled",
		categoryId: "auth",
		labelKey: "settings.auditLog.actions.auth.mfa.enabled",
		description:
			"Multi-factor authentication enrolled on this account (TOTP or passkey).",
	},
	{
		key: "auth.mfa.disabled",
		categoryId: "auth",
		labelKey: "settings.auditLog.actions.auth.mfa.disabled",
		description:
			"MFA removed from this account. Treat as a sensitive control change.",
	},
	{
		key: "auth.password.changed",
		categoryId: "auth",
		labelKey: "settings.auditLog.actions.auth.password.changed",
		description:
			"Account password rotated — either by the user or through a reset flow.",
	},
	{
		key: "auth.impersonation.started",
		categoryId: "auth",
		labelKey: "settings.auditLog.actions.auth.impersonation.started",
		description:
			"A staff member began acting as this user. Every action emitted between this row and the matching `auth.impersonation.ended` carries the impersonator's user id.",
	},
	{
		key: "auth.impersonation.ended",
		categoryId: "auth",
		labelKey: "settings.auditLog.actions.auth.impersonation.ended",
		description:
			"Staff impersonation session closed — actions after this row come from the user themselves again.",
	},
	// ---- Organization ---------------------------------------------------
	{
		key: "org.created",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.created",
		description: "New organization provisioned (paid tier or trial).",
	},
	{
		key: "org.updated",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.updated",
		description:
			"Organization profile fields changed (name, slug, branding, billing email, etc.).",
	},
	{
		key: "org.deleted",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.deleted",
		description:
			"Organization marked for deletion. All members lose access immediately; data purges per retention policy.",
	},
	{
		key: "org.settings.updated",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.settings.updated",
		description:
			"Org-level configuration changed (default model, integration credentials at the org level, etc.).",
	},
	{
		key: "org.member.invited",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.member.invited",
		description:
			"Email invite sent to add a new member to the organization.",
	},
	{
		key: "org.member.role_changed",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.member.role_changed",
		description:
			"Member role changed (Owner / Admin / Member). The `metadata.from` and `metadata.to` fields carry the before/after roles.",
	},
	{
		key: "org.member.removed",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.member.removed",
		description:
			"Member removed from the organization — they lose access to every project in this org.",
	},
	{
		key: "org.api_key.created",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.api_key.created",
		description:
			"Organization-scoped API key issued. `metadata.keyPrefix` carries the first 12 characters for forensic lookup.",
	},
	{
		key: "org.api_key.revoked",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.api_key.revoked",
		description:
			"Organization API key revoked — any subsequent request signed with that key returns 401.",
	},
	{
		key: "org.api_key.rotated",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.api_key.rotated",
		description:
			"Organization API key rotated. The old key continues to work for the configured grace window before it 401s.",
	},
	{
		key: "org.integration.connected",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.integration.connected",
		description:
			"Org connected a third-party integration (GitLab, Slack, Teams, MCP server, etc.).",
	},
	{
		key: "org.integration.disconnected",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.integration.disconnected",
		description:
			"Integration disconnected — credentials revoked and the OAuth handshake undone.",
	},
	{
		key: "org.integration.config_updated",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.org.integration.config_updated",
		description:
			"Integration configuration changed (channel mappings, scopes, webhook URLs, etc.). Captured even when the connection itself is unchanged.",
	},
	// ---- Personal account -----------------------------------------------
	{
		key: "account.api_key.created",
		categoryId: "account",
		labelKey: "settings.auditLog.actions.account.api_key.created",
		description:
			"User minted a personal API key (`fab_…`) for SDK/CLI use against their own data.",
	},
	{
		key: "account.api_key.revoked",
		categoryId: "account",
		labelKey: "settings.auditLog.actions.account.api_key.revoked",
		description: "Personal API key revoked — token immediately 401s.",
	},
	{
		key: "account.api_key.rotated",
		categoryId: "account",
		labelKey: "settings.auditLog.actions.account.api_key.rotated",
		description:
			"Personal API key rotated. Old key honored through the configured grace window.",
	},
	// ---- Project --------------------------------------------------------
	{
		key: "project.ci_run.triggered",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.ci_run.triggered",
		description:
			"Fabric started a run in the project's connected CI pipeline using a stored credential. Recorded for refused attempts too, including ones rejected before any provider was contacted.",
	},
	{
		key: "project.agentic_run.dispatched",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.agentic_run.dispatched",
		description:
			"Fabric started a browser-driven test run against one of the project's environments, signing in with a stored credential. Recorded for refused attempts too — over the per-run cost cap, or a production target nobody confirmed.",
	},
	{
		key: "project.environment_credential.updated",
		categoryId: "project",
		labelKey:
			"settings.auditLog.actions.project.environment_credential.updated",
		description:
			"A sign-in credential for one of the project's deployment targets was stored, changed or cleared. Unlike a repository token this one logs in to the running application, so the row records whether the target was a production environment.",
	},
	{
		key: "project.environment.created",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.environment.created",
		description:
			"A deployment target was added to the project. The audit metadata records its type and URL origins without storing credentials or query strings.",
	},
	{
		key: "project.environment.updated",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.environment.updated",
		description:
			"A deployment target's name, type, or URL changed. Production-target changes are recorded with warning severity.",
	},
	{
		key: "project.environment.deleted",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.environment.deleted",
		description:
			"A deployment target was removed from the project and any default-environment reference to it was cleared.",
	},
	{
		key: "project.qa_settings.updated",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.qa_settings.updated",
		description:
			"The project's testing policy changed. Free-text rules are not copied into the audit row; metadata records which settings changed and whether evidence was disabled.",
	},
	{
		key: "project.qa_finding.dismissed",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.qa_finding.dismissed",
		description:
			"Someone stopped tracking a CI failure without it being fixed. Distinct from a finding the pipeline resolved on its own — this is a decision not to chase it, so the ledger records who made it.",
	},
	{
		key: "project.qa_finding.merged",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.qa_finding.merged",
		description:
			"Duplicate findings were folded into one, combining their occurrence counts. Metadata records the surviving finding and every id merged into it, so the fold can be read back.",
	},
	{
		key: "project.qa_webhook.created",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.qa_webhook.created",
		description:
			"An authenticated inbound endpoint for immediate pipeline-result delivery was created.",
	},
	{
		key: "project.qa_webhook.rotated",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.qa_webhook.rotated",
		description:
			"The testing webhook signing secret was rotated with a bounded overlap window for the previous secret.",
	},
	{
		key: "project.qa_webhook.expiry_updated",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.qa_webhook.expiry_updated",
		description:
			"The expiry policy for the project's inbound testing webhook changed.",
	},
	{
		key: "project.qa_webhook.revoked",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.qa_webhook.revoked",
		description:
			"The project's inbound testing webhook and all of its accepted delivery identifiers were revoked.",
	},
	{
		key: "project.pull_request.read",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.pull_request.read",
		description:
			"Fabric fetched a pull request's diff from the project's connected repository, using that repository's own credential. Records who asked, which repository and which commit range — never the diff or the credential.",
	},
	{
		key: "project.pull_request.reviewed",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.pull_request.reviewed",
		description:
			"A review lens ran over a pull request Fabric had already read — a judgement that spends model credits, unlike the read. Records the lens, the commit, how many findings survived grounding, and how many were dropped as ungrounded.",
	},
	{
		key: "project.pull_request.finding_judged",
		categoryId: "project",
		labelKey:
			"settings.auditLog.actions.project.pull_request.finding_judged",
		description:
			'Someone accepted or dismissed a pull-request review finding. A dismissal reasoned "not correct" is what the lens\'s false-positive rate is measured from, so each one is attributable.',
	},
	{
		key: "project.pull_request.comment_posted",
		categoryId: "project",
		labelKey:
			"settings.auditLog.actions.project.pull_request.comment_posted",
		description:
			"Fabric wrote a review comment into the project's connected repository — the only action here that leaves the deployment and lands where the customer's whole team reads it. Records whether it created a comment or edited the existing one in place, how many findings it carried, and whether a person pressed the button or an opted-in webhook triggered it.",
	},
	{
		key: "project.databricks_knowledge.connected",
		categoryId: "project",
		labelKey:
			"settings.auditLog.actions.project.databricks_knowledge.connected",
		description:
			"Project bound to a Databricks Vector Search integration and a set of its indexes. Read-only — Fabric queries the customer's own index, it never writes to it.",
	},
	{
		key: "project.databricks_knowledge.disconnected",
		categoryId: "project",
		labelKey:
			"settings.auditLog.actions.project.databricks_knowledge.disconnected",
		description:
			"Project's Databricks Vector Search binding removed. Chat/agent tool access and retrieval fusion against the external index stop immediately.",
	},
	{
		key: "project.created",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.created",
		description: "New project provisioned inside an organization.",
	},
	{
		key: "project.updated",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.updated",
		description:
			"Project profile changed — name, description, default repo, default branch, etc.",
	},
	{
		key: "project.archived",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.archived",
		description:
			"Project archived — data preserved, but the project is hidden from default views and writes are blocked.",
	},
	{
		key: "project.deleted",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.deleted",
		description:
			"Project soft-deleted (a permanent purge is scheduled per retention policy).",
	},
	{
		key: "project.member.invited",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.member.invited",
		description:
			"Project-level invite sent (membership is independent of org membership for fine-grained access).",
	},
	{
		key: "project.member.role_changed",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.member.role_changed",
		description:
			"Project-level role changed (Owner / Admin / Editor / Commenter / Viewer).",
	},
	{
		key: "project.member.function_tags_changed",
		categoryId: "project",
		labelKey:
			"settings.auditLog.actions.project.member.function_tags_changed",
		description: "Project-level role/function tags changed for a member.",
	},
	{
		key: "project.member.function_tags_confirmed",
		categoryId: "project",
		labelKey:
			"settings.auditLog.actions.project.member.function_tags_confirmed",
		description:
			"A member confirmed their own role/function tags on this project. An administrator's edit clears that confirmation; only the member can restore it.",
	},
	{
		key: "project.member.removed",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.project.member.removed",
		description:
			"Member removed from this project — they keep org-level access if any.",
	},
	{
		key: "project.meeting_digest.inclusion_changed",
		categoryId: "project",
		labelKey:
			"settings.auditLog.actions.project.meeting_digest.inclusion_changed",
		description:
			"A project admin included or excluded a recurring meeting series from the Meeting Digest. `metadata.included` carries the new state.",
	},
	{
		key: "project.meeting_digest.action_item_toggled",
		categoryId: "project",
		labelKey:
			"settings.auditLog.actions.project.meeting_digest.action_item_toggled",
		description:
			"A project member checked or unchecked a Meeting Digest action item. `metadata.completed` carries the new state.",
	},
	// ---- Feature / story ------------------------------------------------
	{
		key: "story.created",
		categoryId: "story",
		labelKey: "settings.auditLog.actions.story.created",
		description:
			"New feature created (a.k.a. UserStory in the backend, displayed as F-XXX in the app).",
	},
	{
		key: "story.updated",
		categoryId: "story",
		labelKey: "settings.auditLog.actions.story.updated",
		description:
			"Feature title, description, or any structured field edited.",
	},
	{
		key: "story.reprioritized",
		categoryId: "story",
		labelKey: "settings.auditLog.actions.story.reprioritized",
		description:
			"An AI re-prioritization run over the project's work items — recorded even when it changed nothing. `metadata.considered` and `metadata.changed` carry the counts; per-item band moves live in each item's priority history.",
	},
	{
		key: "story.deleted",
		categoryId: "story",
		labelKey: "settings.auditLog.actions.story.deleted",
		description: "Feature deleted from the project.",
	},
	{
		key: "story.status_changed",
		categoryId: "story",
		labelKey: "settings.auditLog.actions.story.status_changed",
		description:
			"Feature status moved between workflow columns. `metadata.from` and `metadata.to` carry the before/after states.",
	},
	{
		key: "story.pm_pushed",
		categoryId: "story",
		labelKey: "settings.auditLog.actions.story.pm_pushed",
		description:
			"Feature synced to a PM tool (Jira / Linear / GitHub Projects). The external id appears in `metadata`.",
	},
	{
		key: "document_assistant.conversation.created",
		categoryId: "story",
		labelKey:
			"settings.auditLog.actions.document_assistant.conversation.created",
		description:
			"A feature-editor AI assistant conversation was started for a document.",
	},
	{
		key: "document_assistant.conversation.renamed",
		categoryId: "story",
		labelKey:
			"settings.auditLog.actions.document_assistant.conversation.renamed",
		description: "An assistant conversation was renamed.",
	},
	{
		key: "document_assistant.conversation.archived",
		categoryId: "story",
		labelKey:
			"settings.auditLog.actions.document_assistant.conversation.archived",
		description: "An assistant conversation was archived.",
	},
	{
		key: "document_assistant.conversation.deleted",
		categoryId: "story",
		labelKey:
			"settings.auditLog.actions.document_assistant.conversation.deleted",
		description: "An assistant conversation was deleted.",
	},
	{
		key: "document_assistant.conversation.spilled",
		categoryId: "story",
		labelKey:
			"settings.auditLog.actions.document_assistant.conversation.spilled",
		description:
			"An assistant conversation hit its turn cap and spilled into a linked continuation conversation. `metadata` links the two.",
	},
	{
		key: "document_assistant.conversation.visibility_changed",
		categoryId: "story",
		labelKey:
			"settings.auditLog.actions.document_assistant.conversation.visibility_changed",
		description:
			"An assistant conversation was toggled between shared and private visibility.",
	},
	// ---- Audit ----------------------------------------------------------
	{
		key: "audit.viewed",
		categoryId: "audit",
		labelKey: "settings.auditLog.actions.audit.viewed",
		description:
			"A user opened the audit log viewer for an org or personal scope. Captures who looked at the trail.",
	},
	{
		key: "audit.exported",
		categoryId: "audit",
		labelKey: "settings.auditLog.actions.audit.exported",
		description:
			"Audit data exported to CSV or NDJSON. The metadata carries the row count, format, and the filter snapshot used.",
	},
	{
		key: "audit.retention.purged",
		categoryId: "audit",
		labelKey: "settings.auditLog.actions.audit.retention.purged",
		description:
			"Scheduled retention job purged rows older than the configured window. `metadata.rowsDeleted` carries the count.",
	},
	{
		key: "audit.api_request",
		categoryId: "audit",
		labelKey: "settings.auditLog.actions.audit.api_request",
		description:
			"A REST API call against `/api/v1/*` succeeded. Records the route, status, and rate-limit headers — useful for confirming SDK / CLI usage.",
	},
	{
		key: "userActivity.viewed",
		categoryId: "audit",
		labelKey: "settings.auditLog.actions.userActivity.viewed",
		description:
			"A user opened the User Activity dashboard (org member list or a single member's login history). `metadata.endpoint` distinguishes the two, and `metadata.targetUserId` names the viewed member for the history view.",
	},
	// ---- Admin / staff --------------------------------------------------
	{
		key: "admin.auditLog.viaApiKey",
		categoryId: "admin",
		labelKey: "settings.auditLog.actions.admin.auditLog.viaApiKey",
		description:
			"Fabric staff queried a customer's audit log via the admin explorer, using an API key the customer provided. The acting admin and the targeted tenant are both captured.",
	},
	// ---- Errors ---------------------------------------------------------
	{
		key: "error.permission_denied",
		categoryId: "error",
		labelKey: "settings.auditLog.actions.error.permission_denied",
		description:
			"A request reached a procedure the caller is not authorized to invoke. The procedure path lives in `metadata.path`.",
	},
	{
		key: "error.not_found",
		categoryId: "error",
		labelKey: "settings.auditLog.actions.error.not_found",
		description:
			"A request targeted a resource that does not exist (or that the caller cannot see under XOR isolation).",
	},
	{
		key: "error.validation",
		categoryId: "error",
		labelKey: "settings.auditLog.actions.error.validation",
		description:
			"Input failed the Zod schema validation step before reaching the handler.",
	},
	{
		key: "error.rate_limited",
		categoryId: "error",
		labelKey: "settings.auditLog.actions.error.rate_limited",
		description:
			"Caller exceeded the rate-limit budget (e.g., 600 req/min for the auditExternal preset).",
	},
	{
		key: "error.unavailable",
		categoryId: "error",
		labelKey: "settings.auditLog.actions.error.unavailable",
		description:
			"A required dependency (DB, Temporal, LLM provider, etc.) was unreachable and the request short-circuited.",
	},
	{
		key: "error.timeout",
		categoryId: "error",
		labelKey: "settings.auditLog.actions.error.timeout",
		description:
			"The procedure took longer than the configured ceiling and was aborted.",
	},
	{
		key: "error.conflict",
		categoryId: "error",
		labelKey: "settings.auditLog.actions.error.conflict",
		description:
			"A concurrent write produced a state collision (optimistic-lock failure or duplicate key).",
	},
	{
		key: "error.internal",
		categoryId: "error",
		labelKey: "settings.auditLog.actions.error.internal",
		description:
			"An unhandled exception bubbled to the error-mapping middleware. The correlation id links this row to the traceback in App Insights.",
	},
	// ---- Incidents ------------------------------------------------------
	{
		key: "incident.fired",
		categoryId: "incident",
		labelKey: "settings.auditLog.actions.incident.fired",
		description:
			"A monitoring rule started firing — error-rate alert, integration probe failure, or component health regression.",
	},
	{
		key: "incident.re_fired",
		categoryId: "incident",
		labelKey: "settings.auditLog.actions.incident.re_fired",
		description:
			"An auto-resolved incident re-opened because the underlying signal breached again before the cool-down window expired.",
	},
	{
		key: "incident.acknowledged",
		categoryId: "incident",
		labelKey: "settings.auditLog.actions.incident.acknowledged",
		description:
			"An admin clicked Acknowledge — paging stops while the incident stays open. The actor is the admin who claimed it.",
	},
	{
		key: "incident.commented",
		categoryId: "incident",
		labelKey: "settings.auditLog.actions.incident.commented",
		description:
			"An admin added a note to an incident. The note text is in `metadata.note` and forms part of the post-mortem trail.",
	},
	{
		key: "incident.auto_resolved",
		categoryId: "incident",
		labelKey: "settings.auditLog.actions.incident.auto_resolved",
		description:
			"Incident auto-cleared after the recovery hysteresis window saw the signal healthy for the required duration.",
	},
	{
		key: "incident.manual_resolved",
		categoryId: "incident",
		labelKey: "settings.auditLog.actions.incident.manual_resolved",
		description:
			"An admin manually resolved the incident from the dialog. Resolve note (if any) lives in `metadata.note`.",
	},
	// ---- Weave / CodingRun sessions -------------------------------------
	{
		key: "weave.session.terminated_on_exit",
		categoryId: "weave",
		labelKey: "settings.auditLog.actions.weave.session.terminated_on_exit",
		description:
			"Background Agent control-plane session torn down because the owning orchestrator or coding-run workflow finished (success, failure, OAuth-block, cancel, exception). `metadata.exitReason` carries the workflow's chosen terminal state and `metadata.runDurationMs` the total run time.",
	},
	{
		key: "weave.session.terminated_stale",
		categoryId: "weave",
		labelKey: "settings.auditLog.actions.weave.session.terminated_stale",
		description:
			"Watchdog cron killed a Weave or coding-run row that exceeded `WEAVE_MAX_RUN_MINUTES` / `CODING_RUN_MAX_MINUTES`. Fires when the orchestrator's polite teardown never ran (worker crash, force-terminate, control-plane hang). `metadata.runDurationMs` shows how long the row had been non-terminal.",
	},
	// ---- Newsletter approval gate ---------------------------------------
	{
		key: "newsletter.approval.required_changed",
		categoryId: "newsletter",
		labelKey:
			"settings.auditLog.actions.newsletter.approval.required_changed",
		description:
			"A project OWNER turned the release-notes approval gate on or off. When on, every send is held for reviewer sign-off before delivery.",
	},
	{
		key: "newsletter.send.approved",
		categoryId: "newsletter",
		labelKey: "settings.auditLog.actions.newsletter.send.approved",
		description:
			"A reviewer approved a held newsletter draft, clearing it for delivery.",
	},
	{
		key: "newsletter.send.rejected",
		categoryId: "newsletter",
		labelKey: "settings.auditLog.actions.newsletter.send.rejected",
		description:
			"A reviewer rejected a held newsletter draft — it will not be sent. `metadata.rejectionReason` carries the reviewer's optional note.",
	},
	// ---- Daily Brief release-notes curation -----------------------------
	{
		key: "dailyBrief.releaseNote.hidden",
		categoryId: "dailyBrief",
		labelKey: "settings.auditLog.actions.dailyBrief.releaseNote.hidden",
		description:
			"A project OWNER hid a PR from the Daily Brief's Release Notes panel. The PR is excluded from future generations until unhidden.",
	},
	{
		key: "dailyBrief.releaseNote.unhidden",
		categoryId: "dailyBrief",
		labelKey: "settings.auditLog.actions.dailyBrief.releaseNote.unhidden",
		description:
			"A project OWNER restored a previously hidden PR to the Daily Brief's Release Notes panel.",
	},
	{
		key: "project.invitation.widget_dismissed",
		categoryId: "project",
		labelKey:
			"settings.auditLog.actions.project.invitation.widget_dismissed",
		description:
			"A member dismissed the pending-invitation prompt on the project dashboard. The invitation itself is untouched.",
	},
	{
		key: "story.auto_hidden",
		categoryId: "story",
		labelKey: "settings.auditLog.actions.story.auto_hidden",
		description:
			"Fabric hid a feature from the roadmap automatically — no person chose this, so look here before assuming someone removed it.",
	},
	{
		key: "story.auto_unhidden",
		categoryId: "story",
		labelKey: "settings.auditLog.actions.story.auto_unhidden",
		description:
			"Fabric restored a previously auto-hidden feature to the roadmap once the condition that hid it cleared.",
	},
	{
		key: "story.pm_ticket_unlinked",
		categoryId: "story",
		labelKey: "settings.auditLog.actions.story.pm_ticket_unlinked",
		description:
			"The link between a Fabric feature and its ticket in the connected PM tool was removed. Later syncs will not update that ticket.",
	},
	{
		key: "story.pm_flag_missing_auto_dismissed",
		categoryId: "story",
		labelKey:
			"settings.auditLog.actions.story.pm_flag_missing_auto_dismissed",
		description:
			"Fabric cleared its own 'PM card missing' warning after the ticket reappeared, without anyone acting on it.",
	},
	{
		key: "atlas.analysis.requested",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.analysis.requested",
		description:
			"Someone started a code-understanding analysis run for a connected repository.",
	},
	{
		key: "atlas.analysis.cancelled",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.analysis.cancelled",
		description:
			"A running Atlas analysis was cancelled before it finished. Partial results may remain.",
	},
	{
		key: "atlas.analysis.completed",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.analysis.completed",
		description:
			"An Atlas analysis finished and its graph was published to the project.",
	},
	{
		key: "atlas.analysis.failed",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.analysis.failed",
		description:
			"An Atlas analysis stopped with an error — commonly repository access or clone failure. The stored graph is unchanged.",
	},
	{
		key: "atlas.node.regenerated",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.node.regenerated",
		description:
			"The AI description for one Atlas node was regenerated, replacing the previous text.",
	},
	{
		key: "atlas.node.edited",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.node.edited",
		description:
			"A person edited an Atlas node by hand, overriding what the analysis produced.",
	},
	{
		key: "atlas.edge.edited",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.edge.edited",
		description: "A person edited a relationship between two Atlas nodes.",
	},
	{
		key: "atlas.edge.created",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.edge.created",
		description:
			"A person added a relationship the analysis did not infer.",
	},
	{
		key: "atlas.edge.deleted",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.edge.deleted",
		description:
			"A person removed a relationship from the Atlas graph. It can be restored.",
	},
	{
		key: "atlas.edge.restored",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.edge.restored",
		description: "A previously deleted Atlas relationship was restored.",
	},
	{
		key: "atlas.branch.changed",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.branch.changed",
		description:
			"The branch Atlas indexes was changed. This does not affect which branch testing reads CI results from.",
	},
	{
		key: "atlas.branches.pinned",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.atlas.branches.pinned",
		description:
			"The set of branches Atlas keeps indexed was pinned, so later default-branch changes do not silently move the index.",
	},
	{
		key: "backlog.proposal.cancelled",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.backlog.proposal.cancelled",
		description:
			"A person cancelled an in-flight AI backlog proposal before it was applied.",
	},
	{
		key: "backlog.proposal.timed_out",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.backlog.proposal.timed_out",
		description:
			"An AI backlog proposal was abandoned by the watchdog after running too long. Nothing was applied.",
	},
	{
		key: "newsletter.widget.enabled",
		categoryId: "newsletter",
		labelKey: "settings.auditLog.actions.newsletter.widget.enabled",
		description:
			"The public subscribe widget was turned on, making its token-authenticated endpoint reachable.",
	},
	{
		key: "newsletter.widget.disabled",
		categoryId: "newsletter",
		labelKey: "settings.auditLog.actions.newsletter.widget.disabled",
		description:
			"The public subscribe widget was turned off. Existing subscribers are unaffected.",
	},
	{
		key: "newsletter.widget.token_rotated",
		categoryId: "newsletter",
		labelKey: "settings.auditLog.actions.newsletter.widget.token_rotated",
		description:
			"The widget's token was rotated. Any embed still using the old token stops working immediately.",
	},
	{
		key: "mcp.config.created",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.mcp.config.created",
		description:
			"A Model Context Protocol server configuration was added, giving Fabric a new external tool connection.",
	},
	{
		key: "mcp.config.updated",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.mcp.config.updated",
		description:
			"An MCP server configuration was changed — endpoint, credentials or enablement.",
	},
	{
		key: "mcp.config.deleted",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.mcp.config.deleted",
		description:
			"An MCP server configuration was removed. Features depending on it stop working.",
	},
	{
		key: "mcp.session.organization_denied",
		categoryId: "org",
		labelKey: "settings.auditLog.actions.mcp.session.organization_denied",
		description:
			"A protocol request named an organization its caller does not belong to, and was refused. The row records the attempt, since a refused request never reaches a tenant-scoped query and would otherwise leave no trace.",
	},
	{
		key: "decision.override_accepted",
		categoryId: "project",
		labelKey: "settings.auditLog.actions.decision.override_accepted",
		description:
			"Someone accepted an override of a previously settled project decision, replacing the recorded outcome.",
	},
	{
		key: "featureFlag.updated",
		categoryId: "admin",
		labelKey: "settings.auditLog.actions.featureFlag.updated",
		description:
			"An administrator changed a feature flag, altering what is available to users without a deploy.",
	},
	{
		key: "featureFlag.reset",
		categoryId: "admin",
		labelKey: "settings.auditLog.actions.featureFlag.reset",
		description:
			"An administrator reset a feature flag to its default value.",
	},
	{
		key: "statusUpdate.published",
		categoryId: "admin",
		labelKey: "settings.auditLog.actions.statusUpdate.published",
		description:
			"An administrator published a platform status announcement, visible to every customer on the System Health page.",
	},
	{
		key: "statusUpdate.revised",
		categoryId: "admin",
		labelKey: "settings.auditLog.actions.statusUpdate.revised",
		description:
			"An administrator added a progress update to a published status announcement, changing what customers are told.",
	},
];

/**
 * Look up the description for an action key. Falls back to a generic
 * sentence when the action is new and the catalog hasn't been updated
 * yet — better than returning empty so the tooltip never collapses.
 */
export function describeActionKey(key: string): string {
	const entry = AUDIT_ACTIONS.find((a) => a.key === key);
	if (entry) {
		return entry.description;
	}
	return "Custom action emitted by this deployment. See the action key for the originating procedure.";
}

/**
 * Build the catalog grouped by category, preserving `CATEGORY_ORDER`.
 * The help dialog uses this to render section headers.
 */
export function getActionsByCategory(): Array<{
	category: AuditCategory;
	actions: AuditActionEntry[];
}> {
	return CATEGORY_ORDER.map((id) => ({
		category: CATEGORIES[id],
		actions: AUDIT_ACTIONS.filter((a) => a.categoryId === id),
	}));
}
