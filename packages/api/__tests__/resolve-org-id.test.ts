/**
 * Verifies `resolveOrganizationId` fallback priority:
 *
 *   1. Explicit non-null input.organizationId (highest)
 *   2. Tenant context effectiveWriteOrgId
 *   3. Explicit null input → undefined
 *   4. Session activeOrganizationId
 *   5. undefined (lowest)
 *
 * Both the #2 > #3 and #2 > #4 orderings are security-critical for the
 * cross-org guest case — a cross-org admin invited as a guest to another
 * org's project must not have their writes land in their own active org,
 * AND personal-context pages must still route a guest's writes to the
 * host org (since guests land on personal-context pages with
 * `organizationId: null` in input because their session has no active
 * org). The permission middleware stashes the invited project's org on
 * the tenant context via `grantProjectAccess`, and that signal takes
 * precedence over both session and explicit-null input.
 */

import {
	createOrganizationContext,
	createPersonalContext,
	grantProjectAccess,
	runWithTenantContext,
} from "@repo/database/src/tenant-context";
import { describe, expect, it } from "vitest";
// procedures.ts imports @repo/database at module load via
// getOrganizationMembership, which pulls in the Prisma client. The
// test harness sets DATABASE_URL=postgres://test so the import succeeds
// without a running DB. Use a static top-level import so the cold-cache
// transform cost is paid once at file load (before any testTimeout
// window starts) instead of inside the first 3 test bodies.
import { resolveOrganizationId } from "../orpc/procedures";

async function getResolveOrganizationId() {
	return resolveOrganizationId;
}

describe("resolveOrganizationId fallback priority", () => {
	it("explicit input.organizationId wins over everything else", async () => {
		const resolveOrganizationId = await getResolveOrganizationId();
		const ctx = createOrganizationContext("orgA", "user-1");
		const result = await runWithTenantContext(ctx, async () => {
			grantProjectAccess("proj-X", "orgB");
			return resolveOrganizationId("orgC", {
				activeOrganizationId: "orgA",
			});
		});
		expect(result).toBe("orgC");
	});

	it("input null returns effectiveWriteOrgId when set (guest write path)", async () => {
		const resolveOrganizationId = await getResolveOrganizationId();
		const ctx = createPersonalContext("user-1");
		const result = await runWithTenantContext(ctx, async () => {
			grantProjectAccess("proj-X", "orgB");
			return resolveOrganizationId(null, {});
		});
		expect(result).toBe("orgB");
	});

	it("input null with no grant returns undefined (personal context)", async () => {
		const resolveOrganizationId = await getResolveOrganizationId();
		const ctx = createOrganizationContext("orgA", "user-1");
		const result = await runWithTenantContext(ctx, async () => {
			// no grantProjectAccess — explicit null means "don't fall back"
			return resolveOrganizationId(null, {
				activeOrganizationId: "orgA",
			});
		});
		expect(result).toBeUndefined();
	});

	it("effectiveWriteOrgId takes precedence over session (cross-org guest)", async () => {
		const resolveOrganizationId = await getResolveOrganizationId();
		const ctx = createOrganizationContext("orgA", "user-1");
		const result = await runWithTenantContext(ctx, async () => {
			grantProjectAccess("proj-X", "orgB");
			return resolveOrganizationId(undefined, {
				activeOrganizationId: "orgA",
			});
		});
		expect(result).toBe("orgB");
	});

	it("session.activeOrganizationId is used when no effectiveWriteOrgId is set", async () => {
		const resolveOrganizationId = await getResolveOrganizationId();
		const ctx = createOrganizationContext("orgA", "user-1");
		const result = await runWithTenantContext(ctx, async () => {
			// no grant — effectiveWriteOrgId stays null
			return resolveOrganizationId(undefined, {
				activeOrganizationId: "orgA",
			});
		});
		expect(result).toBe("orgA");
	});

	it("effectiveWriteOrgId is used for pure guests (no session org)", async () => {
		const resolveOrganizationId = await getResolveOrganizationId();
		const ctx = createPersonalContext("user-1");
		const result = await runWithTenantContext(ctx, async () => {
			grantProjectAccess("proj-X", "orgB");
			return resolveOrganizationId(undefined, {});
		});
		expect(result).toBe("orgB");
	});

	it("returns undefined when nothing is set", async () => {
		const resolveOrganizationId = await getResolveOrganizationId();
		const ctx = createPersonalContext("user-1");
		const result = await runWithTenantContext(ctx, async () => {
			return resolveOrganizationId(undefined, {});
		});
		expect(result).toBeUndefined();
	});
});
