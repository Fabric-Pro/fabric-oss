/**
 * Permission Coverage Guard
 * Static AST-lite check: every procedure file under `packages/api/modules/**`
 * that defines at least one `.handler(` must also declare a permission via
 * `requirePermission(..)` or `requireProjectPermission(..)` somewhere in the
 * file.
 * This test is the single regression guard that prevents new procedures from
 * landing without a permission declaration. If you're adding a new procedure
 * and this test fails on your file, add the appropriate decorator before
 * `.handler(..)`.
 * See also: `scripts/audit-procedure-permissions.ts` — same logic, usable as a
 * CLI for progress tracking during the initial backfill.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Permissions } from "@repo/permissions";
import { describe, expect, it } from "vitest";

const VALID_PERMISSION_KEYS = new Set(Object.keys(Permissions));

const repoRoot = resolve(__dirname, "../../..");
const modulesRoot = resolve(repoRoot, "packages/api/modules");

/**
 * Files explicitly allowed to define procedures without a permission decorator.
 * Each entry MUST have a justification. This list is intentionally short.
 */
const COVERAGE_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
	[
		"packages/api/modules/projects/procedures/members/accept-invitation.ts",
		// External guests with no org membership or active tenant context must
		// be able to accept. Authorization is enforced by the underlying
		// `acceptProjectInvitation` query which requires the invitation's
		// email to match the authenticated user's email.
		"guest accept flow — email match enforced in DB helper",
	],
	[
		"packages/api/modules/projects/procedures/members/decline-invitation.ts",
		// Mirror of accept — an invitee may decline even before they become a
		// member of anything. `declineProjectInvitation` enforces the email
		// match in the DB helper.
		"guest decline flow — email match enforced in DB helper",
	],
	[
		"packages/api/modules/projects/procedures/members/get-welcome-widget.ts",
		// Invitee self-service read of their own email-addressed invitations for
		// the dashboard widget. Authorization is the email match in the DB helper;
		// the invitee is by definition not yet a project member.
		"invitee self-read of own invitations — email match enforced in DB helper",
	],
	[
		"packages/api/modules/projects/procedures/members/dismiss-welcome-widget.ts",
		// Invitee self-service dismissal of their own welcome widget. The handler
		// verifies an in-scope PENDING invite (email match + XOR scope) before
		// writing; no project membership is required or assumed.
		"invitee self-dismiss — in-scope invite verified in handler",
	],
	[
		"packages/api/modules/organizations/procedures/is-guest.ts",
		// Guests (by definition) have no active org role and would fail any
		// permission check against the host org. This endpoint only returns
		// the caller's own membership status for a given org id — no sensitive
		// data — and is used by the frontend NavBar to decide chrome visibility.
		"guest status probe — self-information only, no tenant data",
	],
	[
		"packages/api/modules/organizations/procedures/get-guest-organization.ts",
		// Same justification as is-guest: guests cannot satisfy any org-role
		// permission check against the host org. Returns a thin org record
		// (id, slug, name, logo, metadata) ONLY when the caller is a verified
		// project-scoped guest in that org. Used by the client-side
		// ActiveOrganizationProvider fallback when Better Auth's
		// getFullOrganization rejects the guest.
		"guest org record — access verified inside handler via ProjectMember",
	],
	[
		"packages/api/modules/projects/procedures/list-guest-projects.ts",
		// Cross-org personal surface ("Shared with me"): lists projects where
		// the caller is a project-scoped guest (accepted ProjectMember row,
		// no org membership). Guests by definition fail any org permission
		// check against the host orgs. The `listGuestProjects` DB helper
		// scopes rows to the caller's own accepted, unexpired memberships,
		// so no foreign tenant data can leak.
		"guest project list — rows scoped to caller's own accepted memberships in DB helper",
	],
	[
		"packages/api/modules/auth/procedures/get-backup-codes-status.ts",
		// Self-info: returns whether the caller has 2FA backup codes.
		// `protectedProcedure` already requires authentication; the data is
		// scoped to the caller and carries no tenant info.
		"self-info — caller's own backup-code status, no tenant data",
	],
	[
		"packages/api/modules/auth/procedures/revoke-email-change.ts",
		// Self-action: revokes the caller's own pending email-change request,
		// scoped via the verification token. No org/project permission applies.
		"self-action — caller revokes own pending email change",
	],
	[
		"packages/api/modules/users/procedures/mfa-prompt/dismiss.ts",
		// Self-action: caller dismisses their own MFA-enrollment prompt
		// state. Scoped to the authenticated user by `protectedProcedure`.
		"self-action — caller dismisses own MFA prompt state",
	],
	[
		"packages/api/modules/users/procedures/mfa-prompt/get-state.ts",
		// Self-info: returns the caller's own MFA-prompt state. No tenant
		// data; scoped to the authenticated user by `protectedProcedure`.
		"self-info — caller's own MFA prompt state",
	],
	[
		"packages/api/modules/users/procedures/onboarding/get-state.ts",
		// Self-info: returns the caller's own "Get started" tour progress. No
		// tenant data; scoped to the authenticated user by `protectedProcedure`.
		"self-info — caller's own onboarding tour state",
	],
	[
		"packages/api/modules/users/procedures/onboarding/update.ts",
		// Self-action: caller advances their own onboarding tour progress.
		// Scoped to the authenticated user by `protectedProcedure`.
		"self-action — caller updates own onboarding tour state",
	],
	[
		"packages/api/modules/function-tags/procedures/get-my-default.ts",
		// Self-info: returns the caller's OWN default function tags
		// (`User.defaultFunctionTags`). Scoped to the authenticated user by
		// `protectedProcedure`; no tenant data and no project/org permission
		// applies. The ADMINISTRATIVE project-scoped function-tag procedures
		// (list-for-project / set-for-project-member) DO declare permissions;
		// the two self-service ones below deliberately do not.
		"self-info — caller's own default function tags",
	],
	[
		"packages/api/modules/function-tags/procedures/set-my-default.ts",
		// Self-action: caller sets their OWN default function tags. Scoped to
		// the authenticated user by `protectedProcedure`; no project/org
		// permission applies (mirrors onboarding/update.ts self-writes).
		"self-action — caller sets own default function tags",
	],
	[
		"packages/api/modules/function-tags/procedures/get-my-project-status.ts",
		// Self-info: returns the caller's OWN role-confirmation status on one
		// project (Fizzy #2264), and nothing else — so no permission key is a
		// meaningful gate here. (Not because PROJECT_MEMBERS_READ is an
		// administrator's key: it is not. It sits in VIEWER_ORG_PERMISSIONS
		// and VIEWER_PROJECT_PERMISSIONS in packages/permissions/lib/roles.ts
		// and is inherited by every higher role. Declaring it was not chosen
		// against because it is too strong, but because nobody has verified
		// that every caller who passes `hasProjectAccess` would also hold it —
		// owner-sourced access and ProjectMember rows with a null role are the
		// open cases — and swapping the gate on an unverified premise is the
		// same mistake in the other direction.) The boundary is the handler's
		// own `hasProjectAccess` check (project-authoritative: ownership or an
		// active membership) plus the `projectId_userId` composite key — there
		// is no `userId` input, so the caller can only ever read their own row.
		"self-info — caller's own confirmation status; hasProjectAccess + own-row key",
	],
	[
		"packages/api/modules/function-tags/procedures/confirm-for-project.ts",
		// Self-action: caller confirms their OWN role on one project (Fizzy
		// #2264). Gating this behind PROJECT_MEMBERS_MANAGE would mean only
		// administrators could confirm, which is the opposite of the intent —
		// and unlike PROJECT_MEMBERS_READ above, that key really is
		// administrator-only (ADMIN_ORG and PROJECT_ADMIN blocks only).
		//
		// Note what this procedure does NOT constrain: the VALUE. Any project
		// member may write an ARBITRARY tag set to the same column the admin
		// path writes behind PROJECT_MEMBERS_MANAGE — `confirmProjectUser-
		// FunctionTags` persists the submitted tags wholesale and never checks
		// them against what the row already held. That is deliberate and
		// spec'd (AC9: a member who selects roles DIFFERENT from the
		// pre-populated set has them saved and confirmed), and it is
		// safe only because function tags carry no authority: there are zero
		// FunctionTag references anywhere in packages/permissions. If a tag
		// ever gates a capability, this entry stops being true and the
		// procedure needs a real gate.
		//
		// `userId` comes from `context.user.id` and is never accepted from the
		// client, so the write can only ever land on the caller's own row —
		// pinned by "writes the CALLER's own row with the version it was
		// given" in procedures/__tests__/project.test.ts, which sends a
		// hostile `userId` and asserts it is ignored. `hasProjectAccess` runs
		// BEFORE the project lookup so the procedure is not a
		// project-existence oracle, and tenancy is derived from
		// `project.organizationId`, never from the session's active org.
		"self-action — caller confirms own role, any tag set; hasProjectAccess + own-row key",
	],
	[
		"packages/api/modules/integrations/procedures/teams-events.ts",
		// Status probe — publicProcedure that returns static metadata about
		// the Teams events webhook (endpoint URL, supported events). No tenant
		// data and no authenticated user to permission-check against.
		"public status probe — static metadata, no tenant data",
	],
	[
		"packages/api/modules/projects/procedures/code-indexing/github-webhook.ts",
		// GitHub push webhook — publicProcedure with HMAC-SHA256 signature
		// verification. No user session; tenant context is derived from the
		// ProjectRepositoryIntegration row matching the pushed repo.
		"webhook — HMAC-authenticated, no user session",
	],
	[
		"packages/api/modules/newsletter/procedures/unsubscribe.ts",
		// Public newsletter unsubscribe — rateLimitedPublicProcedure reached
		// from the one-click link in a release-notes email. External
		// stakeholders have no account or session, so no permission key can
		// apply. Authorization is the unguessable 32-byte `unsubscribeToken`
		// (base64url); the handler is idempotent and always returns success to
		// avoid a subscriber-existence leak. Mirrors teams-events.ts /
		// github-webhook.ts (public, no user session).
		"public unsubscribe — token-authenticated, no user session, no existence leak",
	],
	[
		"packages/api/modules/newsletter/procedures/subscribe-to-newsletter.ts",
		// Public double opt-in subscribe — rateLimitedPublicProcedure called from
		// the marketing opt-in widget. External visitors have no account or
		// session, so no permission key can apply. Hard-locked to
		// FABRIC_MAIN_PROJECT_ID (the client never sends a projectId); the handler
		// returns a generic success for every input to avoid a subscriber-existence
		// leak. Mirrors unsubscribe.ts (public, no user session).
		"public subscribe — no session, env-locked to Fabric-main, no existence leak",
	],
	[
		"packages/api/modules/newsletter/procedures/confirm-subscription.ts",
		// Public double opt-in confirm — rateLimitedPublicProcedure reached from
		// the one-click link in the confirm email. No account or session;
		// authorization is the unguessable 32-byte unsubscribeToken (reused as the
		// confirm token), which is the bearer credential AND resolves the project
		// (token-only, per-project — no FABRIC_MAIN_PROJECT_ID lock). The DB helper
		// owns the per-project revocation gate (widget enabled + token version).
		// Mirrors unsubscribe.ts (public, no user session).
		"public confirm — token-authenticated (per-project, token resolves project), no user session",
	],
	[
		"packages/api/modules/payments/procedures/ai-usage-limits/list.ts",
		// Tenant-scoped read of the caller's own AI usage limits.
		// `tenantProtectedProcedure` enforces auth + tenant context;
		// org-context callers below `owner|admin` receive `{ limits: [],
		// canManage: false }` instead of FORBIDDEN (b — mirrors
		// page-level guard so the procedure cannot leak row existence).
		// Precedent: is-guest.ts, get-guest-organization.ts.
		"self-scoped read — inline membership gate, empty payload for non-admins",
	],
	[
		"packages/api/modules/payments/procedures/ai-usage-limits/status.ts",
		// Same shape as list — returns live counter values for the caller's
		// own limits, gated the same way (b). No tenant data
		// leaks to non-admins.
		"self-scoped read — inline membership gate, empty payload for non-admins",
	],
	[
		"packages/api/modules/payments/procedures/ai-usage-limits/provider-options.ts",
		// Tenant-scoped read of the caller's own configured AI providers
		// and the catalogue of models reachable through them. Mirrors the
		// gating pattern in list.ts / status.ts: inline membership check,
		// empty payload for non-admin org members so the procedure cannot
		// leak which providers the org has set up.
		"self-scoped read — inline membership gate, empty payload for non-admins",
	],
	// =============================================================================
	// Customer-facing system health.
	//
	// The two READ procedures are intentionally open to every authenticated
	// user — the entire purpose of the surface is that a customer can tell a
	// platform problem from one on their own side without raising a support
	// ticket, so gating it behind a permission would defeat it. Tenant isolation
	// is still enforced: `getOverview` derives its scope from the session's
	// tenant context and never accepts a tenant identifier as input, and
	// `listHistory` returns only published platform announcements, which contain
	// no tenant data at all.
	//
	// The three AUTHORING procedures are `adminProcedure`: publishing text that
	// every customer reads is a platform-staff act, and the tables are GLOBAL, so
	// no per-tenant permission key applies.
	// =============================================================================
	[
		"packages/api/modules/system-health/procedures/get-overview.ts",
		"intentionally open to all authenticated users — tenant scope derived from session, never from input",
	],
	[
		"packages/api/modules/system-health/procedures/list-history.ts",
		"intentionally open to all authenticated users — published platform announcements carry no tenant data",
	],
	[
		"packages/api/modules/system-health/procedures/admin/publish.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/system-health/procedures/admin/append-revision.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/system-health/procedures/admin/list.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	// =============================================================================
	// Monitoring procedures. All are gated by `adminProcedure` — the role
	// check (`user.role === "admin"`) is the authoritative auth gate.
	// The new incident tables are GLOBAL and admin-owned; no
	// per-tenant permission key applies. Read procedures on integration health
	// are `protectedProcedure` because the data is non-tenant-scoped (a provider
	// outage affects every org equally).
	// =============================================================================
	[
		"packages/api/modules/incidents/procedures/list-error-rate-incidents.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/incidents/procedures/get-error-rate-incident.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/incidents/procedures/acknowledge-error-rate-incident.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/incidents/procedures/resolve-error-rate-incident.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/incidents/procedures/add-comment.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/incidents/procedures/list-events.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/incidents/procedures/list-incident-history.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/incidents/procedures/list-component-events.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/integration-health/procedures/list-provider-health.ts",
		"non-tenant-scoped read — provider health is global; protectedProcedure",
	],
	[
		"packages/api/modules/integration-health/procedures/get-provider-health.ts",
		"non-tenant-scoped read — provider health is global; protectedProcedure",
	],
	[
		"packages/api/modules/integration-health/procedures/get-provider-incidents.ts",
		"non-tenant-scoped read — provider history is global; protectedProcedure",
	],
	[
		"packages/api/modules/integration-health/procedures/list-active-incidents.ts",
		"non-tenant-scoped read — drives global banner; protectedProcedure",
	],
	[
		"packages/api/modules/integration-health/procedures/acknowledge-integration-incident.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/integration-health/procedures/resolve-integration-incident.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/integration-health/procedures/add-comment.ts",
		"admin-only — gated by adminProcedure; global table",
	],
	[
		"packages/api/modules/integration-health/procedures/list-events.ts",
		"admin-only — gated by adminProcedure; reveals actor identity for a global table",
	],
	[
		"packages/api/modules/audit/procedures/taxonomy.ts",
		// Static event-vocabulary dictionary for the filter chips. Returns
		// the closed taxonomy of action keys and categories — documented
		// in spec.md §6.3 and trivially derivable from the action emit
		// sites. No tenant data; both org admins and personal-context
		// users need the same dictionary. `protectedProcedure` enforces
		// authentication.
		"static taxonomy dictionary — no tenant data, documented in spec",
	],
	[
		"packages/api/modules/projects/procedures/documents/generate-document.ts",
		// Takes a document id, not a projectId, so `requireProjectPermission`
		// cannot read a project off the input. The org-level `requirePermission`
		// is the wrong gate twice over: it is skipped entirely in personal
		// tenant context, and it refuses an org `viewer` who holds an `EDITOR`
		// ProjectMember row, which the project-authoritative model grants.
		// The handler therefore calls `resolveEffectiveProjectPermissions` —
		// the same shared resolver the middleware uses, same A → C → B
		// precedence — and checks DOCUMENT_UPDATE against the result.
		"document-id input — handler gates on resolveEffectiveProjectPermissions",
	],
	// =============================================================================
	// Audit-log API key procedures. Each handles both org and personal
	// tenant contexts via `resolveAuditApiKeyTenant` (shared helper in
	// `list.ts`), which enforces:
	//   - personal context: caller can only manage keys they own
	//     (filtered by `userId`).
	//   - org context: `getOrganizationMembership` + role === "owner" |
	//     "admin" check inside the resolver, throws FORBIDDEN otherwise.
	// Using `requirePermission(ORG_API_KEYS_*)` would block personal
	// callers (who have no org permission). The split-mode handler is
	// the right pattern here; the exemption is justified by the inline
	// resolver doing the gating job.
	// =============================================================================
	[
		"packages/api/modules/audit/procedures/api-keys/list.ts",
		"split personal/org tenant — inline resolver enforces owner/admin for org context",
	],
	[
		"packages/api/modules/audit/procedures/api-keys/create.ts",
		"split personal/org tenant — inline resolver enforces owner/admin for org context",
	],
	[
		"packages/api/modules/audit/procedures/api-keys/rotate.ts",
		"split personal/org tenant — inline resolver enforces owner/admin for org context",
	],
	[
		"packages/api/modules/audit/procedures/api-keys/revoke.ts",
		"split personal/org tenant — inline resolver enforces owner/admin for org context",
	],
	// =============================================================================
	// Document-assistant lifecycle procedures (spec 2026-05-19 §5.4–§5.7).
	// Author-only writes that operate on a single `DocumentAssistantConversation`
	// row owned by the caller. The gate is row-level (`userId === currentUserId`)
	// and is enforced inline inside each handler before any mutation. No org-
	// or project-permission key applies — even an org owner cannot rename,
	// archive, delete, or change visibility on another user's conversation.
	// Tenant XOR + org-membership are still enforced via `tenantProtectedProcedure`
	// + inline `verifyOrganizationMembership`. Cross-tenant attempts return
	// NOT_FOUND (not FORBIDDEN) per spec FR-20 / AC-11 to avoid info leak.
	// =============================================================================
	[
		"packages/api/modules/agents/procedures/conversations/document-assistant/set-visibility-for-document.ts",
		"author-only — inline row-ownership check; visibility-lock invariant enforced by DB helper",
	],
	[
		"packages/api/modules/agents/procedures/conversations/document-assistant/archive-for-document.ts",
		"author-only — inline row-ownership check; sets archivedAt + AgentConversation.status in one tx",
	],
	[
		"packages/api/modules/agents/procedures/conversations/document-assistant/delete-for-document.ts",
		"author-only — inline row-ownership check; deletes the underlying AgentConversation (cascades the join)",
	],
	[
		"packages/api/modules/agents/procedures/conversations/document-assistant/rename-for-document.ts",
		"author-only — inline row-ownership check; updates AgentConversation.title only",
	],
]);

