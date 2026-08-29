/**
 * Regression tests for the `requireProjectPermission` middleware.
 *
 * Pin three behaviors:
 *  1. An active `ProjectMember` row is authoritative for the project — an
 *     org admin demoted to Viewer on a specific project is actually
 *     restricted (no Path-B override).
 *  2. Denials never fall through to `grantProjectAccess` — a request that
 *     fails the role check must not seed tenant context for downstream
 *     queries, even under `RBAC_DRY_RUN=true` where the deny helper only
 *     logs.
 *  3. Pending (`acceptedAt: null`) or expired rows are treated as absent
 *     and fall through to the org-role path — they must not restrict.
 */

import { Permissions } from "@repo/permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const grantSpy = vi.fn();
const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
	projectMemberFindUnique: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		member: { findFirst: mocks.memberFindFirst },
		projectMember: { findUnique: mocks.projectMemberFindUnique },
	},
	grantProjectAccess: (projectId: string, organizationId: string | null) =>
		grantSpy(projectId, organizationId),
}));

async function loadMiddleware() {
	const mod = await import("../orpc/middleware/require-permission");
	return mod.requireProjectPermission;
}

const PROJECT_ID = "proj-1";
const ORG_ID = "org-A";
const OWNER_ID = "user-owner";
const GUEST_ID = "user-guest";
const ORG_ADMIN_ID = "user-org-admin";

type Ctx = {
	user: { id: string };
	tenantContext: {
		userId: string;
		type: "organization" | "personal" | "none";
		organizationId: string | null;
	};
	activeOrganizationRole: string | null;
	allowedProjectIds: string[];
};

function makeCtx(userId: string, overrides: Partial<Ctx> = {}): Ctx {
	return {
		user: { id: userId },
		tenantContext: {
			userId,
			type: "organization",
			organizationId: ORG_ID,
		},
		activeOrganizationRole: null,
		allowedProjectIds: [],
		...overrides,
	};
}

// oRPC returns the tagged middleware as a callable — invoke it directly with
// ({ context, next }, input). No fallback path; this is the shape in the
// current version.
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
	mocks.projectFindUnique.mockReset();
	mocks.memberFindFirst.mockReset();
	mocks.projectMemberFindUnique.mockReset();
	grantSpy.mockReset();
});

