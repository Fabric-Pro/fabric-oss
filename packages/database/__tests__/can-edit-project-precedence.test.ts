/**
 * Precedence tests for `canEditProject` (issue #705).
 *
 * The helper must mirror `requireProjectPermission(PROJECT_UPDATE)` /
 * `resolveEffectiveProjectPermissions` exactly:
 *   A. personal-project owner →
 *   C. active (accepted, non-expired) ProjectMember row is AUTHORITATIVE —
 *      its role alone decides, the org role is NOT consulted →
 *   B. org-role fallback only when no active project-level row exists.
 *
 * The load-bearing case is the demoted org admin: an org admin/owner with an
 * explicit VIEWER (or COMMENTER) ProjectMember row on a project must be
 * denied — the org-first ordering this helper originally shipped with
 * silently bypassed per-project demotions on every non-oRPC surface.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/can-edit-project-precedence.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
	projectMemberFindUnique: vi.fn(),
}));

// `projects.ts` resolves its `db` import to `../../client` from its position
// at `prisma/queries/projects/`; from this test that same module is
// `../prisma/client`. The module also imports `Prisma` / `ProjectMemberRole`
// as values, so the mock must provide them for the import to bind.
vi.mock("../prisma/client", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		member: { findFirst: mocks.memberFindFirst },
		projectMember: { findUnique: mocks.projectMemberFindUnique },
	},
	Prisma: { JsonNull: Symbol("JsonNull") },
	ProjectMemberRole: {
		OWNER: "OWNER",
		PROJECT_ADMIN: "PROJECT_ADMIN",
		EDITOR: "EDITOR",
		COMMENTER: "COMMENTER",
		VIEWER: "VIEWER",
	},
}));

import {
	canCreateProjectStory,
	canEditProject,
} from "../prisma/queries/projects/projects";

const PROJECT_ID = "proj-1";
const ORG_ID = "org-A";
const OWNER_ID = "user-owner";
const USER_ID = "user-x";

function orgProject() {
	mocks.projectFindUnique.mockResolvedValue({
		userId: OWNER_ID,
		organizationId: ORG_ID,
	});
}

beforeEach(() => {
	mocks.projectFindUnique.mockReset();
	mocks.memberFindFirst.mockReset();
	mocks.projectMemberFindUnique.mockReset();
});

describe("canEditProject precedence", () => {
	it("returns false when the project does not exist", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);
		expect(await canEditProject(PROJECT_ID, USER_ID)).toBe(false);
	});

	it("Path A: personal-project owner is granted", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: null,
		});
		expect(await canEditProject(PROJECT_ID, OWNER_ID)).toBe(true);
		expect(mocks.projectMemberFindUnique).not.toHaveBeenCalled();
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("Path A does NOT apply to org projects: creator with a demoted VIEWER row is denied", async () => {
		// project.userId === caller, but organizationId is non-null, so the
		// personal-owner shortcut must not fire — the active VIEWER row decides.
		mocks.projectFindUnique.mockResolvedValue({
			userId: USER_ID,
			organizationId: ORG_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "owner" });

		expect(await canEditProject(PROJECT_ID, USER_ID)).toBe(false);
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("demoted org admin: active VIEWER ProjectMember row denies, org role NOT consulted", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		// Even an org admin row must never be reached.
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		expect(await canEditProject(PROJECT_ID, USER_ID)).toBe(false);
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("demoted org admin: active COMMENTER ProjectMember row denies", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "COMMENTER",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		expect(await canEditProject(PROJECT_ID, USER_ID)).toBe(false);
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("Path B: org admin with no ProjectMember row is still granted", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		expect(await canEditProject(PROJECT_ID, USER_ID)).toBe(true);
	});

	it("Path C grants: project EDITOR without org membership (external guest)", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "EDITOR",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		mocks.memberFindFirst.mockResolvedValue(null);

		expect(await canEditProject(PROJECT_ID, USER_ID)).toBe(true);
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("expired ProjectMember row is treated as absent → org-role fallback grants", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: new Date(Date.now() - 1_000_000),
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		expect(await canEditProject(PROJECT_ID, USER_ID)).toBe(true);
	});

	it("expiresAt exactly `now` is NOT active — the boundary is strictly `> now`", async () => {
		// The old implementation compared `expiresAt < now` (so an exactly-now
		// row counted as active); the resolver and this helper use strict
		// `expiresAt > now`. Pin the boundary with a frozen clock.
		vi.useFakeTimers();
		try {
			const now = new Date("2026-08-16T12:00:00.000Z");
			vi.setSystemTime(now);
			orgProject();
			mocks.projectMemberFindUnique.mockResolvedValue({
				role: "EDITOR",
				acceptedAt: new Date("2026-08-01T00:00:00.000Z"),
				expiresAt: new Date(now),
			});
			// EDITOR would grant if the row were active; the grant must instead
			// come from the org fallback, proving the row was treated as absent.
			mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

			expect(await canEditProject(PROJECT_ID, USER_ID)).toBe(true);
			expect(mocks.memberFindFirst).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("pending (unaccepted) ProjectMember row is treated as absent → org-role fallback", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "EDITOR",
			acceptedAt: null,
			expiresAt: null,
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		expect(await canEditProject(PROJECT_ID, USER_ID)).toBe(true);
	});

	it("no membership anywhere → denied", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue(null);

		expect(await canEditProject(PROJECT_ID, USER_ID)).toBe(false);
	});
});

describe("canCreateProjectStory walks the SAME ladder", () => {
	/**
	 * This helper had no precedence coverage at all until the two of them were
	 * collapsed onto `resolveProjectAccess`. That is the shape the gap took:
	 * one of two byte-identical copies was tested, so the tested one was right
	 * and nothing said anything about the other.
	 *
	 * Kept as its own block rather than folded into a parameterised sweep,
	 * because the two helpers ask about DIFFERENT permissions and a sweep would
	 * quietly stop proving that.
	 */

	it("lets a personal-project owner create", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: null,
		});

		expect(await canCreateProjectStory(PROJECT_ID, OWNER_ID)).toBe(true);
		// The owner path answers without consulting membership at all.
		expect(mocks.projectMemberFindUnique).not.toHaveBeenCalled();
	});

	it("honours a per-project demotion over the org role", async () => {
		// The load-bearing case, and the one an org-first ordering gets wrong:
		// an org ADMIN explicitly restricted to VIEWER on this project.
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date("2020-01-01"),
			expiresAt: null,
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		expect(await canCreateProjectStory(PROJECT_ID, USER_ID)).toBe(false);
		// Path C is authoritative: the org role must not even be consulted.
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("falls back to the org role when no active project row exists", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		expect(await canCreateProjectStory(PROJECT_ID, USER_ID)).toBe(true);
	});

	it("treats an expired project row as no row, not as a denial", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date("2020-01-01"),
			expiresAt: new Date("2020-06-01"),
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		expect(await canCreateProjectStory(PROJECT_ID, USER_ID)).toBe(true);
	});

	it("denies a stranger to the organization", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue(null);

		expect(await canCreateProjectStory(PROJECT_ID, USER_ID)).toBe(false);
	});

	it("returns false when the project does not exist", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);

		expect(await canCreateProjectStory(PROJECT_ID, USER_ID)).toBe(false);
	});
});