/**
 * Procedure builders that already compose a permission decorator (e.g.
 * `projectUsageProcedure` is `tenantProtectedProcedure.use(requireProjectPermission(..))`).
 * Files that derive from one of these inherit permission coverage even
 * though `require…(` doesn't appear literally in the procedure file.
 */
const PRE_GATED_PROCEDURE_BASES: ReadonlySet<string> = new Set([
	"projectUsageProcedure",
]);

type ProcedureFile = {
	file: string;
	procedureCount: number;
	hasPermissionDecorator: boolean;
};

function findProcedureFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (!entry.isFile()) {
			continue;
		}
		if (!entry.name.endsWith(".ts")) {
			continue;
		}
		if (entry.name.endsWith(".test.ts")) {
			continue;
		}
		const parentPath = (entry as unknown as { parentPath?: string })
			.parentPath;
		const dir = parentPath ?? entry.path ?? "";
		if (dir.includes(`${sep}__tests__${sep}`)) {
			continue;
		}
		if (
			!dir.includes(`${sep}procedures${sep}`) &&
			!dir.endsWith("procedures")
		) {
			continue;
		}
		out.push(resolve(dir, entry.name));
	}
	return out;
}

function scanProcedureFiles(): ProcedureFile[] {
	const absoluteFiles = findProcedureFiles(modulesRoot);
	const results: ProcedureFile[] = [];
	for (const absFile of absoluteFiles) {
		// Normalize to forward slashes so COVERAGE_EXEMPTIONS lookups work on
		// Windows too — `relative` returns native separators (`\`), but the
		// exemption keys use `/` (the canonical form).
		const file = relative(repoRoot, absFile).split(sep).join("/");
		const content = readFileSync(absFile, "utf-8");
		const handlerMatches = content.match(/\.handler\s*\(/g);
		const procedureCount = handlerMatches?.length ?? 0;
		if (procedureCount === 0) {
			continue;
		}

		// Any middleware whose name starts with `require` and ends in an
		// open paren counts: `requirePermission`, `requireProjectPermission`,
		// and `requirePermissionAllowGuest` all satisfy the coverage
		// invariant. New variants should be named with the same prefix.
		// Files derived from a pre-gated base (see PRE_GATED_PROCEDURE_BASES)
		// inherit permission coverage from the base.
		//
		// `assertProjectPermission` counts too, and is the one exception to the
		// naming rule. It is the same decision `requireProjectPermission`
		// makes — literally the function that middleware calls — but callable
		// from a HANDLER, which is the only place a procedure whose input names
		// a plan rather than a project can make it. The invariant this guard
		// protects is that a file declares a permission, not where it declares
		// one; a middleware-shaped name would be a lie about when it runs.
		const usesPreGatedBase = Array.from(PRE_GATED_PROCEDURE_BASES).some(
			(name) => new RegExp(`\\b${name}\\b`).test(content),
		);
		const hasPermissionDecorator =
			/\brequire[A-Z]\w*\s*\(/.test(content) ||
			/\bassertProjectPermission\s*\(/.test(content) ||
			usesPreGatedBase ||
			COVERAGE_EXEMPTIONS.has(file);

		results.push({ file, procedureCount, hasPermissionDecorator });
	}
	return results;
}

/**
 * Extract every `Permissions.X` reference from a file and return the list
 * of key names. Used by the typo-catching assertion below.
 */
function extractReferencedKeys(content: string): string[] {
	const keys: string[] = [];
	const re = /\bPermissions\.([A-Z][A-Z0-9_]*)\b/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
	while ((m = re.exec(content)) !== null) {
		keys.push(m[1]);
	}
	return keys;
}

describe("permission coverage", () => {
	it("every procedure file declares at least one permission", () => {
		const files = scanProcedureFiles();
		const missing = files.filter((f) => !f.hasPermissionDecorator);

		if (missing.length > 0) {
			const summary = missing
				.slice(0, 30)
				.map((f) => `  ${f.file}  (${f.procedureCount} proc)`)
				.join("\n");
			const more =
				missing.length > 30
					? `\n  ... and ${missing.length - 30} more files`
					: "";
			const totalMissingProcedures = missing.reduce(
				(sum, f) => sum + f.procedureCount,
				0,
			);
			throw new Error(
				`${missing.length} procedure files (${totalMissingProcedures} procedures) are missing a permission declaration.\n\n${summary}${more}\n\nRun: pnpm tsx scripts/audit-procedure-permissions.ts for the full list.\nAdd \`.use(requirePermission(KEY))\` or \`.use(requireProjectPermission(KEY))\` before \`.handler(...)\`.`,
			);
		}

		expect(missing.length).toBe(0);
	});

	it("audit detects at least one procedure per scanned file", () => {
		const files = scanProcedureFiles();
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			expect(f.procedureCount).toBeGreaterThan(0);
		}
	});

	it("every `Permissions.X` reference in a procedure points to a real key", () => {
		const absFiles = findProcedureFiles(modulesRoot);
		const unknown: Array<{ file: string; key: string }> = [];

		for (const absFile of absFiles) {
			const content = readFileSync(absFile, "utf-8");
			if (!content.includes("Permissions.")) {
				continue;
			}
			const keys = extractReferencedKeys(content);
			for (const key of keys) {
				if (!VALID_PERMISSION_KEYS.has(key)) {
					unknown.push({ file: relative(repoRoot, absFile), key });
				}
			}
		}

		if (unknown.length > 0) {
			const sample = unknown
				.slice(0, 20)
				.map(({ file, key }) => `  ${file}  →  Permissions.${key}`)
				.join("\n");
			const more =
				unknown.length > 20
					? `\n  ... and ${unknown.length - 20} more`
					: "";
			throw new Error(
				`${unknown.length} procedure file(s) reference permission keys that do not exist in the Permissions object. Typos? New keys that weren't added to packages/permissions/lib/permissions.ts?\n\n${sample}${more}`,
			);
		}

		expect(unknown.length).toBe(0);
	});

	it("every COVERAGE_EXEMPTIONS entry still points at a real file", () => {
		// An exemption outlives the file it excuses silently: the coverage
		// check only ever ASKS whether a path is in the map, so a key naming a
		// deleted or moved procedure is never consulted and never complained
		// about. It just sits there reading like a current security decision.
		// Worse, a RENAMED file arrives back at the coverage check as a brand
		// new un-exempted procedure and gets a fresh entry, leaving the stale
		// one behind as a second, contradictory record of the same decision.
		const stale = Array.from(COVERAGE_EXEMPTIONS.keys()).filter(
			(file) => !existsSync(join(repoRoot, file)),
		);

		if (stale.length > 0) {
			const summary = stale.map((file) => `  ${file}`).join("\n");
			throw new Error(
				`${stale.length} COVERAGE_EXEMPTIONS ${
					stale.length === 1
						? "entry names a file that no longer exists"
						: "entries name files that no longer exist"
				}. Delete the entry if the procedure is gone, or update the path if it moved — do not leave it as a record of a decision about nothing.\n\n${summary}`,
			);
		}

		expect(stale).toEqual([]);
	});
});
