/**
 * Verifies the guest-aware branch of `hasProjectAccess`. The critical
 * contract is:
 *
 *   - Org projects: allowed iff the caller is an OrgMember AND (owner
 *     OR accepted ProjectMember), OR the caller is NOT an OrgMember but
 *     has an accepted, non-expired ProjectMember row (the guest path).
 *   - Personal projects: allowed iff caller is owner OR has an accepted,
 *     non-expired ProjectMember row. No org membership involved.
 *
 * The pre-guest-flow version of this helper rejected every non-org-member
 * on an org project, which blocked external guests entirely. This test
 * pins the new behavior so a future refactor that restores the old check
 * fails loudly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../database/prisma/client", () => ({
	db: {
		project: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
		projectMember: { findFirst: vi.fn() },
	},
	Prisma: {},
}));

// Re-import via the path the helper uses.
vi.mock("@repo/database/prisma/client", () => ({
	db: {
		project: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
		projectMember: { findFirst: vi.fn() },
	},
	Prisma: {},
}));

async function loadHelper() {
	const mod = await import("@repo/database/prisma/queries/projects/projects");
	return mod.hasProjectAccess;
}

async function getMockDb() {
	const mod = await import("@repo/database/prisma/client");
	return mod.db as unknown as {
		project: { findFirst: ReturnType<typeof vi.fn> };
		member: { findFirst: ReturnType<typeof vi.fn> };
		projectMember: { findFirst: ReturnType<typeof vi.fn> };
	};
}

const ORG_ID = "org-A";
const PROJECT_ID = "proj-1";
const OWNER_ID = "user-owner";
const GUEST_ID = "user-guest";
const ORG_MEMBER_ID = "user-member";
const OUTSIDER_ID = "user-outsider";

beforeEach(async () => {
	const db = await getMockDb();
	db.project.findFirst.mockReset();
	db.member.findFirst.mockReset();
	db.projectMember.findFirst.mockReset();
});

describe("hasProjectAccess — org project", () => {
	it("guest: non-member with accepted ProjectMember row → true", async () => {
		const db = await getMockDb();
		db.project.findFirst.mockResolvedValue({
			id: PROJECT_ID,
			userId: OWNER_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue(null); // not an org member
		db.projectMember.findFirst.mockResolvedValue({ id: "pm-1" });

		const hasProjectAccess = await loadHelper();
		const result = await hasProjectAccess(PROJECT_ID, GUEST_ID);
		expect(result).toBe(true);
	});

	it("outsider: no OrgMember AND no ProjectMember → false", async () => {
		const db = await getMockDb();
		db.project.findFirst.mockResolvedValue({
			id: PROJECT_ID,
			userId: OWNER_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue(null);
		db.projectMember.findFirst.mockResolvedValue(null);

		const hasProjectAccess = await loadHelper();
		const result = await hasProjectAccess(PROJECT_ID, OUTSIDER_ID);
		expect(result).toBe(false);
	});

	it("org member who is the project owner → true", async () => {
		const db = await getMockDb();
		db.project.findFirst.mockResolvedValue({
			id: PROJECT_ID,
			userId: OWNER_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue({ id: "om-1" });
		db.projectMember.findFirst.mockResolvedValue(null);

		const hasProjectAccess = await loadHelper();
		const result = await hasProjectAccess(PROJECT_ID, OWNER_ID);
		expect(result).toBe(true);
	});

	it("org member with no project membership → false", async () => {
		// Being an org member is not enough — org members still need an
		// explicit ProjectMember row to reach a non-owned project.
		const db = await getMockDb();
		db.project.findFirst.mockResolvedValue({
			id: PROJECT_ID,
			userId: OWNER_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue({ id: "om-1" });
		db.projectMember.findFirst.mockResolvedValue(null);

		const hasProjectAccess = await loadHelper();
		const result = await hasProjectAccess(PROJECT_ID, ORG_MEMBER_ID);
		expect(result).toBe(false);
	});

	it("org member with accepted ProjectMember row → true", async () => {
		const db = await getMockDb();
		db.project.findFirst.mockResolvedValue({
			id: PROJECT_ID,
			userId: OWNER_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue({ id: "om-1" });
		db.projectMember.findFirst.mockResolvedValue({ id: "pm-1" });

		const hasProjectAccess = await loadHelper();
		const result = await hasProjectAccess(PROJECT_ID, ORG_MEMBER_ID);
		expect(result).toBe(true);
	});

	it("nonexistent project → false", async () => {
		const db = await getMockDb();
		db.project.findFirst.mockResolvedValue(null);

		const hasProjectAccess = await loadHelper();
		const result = await hasProjectAccess("missing", GUEST_ID);
		expect(result).toBe(false);
	});

	it("guest's ProjectMember query is gated on acceptedAt + expiresAt", async () => {
		// The query itself must require `acceptedAt != null` and reject
		// expired rows — the helper relies on the WHERE clause to
		// exclude unaccepted/expired guests. Here we assert the mock was
		// called with that shape.
		const db = await getMockDb();
		db.project.findFirst.mockResolvedValue({
			id: PROJECT_ID,
			userId: OWNER_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue(null);
		db.projectMember.findFirst.mockResolvedValue(null);

		const hasProjectAccess = await loadHelper();
		await hasProjectAccess(PROJECT_ID, GUEST_ID);

		expect(db.projectMember.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: PROJECT_ID,
					userId: GUEST_ID,
					acceptedAt: { not: null },
					OR: expect.arrayContaining([
						{ expiresAt: null },
						expect.objectContaining({
							expiresAt: { gt: expect.any(Date) },
						}),
					]),
				}),
			}),
		);
	});
});

describe("hasProjectAccess — personal project", () => {
	it("owner → true", async () => {
		const db = await getMockDb();
		db.project.findFirst.mockResolvedValue({
			id: PROJECT_ID,
			userId: OWNER_ID,
			organizationId: null,
		});
		db.projectMember.findFirst.mockResolvedValue(null);

		const hasProjectAccess = await loadHelper();
		const result = await hasProjectAccess(PROJECT_ID, OWNER_ID);
		expect(result).toBe(true);
	});

	it("non-owner with accepted ProjectMember → true", async () => {
		const db = await getMockDb();
		db.project.findFirst.mockResolvedValue({
			id: PROJECT_ID,
			userId: OWNER_ID,
			organizationId: null,
		});
		db.projectMember.findFirst.mockResolvedValue({ id: "pm-1" });

		const hasProjectAccess = await loadHelper();
		const result = await hasProjectAccess(PROJECT_ID, GUEST_ID);
		expect(result).toBe(true);
	});

	it("non-owner with no ProjectMember → false", async () => {
		const db = await getMockDb();
		db.project.findFirst.mockResolvedValue({
			id: PROJECT_ID,
			userId: OWNER_ID,
			organizationId: null,
		});
		db.projectMember.findFirst.mockResolvedValue(null);

		const hasProjectAccess = await loadHelper();
		const result = await hasProjectAccess(PROJECT_ID, OUTSIDER_ID);
		expect(result).toBe(false);
	});
});
