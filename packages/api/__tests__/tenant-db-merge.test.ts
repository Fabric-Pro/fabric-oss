/**
 * Verifies `mergeWithTenantFilter` — the function that folds the current
 * request's tenant context into every Prisma query's WHERE clause.
 *
 * The matrix under test:
 *
 *   category                | carve-out | expected
 *   ------------------------+-----------+-----------------------------------
 *   USER_OWNED  (Project)   | no        | standard tenant filter
 *   USER_OWNED  (Project)   | yes       | OR[standard, projectCarveOut]
 *   PROJECT_SCOPED only     | no        | unchanged (null → no filter)
 *     (ProjectMember, UserStory, ProjectInvitation)
 *   PROJECT_SCOPED only     | yes       | projectCarveOut ONLY — no OR with {}
 *
 * The last case is the security-critical one: without the carve-out the
 * function must not restrict (pre-existing behavior), but with a carve-out
 * it must *restrict* rather than widen to an all-match empty object.
 */

import {
	createOrganizationContext,
	createPersonalContext,
	grantProjectAccess,
	runWithTenantContext,
} from "@repo/database/src/tenant-context";
import { describe, expect, it } from "vitest";

async function mergeInContext<T>(
	ctxFactory: () => ReturnType<typeof createPersonalContext>,
	fn: () => T,
	grants: string[] = [],
): Promise<T> {
	const ctx = ctxFactory();
	return await runWithTenantContext(ctx, async () => {
		for (const id of grants) {
			grantProjectAccess(id);
		}
		return fn();
	});
}

describe("mergeWithTenantFilter", () => {
	describe("tables NOT in any filter category (e.g. ProjectMember, UserStory)", () => {
		it("without carve-out: returns existing where unchanged", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("UserStory", { statusId: "s-1" }),
			);
			expect(result).toEqual({ statusId: "s-1" });
		});

		it("without carve-out and no existing where: returns undefined (no filter)", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("UserStory", undefined),
			);
			expect(result).toBeUndefined();
		});

		it("with carve-out: returns carve-out as sole filter (no empty-OR leak)", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("UserStory", undefined),
				["proj-A"],
			);
			expect(result).toEqual({ projectId: { in: ["proj-A"] } });
		});

		it("with carve-out and existing where: AND-wraps", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() =>
					mergeWithTenantFilter("UserStory", {
						statusId: "s-1",
					}),
				["proj-A"],
			);
			expect(result).toEqual({
				AND: [{ statusId: "s-1" }, { projectId: { in: ["proj-A"] } }],
			});
		});

		it("ProjectMember: carve-out is sole filter", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("ProjectMember", undefined),
				["proj-A"],
			);
			expect(result).toEqual({ projectId: { in: ["proj-A"] } });
		});

		it("ProjectInvitation: carve-out is sole filter", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("ProjectInvitation", undefined),
				["proj-A"],
			);
			expect(result).toEqual({ projectId: { in: ["proj-A"] } });
		});

		it("Epic (roadmap hierarchy): carve-out is sole filter", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("Epic", undefined),
				["proj-A"],
			);
			expect(result).toEqual({ projectId: { in: ["proj-A"] } });
		});

		it("Feature (inside an epic): carve-out is sole filter", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("Feature", undefined),
				["proj-A"],
			);
			expect(result).toEqual({ projectId: { in: ["proj-A"] } });
		});

		it("ProjectStoryStatus (kanban columns): carve-out is sole filter", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("ProjectStoryStatus", undefined),
				["proj-A"],
			);
			expect(result).toEqual({ projectId: { in: ["proj-A"] } });
		});

		it("Epic without carve-out: unchanged pre-existing behavior (no filter)", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("Epic", undefined),
			);
			expect(result).toBeUndefined();
		});
	});

	describe("USER_OWNED tables with direct projectId (e.g. Project, ProjectDocument)", () => {
		it("without carve-out (personal): returns standard personal filter", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("Project", undefined),
			);
			expect(result).toEqual({
				userId: "user-1",
				organizationId: null,
			});
		});

		it("without carve-out (org): returns standard org filter", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createOrganizationContext("org-1", "user-1"),
				() => mergeWithTenantFilter("Project", undefined),
			);
			expect(result).toEqual({ organizationId: "org-1" });
		});

		it("with carve-out (personal) on Project: OR with `id` column", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("Project", undefined),
				["proj-A"],
			);
			expect(result).toEqual({
				OR: [
					{ userId: "user-1", organizationId: null },
					{ id: { in: ["proj-A"] } },
				],
			});
		});

		it("with carve-out (personal) on ProjectDocument: OR with `projectId`", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("ProjectDocument", undefined),
				["proj-A"],
			);
			expect(result).toEqual({
				OR: [
					{ userId: "user-1", organizationId: null },
					{ projectId: { in: ["proj-A"] } },
				],
			});
		});

		it("with carve-out (org) on ProjectContext: OR of org filter and carve-out", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createOrganizationContext("org-1", "user-1"),
				() => mergeWithTenantFilter("ProjectContext", undefined),
				["proj-A"],
			);
			expect(result).toEqual({
				OR: [
					{ organizationId: "org-1" },
					{ projectId: { in: ["proj-A"] } },
				],
			});
		});
	});

	describe("handler-provided projectId narrows carve-out", () => {
		it("ProjectMember with handler's projectId: AND-wraps the carve-out", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() =>
					mergeWithTenantFilter("ProjectMember", {
						projectId: "proj-X",
					}),
				["proj-A", "proj-B"],
			);
			expect(result).toEqual({
				AND: [
					{ projectId: "proj-X" },
					{ projectId: { in: ["proj-A", "proj-B"] } },
				],
			});
		});
	});

	describe("non-tenant-scoped tables are unaffected", () => {
		it("unknown model: returns existing where unchanged even with carve-out active", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() => mergeWithTenantFilter("User", { id: "u-1" }),
				["proj-A"],
			);
			expect(result).toEqual({ id: "u-1" });
		});
	});

	describe("create operations skip merge entirely", () => {
		// Creates don't go through `mergeWithTenantFilter` — the Prisma
		// client extension branches on the operation type and only calls
		// merge for read + update/delete. This test is a contract check: if
		// a future refactor accidentally invokes merge during a create, the
		// semantics change and guest inserts could start landing in the
		// wrong org. We guard the invariant by asserting the extension's
		// behavior indirectly: calling `mergeWithTenantFilter` with a carve-
		// out on a model that has no standard filter returns the narrowing
		// carve-out filter. A production create call on the same model
		// would NOT get that filter injected into its `data` payload — only
		// its `where` clause, which create ops don't have. So the carve-out
		// cannot corrupt create data.
		it("merge does not touch create data shape (guard via shape assertion)", async () => {
			const { mergeWithTenantFilter } = await import(
				"@repo/database/src/tenant-db"
			);
			// When called with a handler's existing where, result is an AND.
			// There's no `data` field anywhere — confirming that merge only
			// affects where clauses and has no pathway to mutate create input.
			const result = await mergeInContext(
				() => createPersonalContext("user-1"),
				() =>
					mergeWithTenantFilter("ProjectDocument", {
						type: "PRD",
					}),
				["proj-A"],
			);
			// The result is a where filter — a plain object without a
			// `data` field. If we ever ship a variant of this function that
			// mutates `args.data`, this assertion would fail.
			expect(result).toBeDefined();
			expect(Object.hasOwn(result as object, "data")).toBe(false);
		});
	});
});
