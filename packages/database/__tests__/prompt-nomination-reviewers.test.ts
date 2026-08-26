/**
 * Who gets told a nomination is waiting.
 *
 * FR16. The list must be exactly the people who can decide it — the same
 * authority the approve procedure enforces — because a notification whose only
 * possible outcome is a permission error is worse than no notification.
 *
 * The trap is that the two tiers resolve through DIFFERENT fields. A universal
 * default is inherited by every tenant that has not overridden it, so no amount
 * of authority inside one organization qualifies; that tier is the platform
 * admin's, `User.role`. An organization default is `Member.role`, for that one
 * organization. Using either field for the other's tier either notifies people
 * who cannot act or misses the ones who can.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-nomination-reviewers.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { userFindMany, memberFindMany } = vi.hoisted(() => ({
	userFindMany: vi.fn(),
	memberFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		user: { findMany: userFindMany },
		member: { findMany: memberFindMany },
	},
	Prisma: {},
}));

import { listPromptNominationReviewers } from "../prisma/queries/prompt-nomination-reviewers";

beforeEach(() => {
	userFindMany.mockReset();
	userFindMany.mockResolvedValue([]);
	memberFindMany.mockReset();
	memberFindMany.mockResolvedValue([]);
});

describe("system-tier nominations", () => {
	it("asks for platform admins, not organization owners", async () => {
		userFindMany.mockResolvedValue([{ id: "admin-1" }]);

		const reviewers = await listPromptNominationReviewers({
			targetScope: "SYSTEM",
		});

		expect(userFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { role: "admin" } }),
		);
		// Never the member table: org authority does not confer platform
		// authority, and this is the tier every tenant inherits.
		expect(memberFindMany).not.toHaveBeenCalled();
		expect(reviewers).toEqual([
			{ userId: "admin-1", organizationId: null },
		]);
	});

	it("does not tell the nominator about their own proposal", async () => {
		userFindMany.mockResolvedValue([{ id: "admin-1" }, { id: "member-1" }]);

		const reviewers = await listPromptNominationReviewers({
			targetScope: "SYSTEM",
			excludeUserId: "member-1",
		});

		expect(reviewers.map((r) => r.userId)).toEqual(["admin-1"]);
	});
});

describe("organization-tier nominations", () => {
	it("asks only for admins and owners of that organization", async () => {
		memberFindMany.mockResolvedValue([
			{ userId: "u-1", organizationId: "org-a" },
		]);

		await listPromptNominationReviewers({
			targetScope: "ORG",
			organizationId: "org-a",
		});

		expect(memberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId: "org-a",
					role: { in: ["admin", "owner"] },
				},
			}),
		);
		expect(userFindMany).not.toHaveBeenCalled();
	});

	it("returns nobody when there is no organization to scope to", async () => {
		// Rather than falling back to every admin everywhere, which would leak
		// the existence of one tenant's proposal to another's reviewers.
		const reviewers = await listPromptNominationReviewers({
			targetScope: "ORG",
			organizationId: null,
		});

		expect(reviewers).toEqual([]);
		expect(memberFindMany).not.toHaveBeenCalled();
	});

	it("excludes the nominator even when they are an admin themselves", async () => {
		memberFindMany.mockResolvedValue([
			{ userId: "admin-1", organizationId: "org-a" },
			{ userId: "admin-2", organizationId: "org-a" },
		]);

		const reviewers = await listPromptNominationReviewers({
			targetScope: "ORG",
			organizationId: "org-a",
			excludeUserId: "admin-1",
		});

		expect(reviewers.map((r) => r.userId)).toEqual(["admin-2"]);
	});

	it("returns one row per person", async () => {
		memberFindMany.mockResolvedValue([
			{ userId: "admin-1", organizationId: "org-a" },
			{ userId: "admin-1", organizationId: "org-a" },
		]);

		const reviewers = await listPromptNominationReviewers({
			targetScope: "ORG",
			organizationId: "org-a",
		});

		expect(reviewers).toHaveLength(1);
	});
});
