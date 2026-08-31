/**
 * Regression tests for the `requireInputOrgPermission` middleware — the SOC 2
 * CC6.1 / CC6.3 fix for cross-tenant (broken-object-level) authorization.
 *
 * The vulnerability it closes: `requirePermission` only evaluates the caller's
 * SESSION org role (`context.activeOrganizationRole`, set by
 * tenantContextMiddleware from `session.activeOrganizationId`). A handler that
 * acts on an org taken from `input.organizationId` could therefore be driven
 * cross-tenant — an admin of org A passes `organizationId: <org B>` and their
 * org-A role satisfies the check while the handler mutates org B. This
 * middleware verifies membership AND permission against the RESOLVED INPUT org.
 *
 * Pinned behaviours:
 *  1. Personal context (resolved org undefined) → pass-through, no DB lookup.
 *  2. Non-member of the resolved input org → FORBIDDEN (the core fix), and the
 *     membership lookup targets the INPUT org, not the session org.
 *  3. Member whose role grants the permission → next().
 *  4. Member whose role lacks the permission → FORBIDDEN (mirrors requirePermission).
 *  5. Under RBAC_DRY_RUN the role-permission denial is downgraded to a warning,
 *     but a NON-MEMBER is still hard-blocked (a tenant boundary is never dry-run).
 */

import { Permissions } from "@repo/permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(() => ({ effectiveWriteOrgId: undefined })),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: vi.fn() },
		member: { findFirst: vi.fn(), findUnique: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
	grantProjectAccess: vi.fn(),
	getOrganizationMembership: mocks.getOrganizationMembership,
	getTenantContext: mocks.getTenantContext,
}));

async function loadMiddleware() {
	const mod = await import("../orpc/middleware/require-permission");
	return mod.requireInputOrgPermission;
}

const USER_ID = "user-1";
const SESSION_ORG = "org-A"; // the caller's own org (where they are admin)
const VICTIM_ORG = "org-B"; // a different tenant

type Ctx = {
	user?: { id: string };
	session: { activeOrganizationId?: string | null };
	tenantContext?: {
		userId: string | null;
		type: "organization" | "personal" | "none";
		organizationId: string | null;
	};
};

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
	return {
		user: { id: USER_ID },
		session: { activeOrganizationId: SESSION_ORG },
		tenantContext: {
			userId: USER_ID,
			type: "organization",
			organizationId: SESSION_ORG,
		},
		...overrides,
	};
}

// oRPC returns the tagged middleware as a callable — invoke it directly with
// ({ context, next }, input). Mirrors require-project-permission.test.ts.
async function invokeMw(mw: unknown, ctx: Ctx, input: unknown) {
	const next = vi.fn().mockResolvedValue({ output: "ok" });
	await (
		mw as (
			arg: { context: Ctx; next: typeof next },
			input: unknown,
		) => Promise<unknown>
	)({ context: ctx, next }, input);
	return { next };
}

beforeEach(() => {
	mocks.getOrganizationMembership.mockReset();
	mocks.getTenantContext.mockReset();
	mocks.getTenantContext.mockReturnValue({ effectiveWriteOrgId: undefined });
});

