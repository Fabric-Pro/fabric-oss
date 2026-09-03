/**
 * A `requirePermission(...)` that cannot evaluate is not a gate.
 *
 * The middleware returns `next()` unconditionally when the request has no
 * tenant context — and only the tenant-aware procedure builder supplies one.
 * So on any other builder the call reads as a role check, renders as a role
 * check in review, and enforces nothing.
 *
 * `public-procedure-allowlist.test.ts` covers the `publicProcedure` half of
 * this, where the endpoint is also unauthenticated. This file covers the rest:
 * procedures that DO authenticate a user and then perform an organization-
 * scoped operation with the role check inert.
 *
 * That gap is not theoretical. The weave procedures resolved an organization
 * from caller-supplied input and wrote it onto rows in a tenancy class whose
 * organization reads carry no per-user predicate — so a caller could choose the
 * tenant their content landed in. Both halves are closed now: membership by
 * `resolveOrganizationIdForCaller`, and the role by `requireInputOrgPermission`,
 * which all nineteen now use.
 *
 * Moving them to `tenantProtectedProcedure` would have been the WRONG exit, and
 * is worth recording because it is the obvious one. That builder derives the
 * tenant from `session.activeOrganizationId`, while these handlers act on the
 * organization in their INPUT. The permission would then have evaluated against
 * a different organization than the one being written to — an owner of A could
 * pass B and satisfy the check with their A role. A check against the wrong
 * tenant is worse than one that does not run, because it looks like it did.
 *
 * Two lists, deliberately separate:
 *
 *   ACCEPTED        reviewed, with the reason written down.
 *   PENDING_REVIEW  inert before this test existed. Frozen, not endorsed.
 *
 * The pending list may only shrink, and it has reached empty. Everything on it
 * moved to `requireInputOrgPermission`; what remains in ACCEPTED is inert on
 * purpose, each with its reason. Nothing new joins either list without one.
 *
 * Run with:
 *   pnpm --filter @repo/api test orpc/__tests__/inert-permission-guard.test.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODULES = join(__dirname, "..", "..", "modules");

/** Reviewed: the permission call is inert here, and that is correct. */
const ACCEPTED: Record<string, string> = {
	"admin/procedures/ai-adoption.ts":
		"adminProcedure gates on deployment admin, which is a different axis from an organization role — and these read across tenants by design.",
	"admin/procedures/audit-log-via-api-key.ts": "As ai-adoption.",
	"admin/procedures/feature-flags.ts":
		"As ai-adoption; feature flags are instance-wide and have no tenant.",
	"admin/procedures/find-organization.ts": "As ai-adoption.",
	"admin/procedures/list-organizations.ts": "As ai-adoption.",
	"admin/procedures/list-users.ts": "As ai-adoption.",
	"admin/procedures/org-feature-flags.ts":
		"As ai-adoption, but for a different reason than its instance-wide sibling: these DO take an organizationId. It is the SUBJECT of the edit, not the caller's tenant. `requireInputOrgPermission` would be the usual exit and is wrong here — it would demand the instance admin hold a role in the organization being enrolled, so an operator could only grant a feature to organizations they already belong to, which is the opposite of the control. Authorization is adminProcedure's instance-admin gate; the override table is an instance-admin control table with no tenant of its own.",
	"agent-templates/procedures/templates/create.ts":
		"adminProcedure; the agent-template catalog is deployment-wide, not owned by a tenant.",
	"agent-templates/procedures/templates/delete.ts": "As template create.",
	"agent-templates/procedures/templates/update.ts": "As template create.",
	"users/procedures/update-last-active-workspace.ts":
		"Writes one column on the caller's own user row. Account-global by construction, so there is no organization role to evaluate.",
};

/**
 * Inert before this test existed. NOT reviewed and NOT endorsed — recorded so
 * the surface is visible and cannot grow.
 *
 * Each authenticates a user and then acts in an organization without the role
 * check the `requirePermission(...)` beside it appears to make. They need
 * someone to decide, per procedure, whether the operation needs a role at all
 * and which one. Moving a file onto the tenant-aware builder removes it from
 * this sweep entirely, which is the intended exit.
 */
