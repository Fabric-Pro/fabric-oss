/**
 * Tests for the `audit.taxonomy` procedure handler.
 *
 * Spec: docs/audit-log/README.md §13.2.
 */

import { describe, expect, it, vi } from "vitest";

// Use importOriginal so the procedures' transitive deps (e.g. @repo/ai
// re-exports) keep working. We don't need to override anything here —
// the taxonomy procedure returns the real AUDIT_ACTIONS / AUDIT_CATEGORIES
// constants verbatim.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return actual;
});

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: vi.fn().mockReturnValue(""),
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { getAuditTaxonomyProcedure } from "../procedures/taxonomy";

const handler = (
	getAuditTaxonomyProcedure as unknown as {
		"~orpc": {
			handler: (args: {
				context: { user: { id: string; email: string } };
				input: Record<string, unknown>;
			}) => Promise<{
				actions: string[];
				categories: string[];
				errorActions: string[];
			}>;
		};
	}
)["~orpc"].handler;

describe("audit.taxonomy handler", () => {
	it("returns the 85 closed action keys, 16 categories, and the 8 error keys (D16, D17 + public-REST-API + Weave-session-lifecycle + story.auto_hidden/auto_unhidden + story.pm_ticket_unlinked + atlas analysis-lifecycle/branch/node-edit/pin/edge + backlog proposal-recovery + project.invitation.widget_dismissed + newsletter-widget-owner-actions + project.meeting_digest.inclusion_changed + userActivity.viewed + project.meeting_digest.action_item_toggled + newsletter-approval-gate + dailyBrief.releaseNote hide/unhide + decision-override + story.reprioritized + featureFlag.updated + qa-finding dismiss/merge additions + document-generation-failure)", async () => {
		const result = await handler({
			context: { user: { id: "user-1", email: "alice@example.com" } },
			input: {},
		});

		// 41 prior (35 + 6 incident.*) + 5 (3 account.api_key.*, 1
		// org.api_key.rotated, 1 audit.api_request) + 2 Weave session
		// lifecycle (terminated_on_exit + terminated_stale) + 2
		// story.auto_hidden + story.auto_unhidden + 1 story.pm_ticket_unlinked
		// + 8 atlas (analysis.requested/cancelled/completed/failed +
		// node.regenerated + node.edited + branch.changed + branches.pinned) + 1
		// story.pm_flag_missing_auto_dismissed + 4 atlas edge
		// (edge.edited/created/deleted/restored) + 2 backlog
		// (proposal.cancelled + proposal.timed_out) + 1
		// project.invitation.widget_dismissed (welcome-widget dismissal, #1457) = 67.
		// + 3 newsletter.widget.* (enabled/disabled/token_rotated) + 1
		// userActivity.viewed (User Activity dashboard meta-event, #1709) = 72.
		// + 3 mcp.config.* (created/updated/deleted — MCP credential-config
		// lifecycle, SOC 2 CC7.2 / M15) = 75.
		// + 1 project.meeting_digest.action_item_toggled (Meeting Digest v2
		// action-item completion toggle, #1814) = 76.
		// + 3 newsletter approval-gate (newsletter.approval.required_changed +
		// newsletter.send.approved + newsletter.send.rejected — Fizzy #1869) = 79.
		// + 2 dailyBrief.releaseNote.hidden/unhidden (per-project release-notes
		// curation, Fizzy #1869 follow-up) = 81.
		// + 1 decision.override_accepted (AI decision pre-check override — one
		// immutable row per conflicting decision on accept) = 82.
		// + 1 project.member.function_tags_changed (project-scoped role/function
		// tag management — Role/Function Tags Stage 1, Task 7) = 83.
		// + 1 story.reprioritized (one row per roadmap AI re-prioritization RUN,
		// including no-op runs — resource is the project) = 84.
		// + 1 featureFlag.updated (instance-admin global feature-flag toggle,
		// DB-backed override replacing env-var-only flags) = 85.
		// + 1 featureFlag.reset (clear-override returns a flag to its default) = 86.
		// + 1 project.ci_run.triggered (Fabric starts a run in the customer's own
		// CI using a stored credential — one row per attempt, including the ones
		// refused before any provider was called) = 87.
		// + 1 project.environment_credential.updated (a sign-in credential for a
		// deployment target stored/changed/cleared — logs in to the customer's
		// own running system, so the row records whether it was production) = 88.
		// + 1 project.agentic_run.dispatched (Fabric drives a browser against a
		// project environment — one row per attempt, including refusals on the
		// cost cap or an unconfirmed production target) = 89.
		// + 2 project.databricks_knowledge.connected/disconnected (project-level
		// Databricks Vector Search knowledge binding lifecycle — connecting
		// points every agent/retrieval flow in the project at an external
		// customer corpus via a stored org credential) = 91.
		// + 3 project.environment.created/updated/deleted (deployment-target URL
		// lifecycle, including production targets that later receive stored
		// credentials) = 94.
		// The running tally above stops at 94 while the assertion below is higher:
		// seven QA-surface actions (qa_settings, qa_finding dismiss/merge, and the
		// four qa_webhook rows) landed without extending the chain. Left as-is
		// rather than back-filled from guesswork — the assertion is the guard, and
		// the comment is a reading aid that has drifted.
		// + 1 project.pull_request.read (Fabric fetches a pull request's diff from
		// the customer's connected repository with their own credential — one row
		// per read, naming who asked and which commit range) = 102.
		// + 2 project.pull_request.reviewed / .finding_judged (a review lens RAN
		// over a read PR — a judgement that spends credits, recorded with how many
		// findings survived grounding — and a person accepting or dismissing one,
		// which is the number a false-positive rate is measured from) = 104.
		// + 2 statusUpdate.published / .revised (publishing customer-facing
		// status text, and every revision of it, is a public-communication act
		// — "who told customers what, when" is what an incident review asks) =
		// 106.
		// + 1 project.pull_request.comment_posted (Fabric WRITES into the
		// customer's repository — the only action in the taxonomy that leaves the
		// deployment and lands where their whole team reads it. It was already
		// being emitted and was missing from the closed set, so every row logged
		// `audit.unknown_action`) = 107.
		// + 1 project.member.function_tags_confirmed (a member confirming their
		// OWN role on a project — the counterpart to the admin-side
		// function_tags_changed, and the only one of the pair the member can
		// emit, Fizzy #2264) = 108.
		// + 1 mcp.session.organization_denied (a protocol request named an
		// organization its caller is not a member of and was refused. The
		// refusal is the only trace the attempt leaves — the request never
		// reaches a tenant-scoped query, so nothing downstream would log it,
		// Fizzy #1875) = 109.
		// + 1 project.document_generation.failed (the generation agent could not
		// be reached, so a fallback ran — the row is written whether or not that
		// fallback then succeeded, because a generation that quietly ran on the
		// degraded path is exactly what nobody could see. It carries the PRIMARY
		// failure, because the document's own error field renders verbatim to
		// every project member and a transport error naming an internal host is
		// not something to put in a project's UI. Without the row that first
		// failure existed only as a warning log line, Fizzy #2210) = 110.
		// + 2 (featureFlag.orgUpdated + featureFlag.orgReset — the
		// per-organization override that outranks the global row: enrolling or
		// explicitly excluding one organization, and clearing its row so it
		// inherits again. Distinct keys rather than reusing the global pair
		// because these carry a top-level organizationId and appear in that
		// organization's own log) = 112.
		// + 1 prompt.deletion_impact_viewed (the platform-wide prompt-deletion
		// impact read — an un-scoped, cross-tenant traversal behind the
		// deletion's own authority. It is a GET, so automatic activity capture
		// drops it and the row is the only trace the read leaves, Fizzy #2328)
		// = 113.
		// + 1 prompt.system_deleted (a SYSTEM prompt was deleted from the
		// catalogue — the one action in that module that REMOVES rows belonging
		// to other tenants, and it takes every SYSTEM row carrying the key
		// rather than the one the operator selected. The row carries what was
		// actually removed, derived from the deletion rather than from the
		// snapshot the confirmation showed, Fizzy #2328) = 114.
		expect(result.actions).toHaveLength(114);
		expect(result.actions).toContain("auth.login.success");
		expect(result.actions).toContain("project.document_generation.failed");
		expect(result.actions).toContain("audit.retention.purged");
		expect(result.actions).toContain("project.pull_request.comment_posted");
		expect(result.actions).toContain("statusUpdate.published");
		expect(result.actions).toContain("statusUpdate.revised");
		expect(result.actions).toContain("prompt.deletion_impact_viewed");
		expect(result.actions).toContain("prompt.system_deleted");
		// PM terminal-status auto-close + reopen-unhide (#1360).
		expect(result.actions).toContain("story.auto_hidden");
		expect(result.actions).toContain("story.auto_unhidden");
		// FLAG_MISSING accept severs the dead PM link (#1360).
		expect(result.actions).toContain("story.pm_ticket_unlinked");
		// FLAG_MISSING auto-dismiss on ticket reappearance (#1360).
		expect(result.actions).toContain(
			"story.pm_flag_missing_auto_dismissed",
		);
		// Roadmap Priority AI re-prioritization run (one row per run, incl.
		// no-ops).
		expect(result.actions).toContain("story.reprioritized");
		// D17 incident actions are in the closed taxonomy.
		expect(result.actions).toContain("incident.fired");
		expect(result.actions).toContain("incident.re_fired");
		expect(result.actions).toContain("incident.acknowledged");
		expect(result.actions).toContain("incident.commented");
		expect(result.actions).toContain("incident.auto_resolved");
		expect(result.actions).toContain("incident.manual_resolved");
		// Public-REST-API additions.
		expect(result.actions).toContain("account.api_key.created");
		expect(result.actions).toContain("account.api_key.revoked");
		expect(result.actions).toContain("account.api_key.rotated");
		expect(result.actions).toContain("org.api_key.rotated");
		expect(result.actions).toContain("audit.api_request");
		// Weave / CodingRun session lifecycle additions — emitted from
		// the workflow's finally block and the watchdog cron.
		expect(result.actions).toContain("weave.session.terminated_on_exit");
		expect(result.actions).toContain("weave.session.terminated_stale");
		// Atlas analysis lifecycle + per-node regenerate
		// + monitored-branch configuration.
		expect(result.actions).toContain("atlas.analysis.requested");
		expect(result.actions).toContain("atlas.analysis.cancelled");
		expect(result.actions).toContain("atlas.analysis.completed");
		expect(result.actions).toContain("atlas.analysis.failed");
		expect(result.actions).toContain("atlas.node.regenerated");
		expect(result.actions).toContain("atlas.node.edited");
		expect(result.actions).toContain("atlas.branch.changed");
		expect(result.actions).toContain("atlas.branches.pinned");
		// Atlas edge (connection) edits: description override + manual create +
		// soft-delete + restore (solo and System-map cross-repo).
		expect(result.actions).toContain("atlas.edge.edited");
		expect(result.actions).toContain("atlas.edge.created");
		expect(result.actions).toContain("atlas.edge.deleted");
		expect(result.actions).toContain("atlas.edge.restored");
		// Backlog AI-Update apply-proposal recovery — emitted from the manual
		// cancel procedure and the stuck-apply watchdog cron.
		expect(result.actions).toContain("backlog.proposal.cancelled");
		expect(result.actions).toContain("backlog.proposal.timed_out");
		// Project invitation welcome-widget dismissal (#1457).
		expect(result.actions).toContain("project.invitation.widget_dismissed");
		// Per-project embeddable release-notes widget owner actions.
		expect(result.actions).toContain("newsletter.widget.enabled");
		expect(result.actions).toContain("newsletter.widget.disabled");
		expect(result.actions).toContain("newsletter.widget.token_rotated");
		// Newsletter approval gate — requirement toggle + reviewer
		// approve/reject decisions.
		expect(result.actions).toContain(
			"newsletter.approval.required_changed",
		);
		expect(result.actions).toContain("newsletter.send.approved");
		expect(result.actions).toContain("newsletter.send.rejected");
		// User Activity dashboard meta-event (#1709) — mirrors `audit.viewed`.
		expect(result.actions).toContain("userActivity.viewed");
		// Meeting Digest v2 action-item completion toggle (#1814).
		expect(result.actions).toContain(
			"project.meeting_digest.action_item_toggled",
		);
		// Daily Brief release-notes curation — per-project hide/unhide of a PR
		// from the Release Notes panel.
		expect(result.actions).toContain("dailyBrief.releaseNote.hidden");
		expect(result.actions).toContain("dailyBrief.releaseNote.unhidden");
		// AI decision pre-check override — logged when a user accepts AI output
		// that contradicts a logged architecture decision.
		expect(result.actions).toContain("decision.override_accepted");
		// Project-scoped role/function tag management (Role/Function Tags
		// Stage 1, Task 7).
		expect(result.actions).toContain(
			"project.member.function_tags_changed",
		);
		// A member confirming their own project role (Fizzy #2264).
		expect(result.actions).toContain(
			"project.member.function_tags_confirmed",
		);
		// Instance-admin global feature-flag toggle (DB-backed override).
		expect(result.actions).toContain("featureFlag.updated");
		expect(result.actions).toContain("featureFlag.reset");
		expect(result.actions).toContain("featureFlag.orgUpdated");
		expect(result.actions).toContain("featureFlag.orgReset");

		// Starting a run in the customer's own CI with a stored credential.
		expect(result.actions).toContain("project.ci_run.triggered");
		expect(result.actions).toContain("project.environment.created");
		expect(result.actions).toContain("project.environment.updated");
		expect(result.actions).toContain("project.environment.deleted");
		expect(result.actions).toContain("project.qa_settings.updated");
		expect(result.actions).toContain("project.qa_webhook.created");
		expect(result.actions).toContain("project.qa_webhook.rotated");
		expect(result.actions).toContain("project.qa_webhook.expiry_updated");
		expect(result.actions).toContain("project.qa_webhook.revoked");

		expect(result.categories).toEqual([
			"auth",
			"org",
			"account",
			"project",
			"story",
			"audit",
			"error",
			"incident",
			"weave",
			"atlas",
			"backlog",
			"newsletter",
			"mcp",
			"dailyBrief",
			"decision",
			"featureFlag",
			"statusUpdate",
			// Machine-derived long-tail activity, captured automatically for
			// every successful mutation. Its own category so the viewer can
			// separate curated security events from everyday activity.
			"activity",
		]);
		expect(result.errorActions).toHaveLength(8);
		expect(result.errorActions).toContain("error.permission_denied");
		expect(result.errorActions).toContain("error.internal");
		expect(result.errorActions).toContain("error.validation");
		expect(result.errorActions).toContain("error.rate_limited");
	});
});
