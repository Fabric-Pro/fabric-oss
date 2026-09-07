/**
 * `getProjectAccessContext` is the single-query sibling to `hasProjectAccess`:
 * it runs the same `Project` fetch but returns the resolved
 * `organizationId` alongside the access decision, so callers that need both
 * (e.g. a tenant-XOR check) don't have to re-fetch the same row a second
 * time. `hasProjectAccess` is now a thin wrapper over it, so this file
 * mirrors the access-decision matrix that `hasProjectAccess`'s doc comment
 * has always described, plus a check that only one `Project` read happens
 * per call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockProjectFindFirst,
	mockProjectMemberFindFirst,
	mockMemberFindFirst,
} = vi.hoisted(() => ({
	mockProjectFindFirst: vi.fn(),
	mockProjectMemberFindFirst: vi.fn(),
	mockMemberFindFirst: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		project: { findFirst: (...a: unknown[]) => mockProjectFindFirst(...a) },
		projectMember: {
			findFirst: (...a: unknown[]) => mockProjectMemberFindFirst(...a),
		},
		member: { findFirst: (...a: unknown[]) => mockMemberFindFirst(...a) },
	},
	Prisma: {},
}));

import { getProjectAccessContext, hasProjectAccess } from "../projects";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getProjectAccessContext", () => {
	it("returns null when the project does not exist", async () => {
		mockProjectFindFirst.mockResolvedValue(null);

		const result = await getProjectAccessContext("p1", "user1");

		expect(result).toBeNull();
		expect(mockProjectFindFirst).toHaveBeenCalledTimes(1);
		expect(mockProjectMemberFindFirst).not.toHaveBeenCalled();
		expect(mockMemberFindFirst).not.toHaveBeenCalled();
	});

	describe("personal projects (no organizationId)", () => {
		it("grants the owner access with organizationId: null", async () => {
			mockProjectFindFirst.mockResolvedValue({
				id: "p1",
				userId: "owner1",
				organizationId: null,
			});

			const result = await getProjectAccessContext("p1", "owner1");

			expect(result).toEqual({ organizationId: null });
			expect(mockProjectFindFirst).toHaveBeenCalledTimes(1);
			// Owner short-circuits before the membership check.
			expect(mockProjectMemberFindFirst).not.toHaveBeenCalled();
		});

		it("grants an accepted, non-expired collaborator access", async () => {
			mockProjectFindFirst.mockResolvedValue({
				id: "p1",
				userId: "owner1",
				organizationId: null,
			});
			mockProjectMemberFindFirst.mockResolvedValue({ id: "member1" });

			const result = await getProjectAccessContext("p1", "collaborator1");

			expect(result).toEqual({ organizationId: null });
		});

		it("denies a user with no membership row", async () => {
			mockProjectFindFirst.mockResolvedValue({
				id: "p1",
				userId: "owner1",
				organizationId: null,
			});
			mockProjectMemberFindFirst.mockResolvedValue(null);

			const result = await getProjectAccessContext("p1", "stranger1");

			expect(result).toBeNull();
		});

		it("preserves a stored empty-string organizationId instead of normalizing it to null", async () => {
			// The column is a nullable String with no non-empty constraint, so
			// a row can hold "" rather than null. "" is falsy, so it still
			// routes through the personal-project branch — but a caller doing
			// a tenant-XOR comparison needs the exact stored value back, not
			// a normalized `null`, or a row with organizationId: "" would
			// pass an XOR check it should fail.
			mockProjectFindFirst.mockResolvedValue({
				id: "p1",
				userId: "owner1",
				organizationId: "",
			});

			const result = await getProjectAccessContext("p1", "owner1");

			expect(result).toEqual({ organizationId: "" });
		});
	});

	describe("organization projects", () => {
		it("grants the owner access when they are also an org member", async () => {
			mockProjectFindFirst.mockResolvedValue({
				id: "p1",
				userId: "owner1",
				organizationId: "org1",
			});
			mockMemberFindFirst.mockResolvedValue({ id: "member-row" });
			mockProjectMemberFindFirst.mockResolvedValue(null);

			const result = await getProjectAccessContext("p1", "owner1");

			expect(result).toEqual({ organizationId: "org1" });
		});

		it("grants a non-owner org member with an accepted ProjectMember row", async () => {
			mockProjectFindFirst.mockResolvedValue({
				id: "p1",
				userId: "owner1",
				organizationId: "org1",
			});
			mockMemberFindFirst.mockResolvedValue({ id: "member-row" });
			mockProjectMemberFindFirst.mockResolvedValue({ id: "pm1" });

			const result = await getProjectAccessContext("p1", "collaborator1");

			expect(result).toEqual({ organizationId: "org1" });
		});

		it("denies a non-owner org member with no ProjectMember row", async () => {
			mockProjectFindFirst.mockResolvedValue({
				id: "p1",
				userId: "owner1",
				organizationId: "org1",
			});
			mockMemberFindFirst.mockResolvedValue({ id: "member-row" });
			mockProjectMemberFindFirst.mockResolvedValue(null);

			const result = await getProjectAccessContext("p1", "collaborator1");

			expect(result).toBeNull();
		});

		it("grants a project-scoped guest with no OrgMember row but an accepted ProjectMember row", async () => {
			mockProjectFindFirst.mockResolvedValue({
				id: "p1",
				userId: "owner1",
				organizationId: "org1",
			});
			mockMemberFindFirst.mockResolvedValue(null);
			mockProjectMemberFindFirst.mockResolvedValue({ id: "pm1" });

			const result = await getProjectAccessContext("p1", "guest1");

			expect(result).toEqual({ organizationId: "org1" });
		});

		it("denies a caller with neither an OrgMember nor a ProjectMember row", async () => {
			mockProjectFindFirst.mockResolvedValue({
				id: "p1",
				userId: "owner1",
				organizationId: "org1",
			});
			mockMemberFindFirst.mockResolvedValue(null);
			mockProjectMemberFindFirst.mockResolvedValue(null);

			const result = await getProjectAccessContext("p1", "nobody1");

			expect(result).toBeNull();
		});
	});

	it("runs exactly one Project query per call", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "p1",
			userId: "owner1",
			organizationId: null,
		});

		await getProjectAccessContext("p1", "owner1");

		expect(mockProjectFindFirst).toHaveBeenCalledTimes(1);
	});
});

describe("hasProjectAccess (thin wrapper)", () => {
	it("returns true when getProjectAccessContext would resolve access", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "p1",
			userId: "owner1",
			organizationId: null,
		});

		await expect(hasProjectAccess("p1", "owner1")).resolves.toBe(true);
	});

	it("returns false when getProjectAccessContext would deny access", async () => {
		mockProjectFindFirst.mockResolvedValue(null);

		await expect(hasProjectAccess("p1", "owner1")).resolves.toBe(false);
	});
});
