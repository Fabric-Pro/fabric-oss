/**
 * The QA sign-off threshold gate.
 *
 * Two behaviours carry the weight, and both are failure-open if they break:
 * a project with the gate OFF must never be blocked, and a project with the
 * gate ON must never be satisfied by fewer distinct people than it asked for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockSettingsFindUnique,
	mockSignOffCount,
	mockSignOffUpsert,
	mockProjectFindUnique,
} = vi.hoisted(() => ({
	mockSettingsFindUnique: vi.fn(),
	mockSignOffCount: vi.fn(),
	mockSignOffUpsert: vi.fn(),
	mockProjectFindUnique: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		projectQaSettings: { findUnique: mockSettingsFindUnique },
		qaSignOff: { count: mockSignOffCount, upsert: mockSignOffUpsert },
		project: { findUnique: mockProjectFindUnique },
	},
}));

import { getQaSignOffStatus, recordQaSignOff } from "../qa-sign-offs";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getQaSignOffStatus", () => {
	it("is satisfied when the project has never configured a threshold", () => {
		// ProjectQaSettings is lazy — a project that never opened the page has
		// no row at all. Reading that as "no requirement" is what keeps this
		// migration behaviour-neutral for every existing project.
		mockSettingsFindUnique.mockResolvedValue(null);
		mockSignOffCount.mockResolvedValue(0);

		return expect(
			getQaSignOffStatus({ projectId: "p1", userStoryId: "s1" }),
		).resolves.toEqual({ recorded: 0, required: 0, satisfied: true });
	});

	it("is satisfied when the threshold is explicitly zero", async () => {
		mockSettingsFindUnique.mockResolvedValue({ requiredQaSignOffs: 0 });
		mockSignOffCount.mockResolvedValue(0);

		const status = await getQaSignOffStatus({
			projectId: "p1",
			userStoryId: "s1",
		});

		expect(status.satisfied).toBe(true);
	});

	it("is NOT satisfied while recorded sign-offs are below the threshold", async () => {
		mockSettingsFindUnique.mockResolvedValue({ requiredQaSignOffs: 2 });
		mockSignOffCount.mockResolvedValue(1);

		const status = await getQaSignOffStatus({
			projectId: "p1",
			userStoryId: "s1",
		});

		expect(status).toEqual({ recorded: 1, required: 2, satisfied: false });
	});

	it("is satisfied at exactly the threshold", async () => {
		// The boundary, spelled out: `>=` not `>`. Requiring 2 and having 2 must
		// pass, or a project can never mark anything done.
		mockSettingsFindUnique.mockResolvedValue({ requiredQaSignOffs: 2 });
		mockSignOffCount.mockResolvedValue(2);

		const status = await getQaSignOffStatus({
			projectId: "p1",
			userStoryId: "s1",
		});

		expect(status.satisfied).toBe(true);
	});

	it("stays satisfied above the threshold", async () => {
		mockSettingsFindUnique.mockResolvedValue({ requiredQaSignOffs: 2 });
		mockSignOffCount.mockResolvedValue(5);

		const status = await getQaSignOffStatus({
			projectId: "p1",
			userStoryId: "s1",
		});

		expect(status.satisfied).toBe(true);
	});

	it("counts sign-offs for the FEATURE, not the project", async () => {
		// A shared count would let one heavily-reviewed feature unblock every
		// other feature in the project.
		mockSettingsFindUnique.mockResolvedValue({ requiredQaSignOffs: 1 });
		mockSignOffCount.mockResolvedValue(0);

		await getQaSignOffStatus({ projectId: "p1", userStoryId: "s-target" });

		expect(mockSignOffCount).toHaveBeenCalledWith({
			where: { userStoryId: "s-target" },
		});
	});
});

/**
 * Tenant tagging on write.
 *
 * The row must carry the PROJECT's tenant, never the caller's session. Two
 * legitimate states make those differ: a guest project-member has no active
 * organization at all, and a multi-org user can act on Org B's project while
 * their session still points at Org A. Tagging from the session mislabels the
 * row in both, and the table's `user_owned` RLS policy would then enforce the
 * wrong boundary (SOC 2 CC6.1/CC6.3).
 */
describe("recordQaSignOff — tenant columns", () => {
	beforeEach(() => {
		mockSignOffUpsert.mockResolvedValue({
			id: "so1",
			signedById: "u1",
			signedByLabel: "Ada",
			note: null,
			createdAt: new Date(),
		});
	});

	it("copies the tenant from the project, not the caller", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-B",
			userId: null,
		});

		await recordQaSignOff({
			projectId: "p1",
			userStoryId: "s1",
			signedById: "u1",
			signedByLabel: "Ada",
		});

		expect(mockProjectFindUnique).toHaveBeenCalledWith({
			where: { id: "p1" },
			select: { organizationId: true, userId: true },
		});
		expect(mockSignOffUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					organizationId: "org-B",
					userId: null,
				}),
			}),
		);
	});

	it("tags a personal project's sign-off as personal", async () => {
		mockProjectFindUnique.mockResolvedValue({
			organizationId: null,
			userId: "owner-1",
		});

		await recordQaSignOff({
			projectId: "p1",
			userStoryId: "s1",
			signedById: "u2",
			signedByLabel: "Grace",
		});

		expect(mockSignOffUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					organizationId: null,
					userId: "owner-1",
				}),
			}),
		);
	});

	it("upserts on (userStoryId, signedById) so one person cannot sign twice", async () => {
		// The threshold control itself: a second press updates the note rather
		// than adding a second row towards the count.
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org-A",
			userId: null,
		});

		await recordQaSignOff({
			projectId: "p1",
			userStoryId: "s1",
			signedById: "u1",
			signedByLabel: "Ada",
			note: "second press",
		});

		expect(mockSignOffUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					userStoryId_signedById: {
						userStoryId: "s1",
						signedById: "u1",
					},
				},
			}),
		);
	});
});
