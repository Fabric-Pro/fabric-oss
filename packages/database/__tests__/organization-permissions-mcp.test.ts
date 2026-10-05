/**
 * Contract tests for `canReadOrganizationMcpConfigs` and
 * `canConnectOrganizationMcpConfigs` (Fizzy #2897).
 *
 * The Next.js routes that run a stored MCP config ask these before they read
 * the config, because the config and its token outlive the owner's membership.
 * Three properties are worth pinning:
 *
 *  - each helper asks the matrix for its own permission, so read and connect
 *    cannot collapse into one question;
 *  - a missing membership row is a "no", not a crash and not a pass;
 *  - an unrecognised role string is also a "no". Fail closed.
 *
 * The permission matrix is NOT mocked, and no fixture asserts a hard-coded
 * verdict for a role: the expectations are cross-checked against the live
 * matrix, as the batch sibling's suite does, so a matrix edit moves them too.
 */
import {
	hasPermission,
	type Permission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ memberFindFirst: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: { member: { findFirst: mocks.memberFindFirst } },
}));

import {
	canConnectOrganizationMcpConfigs,
	canReadOrganizationMcpConfigs,
} from "../prisma/queries/organization-permissions";

const ORG = "org_1";

/** `auditor` is a string the matrix does not know. */
const ROLES: Record<string, string> = {
	user_viewer: "viewer",
	user_member: "member",
	user_admin: "admin",
	user_owner: "owner",
	user_stale: "auditor",
};

beforeEach(() => {
	mocks.memberFindFirst
		.mockReset()
		.mockImplementation(
			async (args: {
				where: { organizationId: string; userId: string };
			}) => {
				const role = ROLES[args.where.userId];
				return args.where.organizationId === ORG && role !== undefined
					? { role }
					: null;
			},
		);
});

describe.each([
	[
		"canReadOrganizationMcpConfigs",
		canReadOrganizationMcpConfigs,
		Permissions.MCP_READ,
	],
	[
		"canConnectOrganizationMcpConfigs",
		canConnectOrganizationMcpConfigs,
		Permissions.MCP_CONNECT,
	],
] as const)("%s", (_name, helper, permission: Permission) => {
	it("answers each role as the live matrix does, in one read", async () => {
		for (const userId of [
			"user_viewer",
			"user_member",
			"user_admin",
			"user_owner",
		]) {
			mocks.memberFindFirst.mockClear();

			const allowed = await helper(userId, ORG);

			expect(allowed).toBe(
				hasPermission(resolveOrgPermissions(ROLES[userId]), permission),
			);
			expect(mocks.memberFindFirst).toHaveBeenCalledTimes(1);
			expect(mocks.memberFindFirst).toHaveBeenCalledWith({
				where: { organizationId: ORG, userId },
				select: { role: true },
			});
		}
	});

	it("refuses somebody with no membership row in the organization", async () => {
		expect(await helper("ghost", ORG)).toBe(false);
		expect(await helper("user_owner", "org_other")).toBe(false);
	});

	it("refuses a role string the matrix does not recognise", async () => {
		expect(await helper("user_stale", ORG)).toBe(false);
	});
});

it("keeps read and connect distinct for at least one role", async () => {
	// If the matrix ever gave every role both permissions, the two questions
	// would be indistinguishable and the routes' read/connect split would be
	// decoration. Asserted against the matrix, not against a named role.
	const distinct = Object.values(ROLES).some(
		(role) =>
			hasPermission(resolveOrgPermissions(role), Permissions.MCP_READ) !==
			hasPermission(resolveOrgPermissions(role), Permissions.MCP_CONNECT),
	);
	expect(distinct).toBe(true);
});
