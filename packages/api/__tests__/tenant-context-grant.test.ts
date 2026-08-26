/**
 * Verifies the project carve-out plumbing: when `grantProjectAccess` is
 * called inside a tenant-context-scoped run, the mutation is visible to
 * subsequent `getTenantContext()` calls in the same run.
 *
 * This is the mechanism that lets the permission middleware seed a
 * per-request carve-out that tenant-db.ts consults during filter generation.
 */

// Import from the tenant-context module directly to avoid pulling in the
// Prisma client via the package index (which requires DATABASE_URL at import
// time and breaks in the unit-test environment).
import {
	createOrganizationContext,
	createPersonalContext,
	getTenantContext,
	grantProjectAccess,
	runWithTenantContext,
} from "@repo/database/src/tenant-context";
import { describe, expect, it } from "vitest";

describe("grantProjectAccess", () => {
	it("seeds allowedProjectIds on the current tenant context", async () => {
		const ctx = createPersonalContext("user-1");
		await runWithTenantContext(ctx, async () => {
			expect(getTenantContext().allowedProjectIds).toEqual([]);
			grantProjectAccess("proj-A");
			expect(getTenantContext().allowedProjectIds).toEqual(["proj-A"]);
		});
	});

	it("accumulates multiple grants within the same run", async () => {
		const ctx = createPersonalContext("user-1");
		await runWithTenantContext(ctx, async () => {
			grantProjectAccess("proj-A");
			grantProjectAccess("proj-B");
			grantProjectAccess("proj-C");
			expect(getTenantContext().allowedProjectIds).toEqual([
				"proj-A",
				"proj-B",
				"proj-C",
			]);
		});
	});

	it("deduplicates repeated grants of the same project", async () => {
		const ctx = createPersonalContext("user-1");
		await runWithTenantContext(ctx, async () => {
			grantProjectAccess("proj-A");
			grantProjectAccess("proj-A");
			grantProjectAccess("proj-A");
			expect(getTenantContext().allowedProjectIds).toEqual(["proj-A"]);
		});
	});

	it("works in organization context as well as personal", async () => {
		const ctx = createOrganizationContext("org-1", "user-1");
		await runWithTenantContext(ctx, async () => {
			grantProjectAccess("proj-A");
			const current = getTenantContext();
			expect(current.type).toBe("organization");
			expect(current.organizationId).toBe("org-1");
			expect(current.allowedProjectIds).toEqual(["proj-A"]);
		});
	});

	it("does not leak grants across separate runs", async () => {
		const a = createPersonalContext("user-1");
		const b = createPersonalContext("user-2");
		await runWithTenantContext(a, async () => {
			grantProjectAccess("proj-A");
		});
		await runWithTenantContext(b, async () => {
			expect(getTenantContext().allowedProjectIds).toEqual([]);
		});
	});

	it("no-op when called outside any tenant context", () => {
		// Should not throw — default context has no storage.
		expect(() => grantProjectAccess("proj-A")).not.toThrow();
	});

	it("populates effectiveWriteOrgId when the grant carries an org id", async () => {
		const ctx = createPersonalContext("user-1");
		await runWithTenantContext(ctx, async () => {
			expect(getTenantContext().effectiveWriteOrgId).toBeNull();
			grantProjectAccess("proj-A", "org-host");
			expect(getTenantContext().effectiveWriteOrgId).toBe("org-host");
		});
	});

	it("same-org regrant is idempotent", async () => {
		const ctx = createPersonalContext("user-1");
		await runWithTenantContext(ctx, async () => {
			grantProjectAccess("proj-A", "org-host");
			grantProjectAccess("proj-B", "org-host");
			expect(getTenantContext().effectiveWriteOrgId).toBe("org-host");
			expect(getTenantContext().allowedProjectIds).toEqual([
				"proj-A",
				"proj-B",
			]);
		});
	});

	it("throws when a second grant targets a different organization", async () => {
		const ctx = createPersonalContext("user-1");
		await runWithTenantContext(ctx, async () => {
			grantProjectAccess("proj-A", "org-first");
			expect(() => grantProjectAccess("proj-B", "org-second")).toThrow(
				/multiple organizations/,
			);
			// Original value is preserved even after the throw.
			expect(getTenantContext().effectiveWriteOrgId).toBe("org-first");
		});
	});

	it("null org id does not overwrite a previously set effectiveWriteOrgId", async () => {
		const ctx = createPersonalContext("user-1");
		await runWithTenantContext(ctx, async () => {
			grantProjectAccess("proj-A", "org-host");
			grantProjectAccess("proj-B", null);
			expect(getTenantContext().effectiveWriteOrgId).toBe("org-host");
		});
	});

	it("throws TypeError if the context was created with a frozen array (API contract)", async () => {
		const frozen = Object.freeze([]) as string[];
		const ctx = {
			...createPersonalContext("user-1"),
			allowedProjectIds: frozen,
		};
		await runWithTenantContext(ctx, async () => {
			expect(() => grantProjectAccess("proj-A")).toThrow(TypeError);
		});
	});
});