describe("requireInputOrgPermission — tenant-membership enforcement", () => {
	it("personal context (input organizationId null) passes through without a membership lookup", async () => {
		const requireInputOrgPermission = await loadMiddleware();
		const mw = requireInputOrgPermission(Permissions.INTEGRATION_CONNECT);

		const { next } = await invokeMw(
			mw,
			makeCtx({
				session: { activeOrganizationId: null },
				tenantContext: {
					userId: USER_ID,
					type: "personal",
					organizationId: null,
				},
			}),
			{ organizationId: null },
		);

		expect(next).toHaveBeenCalled();
		expect(mocks.getOrganizationMembership).not.toHaveBeenCalled();
	});

	// The pass-through above is a BYPASS on any procedure that no longer has a
	// personal variant: explicit null deliberately does not fall back to the
	// session, so a caller who sends it skips the role check. Found while
	// verifying the weave fix, which had claimed the checks now evaluate.
	it("refuses instead of passing through when requireOrganization is set", async () => {
		const requireInputOrgPermission = await loadMiddleware();
		const mw = requireInputOrgPermission(Permissions.INTEGRATION_CONNECT, {
			requireOrganization: true,
		});

		await expect(
			invokeMw(
				mw,
				makeCtx({
					session: { activeOrganizationId: null },
					tenantContext: {
						userId: USER_ID,
						type: "personal",
						organizationId: null,
					},
				}),
				{ organizationId: null },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		// Refused before any lookup — there is no organization to look one up in.
		expect(mocks.getOrganizationMembership).not.toHaveBeenCalled();
	});

	// A caller whose SESSION carries an organization is unaffected: only an
	// explicit null reaches the refusal, and that is the crafted case.
	it("still resolves from the session when the input omits the organization", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "owner" });

		const requireInputOrgPermission = await loadMiddleware();
		const mw = requireInputOrgPermission(Permissions.INTEGRATION_CONNECT, {
			requireOrganization: true,
		});

		const { next } = await invokeMw(
			mw,
			makeCtx({
				session: { activeOrganizationId: SESSION_ORG },
				tenantContext: {
					userId: USER_ID,
					type: "organization",
					organizationId: SESSION_ORG,
				},
			}),
			{},
		);

		expect(next).toHaveBeenCalled();
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			SESSION_ORG,
			USER_ID,
		);
	});

	it("cross-tenant: admin of session org A passing org B is FORBIDDEN, and membership is checked against org B", async () => {
		// Caller is admin of SESSION_ORG (their session), but not a member of
		// VICTIM_ORG. This is the exact IDOR the fix closes.
		mocks.getOrganizationMembership.mockResolvedValue(null);

		const requireInputOrgPermission = await loadMiddleware();
		const mw = requireInputOrgPermission(Permissions.INTEGRATION_CONNECT);

		await expect(
			invokeMw(mw, makeCtx({}), { organizationId: VICTIM_ORG }),
		).rejects.toThrow(/FORBIDDEN|not a member/i);

		// The load-bearing assertion: membership was verified for the INPUT org
		// (victim), NOT the caller's session org.
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			VICTIM_ORG,
			USER_ID,
		);
	});

	it("member with a role that grants the permission → next()", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "admin",
			organization: { id: SESSION_ORG },
		});

		const requireInputOrgPermission = await loadMiddleware();
		const mw = requireInputOrgPermission(Permissions.INTEGRATION_CONNECT);

		const { next } = await invokeMw(mw, makeCtx({}), {
			organizationId: SESSION_ORG,
		});
		expect(next).toHaveBeenCalled();
	});

	it("member whose role lacks the permission → FORBIDDEN", async () => {
		// `member` role does not carry INTEGRATION_CONNECT (admin/owner only).
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "member",
			organization: { id: SESSION_ORG },
		});

		const requireInputOrgPermission = await loadMiddleware();
		const mw = requireInputOrgPermission(Permissions.INTEGRATION_CONNECT);

		await expect(
			invokeMw(mw, makeCtx({}), { organizationId: SESSION_ORG }),
		).rejects.toThrow(/FORBIDDEN|Missing required permission/i);
	});

	it("input undefined falls back to the session org and enforces its role", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "admin",
			organization: { id: SESSION_ORG },
		});

		const requireInputOrgPermission = await loadMiddleware();
		const mw = requireInputOrgPermission(Permissions.INTEGRATION_CONNECT);

		const { next } = await invokeMw(mw, makeCtx({}), {
			/* no organizationId */
		});
		expect(next).toHaveBeenCalled();
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			SESSION_ORG,
			USER_ID,
		);
	});
});

describe("requireInputOrgPermission — RBAC_DRY_RUN security property", () => {
	beforeEach(() => {
		vi.stubEnv("RBAC_DRY_RUN", "true");
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("non-member is STILL hard-blocked under dry-run (a tenant boundary is never downgraded)", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(null);

		const requireInputOrgPermission = await loadMiddleware();
		const mw = requireInputOrgPermission(Permissions.INTEGRATION_CONNECT);

		await expect(
			invokeMw(mw, makeCtx({}), { organizationId: VICTIM_ORG }),
		).rejects.toThrow(/FORBIDDEN|not a member/i);
	});

	it("member with insufficient role: denial downgraded to a warning, next() runs", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "member",
			organization: { id: SESSION_ORG },
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const requireInputOrgPermission = await loadMiddleware();
		const mw = requireInputOrgPermission(Permissions.INTEGRATION_CONNECT);

		const { next } = await invokeMw(mw, makeCtx({}), {
			organizationId: SESSION_ORG,
		});
		expect(next).toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});
