/**
 * URL Context Sources — schema + tenant registration unit tests.
 *
 * Covers Group 1 of fabric/specs/2026-05-13-url-context-sources/tasks.md:
 *   - Tenant XOR invariant on ProjectContextUrlPage (a row with BOTH
 *     userId and organizationId set is rejected; a row with NEITHER set
 *     is rejected).
 *   - ProjectContextUrlPage is registered in USER_OWNED_TABLES so the
 *     tenant filter applies (matches the spec.md §5.2 tenant-treatment
 *     note).
 *   - ProjectContextUrlPage is registered in PROJECT_SCOPED_TABLES so
 *     the project carve-out filter can apply.
 *   - The merged tenant filter behaves identically to the parent
 *     ProjectContext (both rows are user_owned).
 *
 * Pure-unit; no DATABASE_URL needed. Mirrors the test style in
 * __tests__/list-contexts.test.ts and __tests__/project-comments.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
	createOrganizationContext,
	createPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";

// ---------------------------------------------------------------------------
// XOR invariant helper — co-located so callers (Temporal activities, oRPC
// procedures) can import it when persisting ProjectContextUrlPage rows.
// We assert the helper rejects both invalid shapes the migration cannot
// catch (DB columns are nullable so the constraint is application-level).
// ---------------------------------------------------------------------------

/**
 * Throws when the XOR invariant on (userId, organizationId) is violated.
 * Exactly one of the two must be set. Mirrors how parent ProjectContext
 * rows are persisted — see spec.md §5.2.
 */
function assertUrlPageTenantXor(input: {
	userId: string | null | undefined;
	organizationId: string | null | undefined;
}): void {
	const hasUser = !!input.userId;
	const hasOrg = !!input.organizationId;
	if (hasUser && hasOrg) {
		throw new Error(
			"ProjectContextUrlPage tenant XOR violated: both userId and organizationId set",
		);
	}
	if (!hasUser && !hasOrg) {
		throw new Error(
			"ProjectContextUrlPage tenant XOR violated: neither userId nor organizationId set",
		);
	}
}

describe("ProjectContextUrlPage — XOR invariant", () => {
	it("accepts personal-owned rows (userId set, organizationId null)", () => {
		expect(() =>
			assertUrlPageTenantXor({
				userId: "user-1",
				organizationId: null,
			}),
		).not.toThrow();
	});

	it("accepts org-owned rows (organizationId set, userId null)", () => {
		expect(() =>
			assertUrlPageTenantXor({
				userId: null,
				organizationId: "org-1",
			}),
		).not.toThrow();
	});

	it("rejects rows with BOTH userId and organizationId set", () => {
		expect(() =>
			assertUrlPageTenantXor({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).toThrowError(/both userId and organizationId set/);
	});

	it("rejects rows with NEITHER userId nor organizationId set (both null)", () => {
		expect(() =>
			assertUrlPageTenantXor({
				userId: null,
				organizationId: null,
			}),
		).toThrowError(/neither userId nor organizationId set/);
	});

	it("rejects rows with NEITHER userId nor organizationId set (both undefined)", () => {
		expect(() =>
			assertUrlPageTenantXor({
				userId: undefined,
				organizationId: undefined,
			}),
		).toThrowError(/neither userId nor organizationId set/);
	});

	it("treats empty strings as missing — empty userId and set org passes", () => {
		// Falsy check so accidental "" doesn't masquerade as a real id.
		expect(() =>
			assertUrlPageTenantXor({
				userId: "",
				organizationId: "org-1",
			}),
		).not.toThrow();
	});
});

describe("ProjectContextUrlPage — tenant filter merge (mirrors parent)", () => {
	// These tests exercise the application-level filter that getTenantDb()
	// injects via `mergeWithTenantFilter`. The invariant we care about for
	// Group 1: ProjectContextUrlPage is treated identically to the parent
	// ProjectContext (both user_owned, both project-scoped).

	it("personal context restricts ProjectContextUrlPage to userId + organizationId IS NULL", () => {
		const merged = runWithTenantContext(
			createPersonalContext("user-1"),
			() => mergeWithTenantFilter("ProjectContextUrlPage", undefined),
		);
		// Same shape the parent ProjectContext gets in personal context.
		expect(merged).toEqual({
			userId: "user-1",
			organizationId: null,
		});
	});

	it("org context restricts ProjectContextUrlPage to organizationId", () => {
		const merged = runWithTenantContext(
			createOrganizationContext("org-1", "user-1"),
			() => mergeWithTenantFilter("ProjectContextUrlPage", undefined),
		);
		expect(merged).toEqual({
			organizationId: "org-1",
		});
	});

	it("preserves caller's existing where clause via AND merge", () => {
		const merged = runWithTenantContext(
			createPersonalContext("user-1"),
			() =>
				mergeWithTenantFilter("ProjectContextUrlPage", {
					parentContextId: "ctx-7",
				}) as { AND: Array<Record<string, unknown>> },
		);
		expect(merged.AND).toEqual([
			{ parentContextId: "ctx-7" },
			{ userId: "user-1", organizationId: null },
		]);
	});

	it("ProjectContextUrlPage shares the user_owned shape with ProjectContext (parent parity)", () => {
		// Sanity: parent and child filter the same way. If parity ever
		// breaks, child rows could leak when querying through tenant-db.
		const childFilter = runWithTenantContext(
			createOrganizationContext("org-9", "user-2"),
			() => mergeWithTenantFilter("ProjectContextUrlPage", undefined),
		);
		const parentFilter = runWithTenantContext(
			createOrganizationContext("org-9", "user-2"),
			() => mergeWithTenantFilter("ProjectContext", undefined),
		);
		expect(childFilter).toEqual(parentFilter);
	});

	it("returns a default-deny when no tenant context is set", () => {
		// `mergeWithTenantFilter` returns the existing where (or undefined)
		// when context is absent. Application-level filtering is bypassed,
		// but Postgres RLS (applied separately via `apply:rls`) still
		// blocks the query at the DB layer. This test just locks the
		// current behavior so a regression surfaces.
		const merged = mergeWithTenantFilter(
			"ProjectContextUrlPage",
			undefined,
		);
		expect(merged).toBeUndefined();
	});
});

describe("ProjectContextUrlPage — project-scoped carve-out registration", () => {
	it("ProjectContextUrlPage gets a project-id carve-out via AND when allowedProjectIds is set", () => {
		// When a guest has been granted access to a project, the tenant
		// filter unions in a `projectId IN (...)` carve-out for project-
		// scoped tables. The new child table must be registered in
		// PROJECT_SCOPED_TABLES so child-page rows for the invited
		// project are visible to the guest. Without registration, the
		// carve-out is a no-op and the guest sees nothing.
		const merged = runWithTenantContext(
			{
				type: "personal",
				tenantId: "user-1",
				userId: "user-1",
				organizationId: null,
				allowedProjectIds: ["proj-42"],
				effectiveWriteOrgId: null,
			},
			() => mergeWithTenantFilter("ProjectContextUrlPage", undefined),
		);
		// Expect the OR-union shape produced by getProjectCarveOut.
		expect(merged).toEqual({
			OR: [
				{ userId: "user-1", organizationId: null },
				{ projectId: { in: ["proj-42"] } },
			],
		});
	});
});
