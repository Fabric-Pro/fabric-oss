/**
 * `canCreateProjectContexts` — the background counterpart of
 * `requireProjectPermission(CONTEXT_CREATE)` a Living Memory repository
 * sync re-checks for its acting user at `begin` and before its first apply
 * and prune batch (design 2026-09-23 §2, §5.3.0, §5.3.1).
 *
 * What this pins: the same ladder as `canEditProject` (owner → active
 * project row, authoritative → org-role fallback), asked for CONTEXT_CREATE;
 * an invited guest is decided by their project role alone; a revoked,
 * expired or never-accepted project row grants nothing; and the ladder reads
 * through the transaction client it is given.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/can-create-project-contexts.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
	projectMemberFindUnique: vi.fn(),
}));

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

import { canCreateProjectContexts } from "../prisma/queries/projects/projects";

const PROJECT_ID = "proj-1";
const ORG_ID = "org-1";
const OWNER_ID = "user-owner";
const USER_ID = "user-x";
const DAY = 24 * 60 * 60 * 1000;

function orgProject() {
	mocks.projectFindUnique.mockResolvedValue({
		userId: OWNER_ID,
		organizationId: ORG_ID,
	});
}

function projectRow(
	role: string,
	overrides: { acceptedAt?: Date | null; expiresAt?: Date | null } = {},
) {
	mocks.projectMemberFindUnique.mockResolvedValue({
		role,
		acceptedAt: new Date(Date.now() - DAY),
		expiresAt: null,
		...overrides,
	});
}

beforeEach(() => {
	mocks.projectFindUnique.mockReset();
	mocks.memberFindFirst.mockReset();
	mocks.projectMemberFindUnique.mockReset();
});

describe("canCreateProjectContexts", () => {
	it("grants an organization member with no project row (the member org role holds context:create)", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "member" });

		expect(await canCreateProjectContexts(PROJECT_ID, USER_ID)).toBe(true);
	});

	it("grants an invited guest whose project role is EDITOR, without consulting any org role", async () => {
		orgProject();
		projectRow("EDITOR");

		expect(await canCreateProjectContexts(PROJECT_ID, USER_ID)).toBe(true);
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it.each(["VIEWER", "COMMENTER"])(
		"refuses an invited guest whose project role is %s",
		async (role) => {
			orgProject();
			projectRow(role);

			expect(await canCreateProjectContexts(PROJECT_ID, USER_ID)).toBe(
				false,
			);
		},
	);

	it("refuses an org admin demoted to VIEWER on this project", async () => {
		orgProject();
		projectRow("VIEWER");
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		expect(await canCreateProjectContexts(PROJECT_ID, USER_ID)).toBe(false);
	});

	it("refuses a guest whose access expired, once nothing else ties them to the project", async () => {
		orgProject();
		projectRow("EDITOR", { expiresAt: new Date(Date.now() - DAY) });
		mocks.memberFindFirst.mockResolvedValue(null);

		expect(await canCreateProjectContexts(PROJECT_ID, USER_ID)).toBe(false);
	});

	it("refuses a guest who never accepted the invitation", async () => {
		orgProject();
		projectRow("EDITOR", { acceptedAt: null });
		mocks.memberFindFirst.mockResolvedValue(null);

		expect(await canCreateProjectContexts(PROJECT_ID, USER_ID)).toBe(false);
	});

	it("refuses a user removed from the project and the organization", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue(null);

		expect(await canCreateProjectContexts(PROJECT_ID, USER_ID)).toBe(false);
	});

	it("refuses when the project does not exist", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);

		expect(await canCreateProjectContexts(PROJECT_ID, USER_ID)).toBe(false);
	});

	it("reads through the transaction client it is given, never the global client", async () => {
		const tx = {
			project: {
				findUnique: vi.fn().mockResolvedValue({
					userId: OWNER_ID,
					organizationId: ORG_ID,
				}),
			},
			projectMember: { findUnique: vi.fn().mockResolvedValue(null) },
			member: {
				findFirst: vi.fn().mockResolvedValue({ role: "member" }),
			},
		};

		expect(
			await canCreateProjectContexts(PROJECT_ID, USER_ID, tx as never),
		).toBe(true);
		expect(tx.project.findUnique).toHaveBeenCalled();
		expect(tx.projectMember.findUnique).toHaveBeenCalled();
		expect(tx.member.findFirst).toHaveBeenCalled();
		expect(mocks.projectFindUnique).not.toHaveBeenCalled();
		expect(mocks.projectMemberFindUnique).not.toHaveBeenCalled();
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});
});
