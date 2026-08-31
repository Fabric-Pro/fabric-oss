/**
 * Contract tests for `hasOrganizationTie`.
 *
 * The distinction it draws is the whole reason it exists. `isOrganizationMember`
 * answers "is this caller a member", which is the right question for a
 * membership boundary and the WRONG one for "may this caller act in this tenant
 * at all" — because a project-scoped guest holds no membership row by
 * definition, and refusing them refuses the guest path the product is built
 * around.
 *
 * That was not a hypothetical. A membership-only check on the weave procedures
 * refused every call a real guest's own dashboard made, while the same call
 * succeeded when the organization was simply omitted. These tests pin both
 * halves so the boundary cannot be tightened back into a regression, or
 * loosened into no boundary at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	memberFindFirst: vi.fn(),
	projectMemberFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		member: { findFirst: mocks.memberFindFirst },
		projectMember: { findFirst: mocks.projectMemberFindFirst },
	},
}));

import {
	hasOrganizationTie,
	isOrganizationMember,
} from "../prisma/queries/verify-organization-membership";

const USER = "user_1";
const ORG = "org_1";

beforeEach(() => {
	mocks.memberFindFirst.mockReset().mockResolvedValue(null);
	mocks.projectMemberFindFirst.mockReset().mockResolvedValue(null);
});

describe("hasOrganizationTie", () => {
	it("accepts a member without looking for a project", async () => {
		mocks.memberFindFirst.mockResolvedValue({ id: "m1" });

		expect(await hasOrganizationTie(USER, ORG)).toBe(true);
		expect(mocks.projectMemberFindFirst).not.toHaveBeenCalled();
	});

	it("accepts a project-scoped guest, whom membership alone refuses", async () => {
		mocks.projectMemberFindFirst.mockResolvedValue({ id: "pm1" });

		// The two answers differ, and that difference is the point.
		expect(await isOrganizationMember(USER, ORG)).toBe(false);
		expect(await hasOrganizationTie(USER, ORG)).toBe(true);
	});

	it("refuses a caller with neither tie — the boundary still holds", async () => {
		expect(await hasOrganizationTie(USER, ORG)).toBe(false);
	});

	it("only counts an ACCEPTED, unexpired project membership", async () => {
		await hasOrganizationTie(USER, ORG);

		const where = mocks.projectMemberFindFirst.mock.calls[0][0].where;
		expect(where.acceptedAt).toEqual({ not: null });
		expect(where.project).toEqual({ organizationId: ORG });
		// A pending invitation or a lapsed one is not a tie.
		expect(where.OR).toEqual([
			{ expiresAt: null },
			{ expiresAt: { gt: expect.any(Date) } },
		]);
	});

	it("refuses an empty tenant rather than treating it as a real one", async () => {
		expect(await hasOrganizationTie(USER, "")).toBe(false);
		expect(await hasOrganizationTie("", ORG)).toBe(false);
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});
});
