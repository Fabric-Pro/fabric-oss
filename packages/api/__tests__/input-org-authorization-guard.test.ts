/**
 * SOC 2 CC6.1 / CC6.3 — cross-tenant authorization regression guard.
 *
 * THE BUG THIS PREVENTS: a procedure that resolves the target organization from
 * caller input (`resolveOrganizationId(input.organizationId, ...)`) and then
 * performs a tenant WRITE, gated only by `requirePermission(...)` — which checks
 * the caller's SESSION org role, NOT membership of the input org. Because the
 * app does not use RLS as an app-tier backstop, that let an admin of org A pass
 * `organizationId: <org B>` and mutate org B.
 *
 * THE RULE: any procedure file that (a) resolves the input org AND (b) performs
 * a tenant write must contain an authorization token that verifies membership of
 * the *resolved* org (or binds the record to the caller's tenant/project):
 *   - `requireInputOrgPermission(...)`  ← the preferred fix (membership + perm)
 *   - `requireOrganizationMembership` / `requireOrganizationAdmin`
 *   - `verifyOrganizationMembership` / `requireOrgMembership` / `getOrganizationMembership`
 *   - `requireProjectPermission` / `requirePermissionAllowGuest` / `hasProjectAccess`
 *   - `canManageWorkspace` / `hasWorkspaceAccess` / `getProjectMemberRole`
 *
 * If this test fails on your new procedure, do NOT add it to the allowlist to
 * silence it — add the correct authorization check. The allowlist is only for
 * procedures whose writes are provably scoped to the caller's own `userId`
 * (personal-context) and never to the input org, each with a justification.
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const modulesRoot = resolve(repoRoot, "packages/api/modules");

// Resolves the org FROM caller input (the risky source).
const INPUT_ORG_RE = /resolveOrganizationId\(\s*input\.organizationId/;
// A tenant write. Intentionally broad — a false positive is cheap to allowlist,
// a false negative is a cross-tenant bug.
const WRITE_RE = /\.(create|update|delete|updateMany|deleteMany|upsert)\s*\(/;
// Any accepted authorization/tenant-binding token.
const AUTH_TOKEN_RE =
	/\b(requireInputOrgPermission|requireOrganizationMembership|requireOrganizationAdmin|verifyOrganizationMembership|requireOrgMembership|getOrganizationMembership|requireProjectPermission|requirePermissionAllowGuest|hasProjectAccess|canManageWorkspace|hasWorkspaceAccess|getProjectMemberRole)\s*\(/;

/**
 * Files that resolve the input org and write, but are provably safe because the
 * write is scoped to the caller's own `userId` (personal context) and never to
 * the input org. Each MUST have a justification. Keep this list short.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
	// Weave execution/template rows are loaded via `findFirst({ where: { id,
	// userId, organizationId } })` and only then written by that verified id —
	// the userId in the WHERE binds the record to the caller.
	[
		"packages/api/modules/weave/procedures/cancel-execution.ts",
		"record loaded findFirst{id,userId,org} then written by verified id",
	],
	[
		"packages/api/modules/weave/procedures/get-execution.ts",
		"record loaded findFirst{id,userId,org} then reconciled by verified id",
	],
	[
		"packages/api/modules/weave/procedures/use-template.ts",
		"template loaded findFirst{id,userId,org} then written by verified id",
	],
	// Notification writes scope their WHERE by `userId` (and organizationId), so
	// a caller can never touch another recipient's/tenant's rows by id.
	[
		"packages/api/modules/notifications/procedures/archive.ts",
		"updateMany WHERE scoped by userId + organizationId",
	],
	[
		"packages/api/modules/notifications/procedures/mark-all-read.ts",
		"updateMany WHERE scoped by userId + organizationId",
	],
	[
		"packages/api/modules/notifications/procedures/restore.ts",
		"updateMany WHERE scoped by userId + organizationId",
	],
	// Inline org-membership check (db.member.findFirst{organizationId,userId})
	// + delete scoped to projects the caller owns.
	[
		"packages/api/modules/projects/procedures/bulk-delete-projects.ts",
		"inline org-membership check + delete scoped to owned project ids",
	],
	// Per-user view/preference rows: gated by getProjectAccessById(id, userId, org)
	// and upserted on the composite key projectId_userId (the caller's own row).
	[
		"packages/api/modules/projects/procedures/decisions-view.ts",
		"getProjectAccessById(userId,org) gate + upsert keyed by projectId_userId",
	],
	[
		"packages/api/modules/projects/procedures/roadmap-view.ts",
		"getProjectAccessById(userId,org) gate + upsert keyed by projectId_userId",
	],
	[
		"packages/api/modules/projects/procedures/kanban-user-preference.ts",
		"getProjectAccessById(userId,org) gate + upsert keyed by projectId_userId",
	],
	// In-memory per-process Map (no persistent tenant data). The DB-backed
	// equivalent (workflows/approval-templates) is membership-verified.
	[
		"packages/api/modules/orchestrator/procedures/approval-templates.ts",
		"in-memory Map stub, non-persistent; DB-backed variant secured separately",
	],
]);

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

describe("input-org authorization guard (SOC 2 CC6.1/CC6.3)", () => {
	it("every procedure that resolves the input org AND writes verifies membership of that org", () => {
		const offenders: string[] = [];
		for (const absFile of findProcedureFiles(modulesRoot)) {
			const content = readFileSync(absFile, "utf-8");
			if (!INPUT_ORG_RE.test(content)) {
				continue;
			}
			if (!WRITE_RE.test(content)) {
				continue;
			}
			if (AUTH_TOKEN_RE.test(content)) {
				continue;
			}
			const file = relative(repoRoot, absFile).split(sep).join("/");
			if (ALLOWLIST.has(file)) {
				continue;
			}
			offenders.push(file);
		}

		if (offenders.length > 0) {
			throw new Error(
				`${offenders.length} procedure file(s) resolve the input organization and perform a tenant write ` +
					"WITHOUT verifying membership of that org (cross-tenant IDOR risk):\n\n" +
					offenders.map((f) => `  ${f}`).join("\n") +
					"\n\nFix: gate the procedure with `requireInputOrgPermission(PERMISSION)` " +
					"(or an explicit membership/tenant check). Do NOT allowlist to silence a real gap.",
			);
		}

		expect(offenders.length).toBe(0);
	});
});
