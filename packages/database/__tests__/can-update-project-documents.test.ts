/**
 * `canUpdateProjectDocuments` walks the same project-access ladder as
 * `requireProjectPermission(DOCUMENT_UPDATE)` (Fizzy #2946).
 *
 * The Proposal settled-decisions feed asks it about each answer's author at
 * build time, so a COMMENTER or VIEWER (including a demoted organization
 * admin) must not hold it, while an EDITOR row and a plain organization
 * member do. A project guest with an EDITOR row holds it as well: it is a
 * project permission, not organization membership, which is why the feed
 * asks `isOrganizationMember` beside it.
 *
 * Run with:
 *   pnpm --filter @repo/database exec vitest run __tests__/can-update-project-documents.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
	projectMemberFindUnique: vi.fn(),
	isOrganizationMember: vi.fn(),
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

vi.mock("../prisma/queries/verify-organization-membership", () => ({
	isOrganizationMember: mocks.isOrganizationMember,
}));

import {
	authorMaySettleDecisions,
	canUpdateProjectDocuments,
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

function activeProjectRow(role: string) {
	mocks.projectMemberFindUnique.mockResolvedValue({
		role,
		acceptedAt: new Date(),
		expiresAt: null,
	});
}

beforeEach(() => {
	mocks.projectFindUnique.mockReset();
	mocks.memberFindFirst.mockReset();
	mocks.projectMemberFindUnique.mockReset();
});

describe("canUpdateProjectDocuments", () => {
	it("returns false when the project does not exist", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);
		expect(await canUpdateProjectDocuments(PROJECT_ID, USER_ID)).toBe(
			false,
		);
	});

	it.each(["EDITOR", "PROJECT_ADMIN", "OWNER"])(
		"grants an active %s project member",
		async (role) => {
			orgProject();
			activeProjectRow(role);
			mocks.memberFindFirst.mockResolvedValue({ role: "member" });
			expect(await canUpdateProjectDocuments(PROJECT_ID, USER_ID)).toBe(
				true,
			);
		},
	);

	it.each(["COMMENTER", "VIEWER"])(
		"refuses a %s project member even when their org role would grant it",
		async (role) => {
			orgProject();
			activeProjectRow(role);
			mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
			expect(await canUpdateProjectDocuments(PROJECT_ID, USER_ID)).toBe(
				false,
			);
			// The active project row decides; the org role is never consulted.
			expect(mocks.memberFindFirst).not.toHaveBeenCalled();
		},
	);

	it("grants a plain organization member with no project row", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "member" });
		expect(await canUpdateProjectDocuments(PROJECT_ID, USER_ID)).toBe(true);
	});

	it("refuses an organization viewer with no project row", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "viewer" });
		expect(await canUpdateProjectDocuments(PROJECT_ID, USER_ID)).toBe(
			false,
		);
	});

	it("grants a project guest with an EDITOR row and no organization membership", async () => {
		// A project permission, not membership: the settled-decisions feed
		// must ask `isOrganizationMember` as well, and this pins why.
		orgProject();
		activeProjectRow("EDITOR");
		mocks.memberFindFirst.mockResolvedValue(null);
		expect(await canUpdateProjectDocuments(PROJECT_ID, USER_ID)).toBe(true);
	});

	it("treats an expired project row as absent and falls back to the org role", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date("2020-01-01"),
			expiresAt: new Date("2020-06-01"),
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "member" });
		expect(await canUpdateProjectDocuments(PROJECT_ID, USER_ID)).toBe(true);
	});

	it("refuses a user with no tie to the project", async () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue(null);
		expect(await canUpdateProjectDocuments(PROJECT_ID, USER_ID)).toBe(
			false,
		);
	});

	it("lets a personal-project owner update, as the gate does", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: null,
		});
		expect(await canUpdateProjectDocuments(PROJECT_ID, OWNER_ID)).toBe(
			true,
		);
	});
});

describe("authorMaySettleDecisions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgProject();
	});

	it("refuses an author who is not a member of the owning organization without asking the project", async () => {
		mocks.isOrganizationMember.mockResolvedValue(false);
		activeProjectRow("EDITOR");

		await expect(
			authorMaySettleDecisions(USER_ID, PROJECT_ID, ORG_ID),
		).resolves.toBe(false);
		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(
			USER_ID,
			ORG_ID,
		);
		expect(mocks.projectFindUnique).not.toHaveBeenCalled();
		expect(mocks.projectMemberFindUnique).not.toHaveBeenCalled();
	});

	it("accepts a member who holds document update on the project", async () => {
		mocks.isOrganizationMember.mockResolvedValue(true);
		activeProjectRow("EDITOR");

		await expect(
			authorMaySettleDecisions(USER_ID, PROJECT_ID, ORG_ID),
		).resolves.toBe(true);
	});

	it("refuses a member whose project role cannot update documents", async () => {
		mocks.isOrganizationMember.mockResolvedValue(true);
		activeProjectRow("COMMENTER");

		await expect(
			authorMaySettleDecisions(USER_ID, PROJECT_ID, ORG_ID),
		).resolves.toBe(false);
	});
});