const PENDING_REVIEW: Record<string, string> = {
	// EMPTY, and the ratchet below holds it there.
	//
	// It reached zero once before on a wrong fix and had to come back up; this
	// time each of the twenty-nine went out by the exit that fits its shape,
	// and the shapes are genuinely different:
	//
	//   - Org-scoped, organization in the input → `requireInputOrgPermission`,
	//     which resolves the SAME organization the handler acts on. With
	//     `requireOrganization: true`, or an explicit `organizationId: null`
	//     walks past it.
	//   - Project-scoped, project in the input → `requireProjectPermission`,
	//     object-level and guest-aware.
	//   - Project-scoped, only a PLAN in the input → `assertProjectPermission`
	//     in the handler, after the plan resolves its project. No middleware
	//     can see that project, which is why these were last.
	//
	// What it means for a guest was ruled, not inherited: no project role
	// grants AGENT_CREATE / UPDATE / DELETE, so a project-scoped guest can read
	// weave plans and start executions and cannot approve, revise or delete
	// one. Cancelling a run moved from AGENT_DELETE to AGENT_UPDATE with it —
	// stopping something is a state change, not a deletion, and admin-only
	// cancellation would have locked out the member who started the run.
	//
	// A new entry here means a procedure was added with an inert check and NOT
	// decided. Prefer fixing it to listing it.
};

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "__tests__") {
			continue;
		}
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (entry.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

const rel = (file: string) =>
	file
		.slice(MODULES.length + 1)
		.split("\\")
		.join("/");

/**
 * Files that call `requirePermission` while building on a builder that supplies
 * no tenant context. `publicProcedure` files are excluded: the sibling sweep
 * owns those, and listing them twice would let one list go stale unnoticed.
 */
function inertPermissionFiles(): string[] {
	const hits: string[] = [];
	for (const file of walk(MODULES)) {
		const source = readFileSync(file, "utf8");
		// BOTH middlewares, not just the first. `requirePermissionAllowGuest`
		// carries the identical inert pass-through — `!context.tenantContext ||
		// type === "personal"` then `return next()` — and a substring test for
		// `requirePermission(` never matches it, because the character after
		// the name is `A` and not `(`. The sweep read as covering the whole
		// class while covering half of it.
		if (!/requirePermission(?:AllowGuest)?\(/.test(source)) {
			continue;
		}
		// KNOWN LIMITATION, stated rather than hidden: this exemption is
		// file-granular. A file that builds even one procedure on
		// `tenantProtectedProcedure` drops out entirely, so a mixed-builder
		// file takes its `protectedProcedure` siblings out of the sweep with
		// it. Making it per-procedure needs parsing rather than grepping. The
		// surface is clean today — checked when this was written — so the gap
		// is in what the ratchet would catch next, not in what it holds now.
		if (/(?::|=)\s*tenantProtectedProcedure\b/.test(source)) {
			continue;
		}
		if (/(?::|=)\s*publicProcedure\b/.test(source)) {
			continue;
		}
		hits.push(rel(file));
	}
	return hits.sort();
}

describe("permission checks that cannot evaluate", () => {
	const found = inertPermissionFiles();

	it("found some to check", () => {
		// Guards the guard. A sweep that matches nothing makes every assertion
		// below vacuous, which is how this class of bug survives review.
		//
		// It used to assert a count above the pending list's size. The pending
		// list is empty now, so a count says nothing — what proves the sweep
		// still runs is that it finds the files we KNOW are inert on purpose.
		expect(found).toContain("admin/procedures/ai-adoption.ts");
		expect(found.length).toBeGreaterThanOrEqual(
			Object.keys(ACCEPTED).length,
		);
	});

	it("has a written reason for every one", () => {
		const undocumented = found.filter(
			(f) => !(f in ACCEPTED) && !(f in PENDING_REVIEW),
		);

		expect(
			undocumented,
			`Calls requirePermission() on a builder that supplies no tenant context, so the check returns next() unconditionally and enforces nothing. Either build it on tenantProtectedProcedure, or add it to ACCEPTED with the reason it needs no role:\n  ${undocumented.join("\n  ")}`,
		).toEqual([]);
	});

	it("keeps no stale entries", () => {
		const listed = [
			...Object.keys(ACCEPTED),
			...Object.keys(PENDING_REVIEW),
		];
		const stale = listed.filter((f) => !found.includes(f));
		expect(
			stale,
			`Listed here but no longer matching — remove the entry, or it will quietly re-admit the file later:\n  ${stale.join("\n  ")}`,
		).toEqual([]);
	});

	it("does not let the pending-review list grow", () => {
		// Zero, reached a second time and this time by the right exits. It may
		// not rise: a rise means undecided surface was added quietly, which is
		// the only thing this file has ever been for.
		expect(Object.keys(PENDING_REVIEW).length).toBeLessThanOrEqual(0);
	});
});
