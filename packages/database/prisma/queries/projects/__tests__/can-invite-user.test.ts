/**
 * Owner self-invite guard for `canInviteUser`: the project
 * creator is the permanent owner and is synthesized as an implicit member —
 * there is no `ProjectMember` row for them. A self-invite that resolves to
 * `project.userId` must be rejected before it reaches the "already a
 * member" / "already invited" checks, which would otherwise let a self-invite
 * silently create a demotable member row for the owner.
 *
 * Kept in its own file rather than `function-tags.test.ts`: that file has no
 * hoisted `vi.mock` so Task 3's tests exercise the real
 * `applyGlobalDefaultFunctionTags` helper directly. Adding a `vi.mock` for
 * `../../../client` here would leak into that file if co-located.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockProjectFindUnique,
	mockUserFindUnique,
	mockMemberFindFirst,
	mockInvitationFindFirst,
} = vi.hoisted(() => ({
	mockProjectFindUnique: vi.fn(),
	mockUserFindUnique: vi.fn(),
	mockMemberFindFirst: vi.fn(),
	mockInvitationFindFirst: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		project: {
			findUnique: (...a: unknown[]) => mockProjectFindUnique(...a),
		},
		user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) },
		projectMember: {
			findFirst: (...a: unknown[]) => mockMemberFindFirst(...a),
		},
		projectInvitation: {
			findFirst: (...a: unknown[]) => mockInvitationFindFirst(...a),
		},
	},
	Prisma: {},
}));

import { canInviteUser } from "../members";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("canInviteUser — owner self-invite", () => {
	it("rejects inviting the project owner", async () => {
		mockProjectFindUnique.mockResolvedValue({
			userId: "owner1",
			organizationId: "org1",
		});
		mockUserFindUnique.mockResolvedValue({ id: "owner1" });

		const result = await canInviteUser("p1", "actor", "owner@example.com");

		expect(result).toEqual({
			canInvite: false,
			reason: "Cannot invite the project owner",
		});
		// Rejected before the membership/invitation lookups even run.
		expect(mockMemberFindFirst).not.toHaveBeenCalled();
		expect(mockInvitationFindFirst).not.toHaveBeenCalled();
	});

	it("still allows inviting a non-owner user", async () => {
		mockProjectFindUnique.mockResolvedValue({
			userId: "owner1",
			organizationId: "org1",
		});
		mockUserFindUnique.mockResolvedValue({ id: "someone-else" });
		mockMemberFindFirst.mockResolvedValue(null);
		mockInvitationFindFirst.mockResolvedValue(null);

		const result = await canInviteUser(
			"p1",
			"actor",
			"someone@example.com",
		);

		expect(result).toEqual({ canInvite: true });
	});
});