describe("requireProjectPermission — project role overrides org role", () => {
	it("external guest demoted Editor→Viewer is denied PROJECT_UPDATE", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.memberFindFirst.mockResolvedValue(null);
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: null,
		});

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(Permissions.PROJECT_UPDATE);

		await expect(
			invokeMw(mw, makeCtx(GUEST_ID), { projectId: PROJECT_ID }),
		).rejects.toThrow(/FORBIDDEN|Missing required permission/);
		expect(grantSpy).not.toHaveBeenCalled();
		// Pin the ordering invariant: active ProjectMember short-circuits
		// before Path C (org role) is ever consulted.
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("project Viewer who is ALSO an org admin is denied PROJECT_UPDATE (Path-B override removed)", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: null,
		});

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(Permissions.PROJECT_UPDATE);

		await expect(
			invokeMw(
				mw,
				makeCtx(ORG_ADMIN_ID, { activeOrganizationRole: "admin" }),
				{ projectId: PROJECT_ID },
			),
		).rejects.toThrow(/FORBIDDEN|Missing required permission/);
		expect(grantSpy).not.toHaveBeenCalled();
		// The load-bearing invariant of this fix: an active ProjectMember
		// row takes precedence over org role — Path C (org role) is never
		// consulted for this caller.
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("org admin with NO ProjectMember row falls back to Path C (org role) and is granted", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(Permissions.PROJECT_UPDATE);

		const { next } = await invokeMw(
			mw,
			makeCtx(ORG_ADMIN_ID, { activeOrganizationRole: "admin" }),
			{ projectId: PROJECT_ID },
		);
		expect(next).toHaveBeenCalled();
		// Org-role grants via Path C do NOT need grantProjectAccess — org
		// members are already covered by tenant-db's org filter.
		expect(grantSpy).not.toHaveBeenCalled();
	});

	it("active project Editor is granted and grantProjectAccess is seeded", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.memberFindFirst.mockResolvedValue(null);
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "EDITOR",
			acceptedAt: new Date(),
			expiresAt: null,
		});

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(Permissions.PROJECT_UPDATE);

		const { next } = await invokeMw(mw, makeCtx(GUEST_ID), {
			projectId: PROJECT_ID,
		});
		expect(next).toHaveBeenCalled();
		expect(grantSpy).toHaveBeenCalledWith(PROJECT_ID, ORG_ID);
		// Active ProjectMember grants skip the Path-C org-role query.
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	/**
	 * The two cases below are a PERSONAL project reached by someone who is not
	 * its owner. They were missing: every existing member case here is an
	 * org-owned project, and the only personal case is the owner.
	 *
	 * That gap is what let the newsletter and daily-brief handlers re-scope
	 * their own project lookup to `userId: context.user.id` — which in personal
	 * context means OWNER — and reject an accepted member the middleware had
	 * just admitted. Those handlers no longer re-check, so this middleware is
	 * now the only thing standing between a stranger and the project. Pin both
	 * halves: the member gets in, the stranger does not.
	 */
	it("personal project, accepted non-owner member is granted and seeds a null-org access grant", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: null,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: null,
		});

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(Permissions.PROJECT_SETTINGS_READ);

		const { next } = await invokeMw(
			mw,
			makeCtx(GUEST_ID, {
				tenantContext: {
					userId: GUEST_ID,
					type: "personal",
					organizationId: null,
				},
			}),
			{ projectId: PROJECT_ID },
		);

		expect(next).toHaveBeenCalled();
		// Null org, because the project is personal — the grant carries the
		// PROJECT's tenant, not the caller's.
		expect(grantSpy).toHaveBeenCalledWith(PROJECT_ID, null);
		// A personal project has no host org, so Path C must not be attempted.
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("personal project, caller with no membership at all is denied and seeds nothing", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: null,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue(null);

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(Permissions.PROJECT_SETTINGS_READ);

		await expect(
			invokeMw(
				mw,
				makeCtx(GUEST_ID, {
					tenantContext: {
						userId: GUEST_ID,
						type: "personal",
						organizationId: null,
					},
				}),
				{ projectId: PROJECT_ID },
			),
		).rejects.toThrow(/FORBIDDEN|Missing required permission/);
		expect(grantSpy).not.toHaveBeenCalled();
	});

	it("personal-project owner passes unconditionally — even a permission NOT in the OWNER project set", async () => {
		// Personal project: no org, project.userId === caller. The pre-refactor
		// Path A granted an owner ANY project permission via an unconditional
		// next(). AGENT_CREATE is deliberately NOT in OWNER_PROJECT_PERMISSIONS,
		// so a permission-set check would deny it — this pins the unconditional
		// owner bypass.
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: null,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue(null);

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(Permissions.AGENT_CREATE);

		const { next } = await invokeMw(
			mw,
			makeCtx(OWNER_ID, {
				tenantContext: {
					userId: OWNER_ID,
					type: "personal",
					organizationId: null,
				},
			}),
			{ projectId: PROJECT_ID },
		);
		expect(next).toHaveBeenCalled();
		// Owner bypass is not a ProjectMember grant — no tenant carve-out seeded.
		expect(grantSpy).not.toHaveBeenCalled();
	});

	it("expired ProjectMember is treated as absent — falls back to Path C", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: new Date(Date.now() - 1_000_000),
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(Permissions.PROJECT_UPDATE);

		const { next } = await invokeMw(
			mw,
			makeCtx(ORG_ADMIN_ID, { activeOrganizationRole: "admin" }),
			{ projectId: PROJECT_ID },
		);
		expect(next).toHaveBeenCalled();
	});

	it("pending (acceptedAt: null) ProjectMember is treated as absent — falls back to Path C", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: null,
			expiresAt: null,
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(Permissions.PROJECT_UPDATE);

		const { next } = await invokeMw(
			mw,
			makeCtx(ORG_ADMIN_ID, { activeOrganizationRole: "admin" }),
			{ projectId: PROJECT_ID },
		);
		expect(next).toHaveBeenCalled();
		// Pending-but-not-accepted doesn't trigger grantProjectAccess either
		// — the user is granted via their org role, not via ProjectMember.
		expect(grantSpy).not.toHaveBeenCalled();
	});
});

describe("requireProjectPermission — RBAC_DRY_RUN security property", () => {
	beforeEach(() => {
		vi.stubEnv("RBAC_DRY_RUN", "true");
		vi.resetModules();
	});
	afterEach(() => {
		// Vitest v4 reuses worker threads across files; without this, the
		// stubbed env leaks to any subsequent test file that imports
		// require-permission.ts with a fresh module graph.
		vi.unstubAllEnvs();
	});

	it("demoted viewer: denial is logged, request continues, but grantProjectAccess is NOT called", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.memberFindFirst.mockResolvedValue(null);
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(Permissions.PROJECT_UPDATE);

		const { next } = await invokeMw(mw, makeCtx(GUEST_ID), {
			projectId: PROJECT_ID,
		});
		// Under dry-run, the deny helper logs and returns — next() runs.
		expect(next).toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalled();
		// The load-bearing security property: no tenant-context grant for a
		// denied caller, even when enforcement is off.
		expect(grantSpy).not.toHaveBeenCalled();

		warnSpy.mockRestore();
	});
});
