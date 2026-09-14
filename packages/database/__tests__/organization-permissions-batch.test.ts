/**
 * Contract tests for `usersWhoCanCreateOrganizationApiKeys` (Fizzy #2457).
 *
 * The batch sibling of the single-user helpers in the same module, and the only
 * one of them shaped for a LIST. It exists because the CLI-connection ask
 * resolves an audience and has to drop everyone who could not act on it: asked
 * one person at a time, that is a round trip per candidate on a surface where
 * one function tag can name a whole project.
 *
 * Three properties are worth pinning, and they are the three a re-implementation
 * somewhere else would get subtly wrong:
 *
 *  - ONE read for the whole list, not one per person;
 *  - a missing membership row is a "no", not a crash and not a pass — this is
 *    the project guest, who reaches a project without belonging to its
 *    organization;
 *  - an unrecognised role string is also a "no". Fail closed.
 *
 * The permission matrix is NOT mocked. No fixture here names a role and asserts
 * a hard-coded verdict, because which ranks carry `ORG_API_KEYS_CREATE` has
 * already moved twice; the eligible fixtures are cross-checked against the live
 * matrix instead, so a matrix edit moves this test's expectations with it rather
 * than leaving them quietly stale.
 */
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ memberFindMany: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: { member: { findMany: mocks.memberFindMany } },
}));

import { usersWhoCanCreateOrganizationApiKeys } from "../prisma/queries/organization-permissions";

const ORG = "org_1";

/**
 * Roles the fixtures hold. `ghost` has no row at all and `auditor` is a string
 * the matrix does not know — the two structural refusals, chosen because no
 * edit to the matrix can turn either into a pass.
 */
const ROLES: Record<string, string> = {
	user_member: "member",
	user_admin: "admin",
	user_owner: "owner",
	user_viewer: "viewer",
	user_stale: "auditor",
};

/** Prisma's answer: one row per id that actually has a membership. */
function membershipRows(userIds: string[]) {
	return userIds
		.filter((userId) => ROLES[userId] !== undefined)
		.map((userId) => ({ userId, role: ROLES[userId] }));
}

beforeEach(() => {
	mocks.memberFindMany
		.mockReset()
		.mockImplementation(
			async (args: {
				where: { organizationId: string; userId: { in: string[] } };
			}) =>
				args.where.organizationId === ORG
					? membershipRows(args.where.userId.in)
					: [],
		);
});

describe("usersWhoCanCreateOrganizationApiKeys", () => {
	it("answers the whole list in a single indexed read", async () => {
		const asked = [
			"user_viewer",
			"user_member",
			"user_admin",
			"user_owner",
		];

		const holders = await usersWhoCanCreateOrganizationApiKeys(ORG, asked);

		expect(mocks.memberFindMany).toHaveBeenCalledTimes(1);
		expect(mocks.memberFindMany).toHaveBeenCalledWith({
			where: { organizationId: ORG, userId: { in: asked } },
			select: { userId: true, role: true },
		});
		// Cross-checked against the live matrix rather than asserted flat, so
		// this test cannot outlive a change to which ranks may mint a key.
		for (const userId of asked) {
			expect(holders.has(userId)).toBe(
				hasPermission(
					resolveOrgPermissions(ROLES[userId]),
					Permissions.ORG_API_KEYS_CREATE,
				),
			);
		}
	});

	it("refuses somebody with no membership row in this organization", async () => {
		// The project guest: reaches a project through a `ProjectMember` row
		// and belongs to no organization, so there is no role to resolve.
		const holders = await usersWhoCanCreateOrganizationApiKeys(ORG, [
			"user_member",
			"ghost",
		]);

		expect(holders.has("ghost")).toBe(false);
		expect(holders.has("user_member")).toBe(
			hasPermission(
				resolveOrgPermissions("member"),
				Permissions.ORG_API_KEYS_CREATE,
			),
		);
	});

	it("refuses a role string the matrix does not recognise", async () => {
		const holders = await usersWhoCanCreateOrganizationApiKeys(ORG, [
			"user_stale",
		]);

		// Fail closed: an unknown role resolves to the empty permission set.
		expect(holders.size).toBe(0);
		expect(
			hasPermission(
				resolveOrgPermissions("auditor"),
				Permissions.ORG_API_KEYS_CREATE,
			),
		).toBe(false);
	});

	it("asks nothing when there is nobody, or no tenant, to ask about", async () => {
		expect(await usersWhoCanCreateOrganizationApiKeys(ORG, [])).toEqual(
			new Set(),
		);
		expect(
			await usersWhoCanCreateOrganizationApiKeys("", ["user_member"]),
		).toEqual(new Set());

		// An empty `IN ()` is a read that can only answer nobody, and an empty
		// organization id is "the caller named nothing" — the same reading its
		// membership sibling takes.
		expect(mocks.memberFindMany).not.toHaveBeenCalled();
	});

	it("asks about each person once, however many times they were named", async () => {
		await usersWhoCanCreateOrganizationApiKeys(ORG, [
			"user_member",
			"user_member",
			"user_admin",
		]);

		expect(mocks.memberFindMany.mock.calls[0][0].where.userId.in).toEqual([
			"user_member",
			"user_admin",
		]);
	});

	it("returns a set the caller can filter with, not a per-person verdict", async () => {
		const holders = await usersWhoCanCreateOrganizationApiKeys(ORG, [
			"user_member",
			"ghost",
			"user_stale",
		]);

		expect(holders).toBeInstanceOf(Set);
		// Everyone absent is ineligible, for one of two reasons the caller
		// does not have to tell apart.
		expect(
			[...holders].every((userId) => ROLES[userId] !== undefined),
		).toBe(true);
	});
});
