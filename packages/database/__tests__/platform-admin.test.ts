import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { member, findUser, updateUser, audit, upsert } = vi.hoisted(() => ({
	member: vi.fn(),
	findUser: vi.fn(),
	updateUser: vi.fn(),
	audit: vi.fn(),
	upsert: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		member: { findUnique: member },
		user: { create: vi.fn(), update: updateUser },
		$transaction: (fn: (tx: unknown) => unknown) =>
			fn({
				user: { findUnique: findUser, update: updateUser },
				member: {
					upsert,
					findMany: vi.fn(async () => [{ userId: "example-user" }]),
				},
				organization: { delete: vi.fn() },
				agentWorkspaceFile: { deleteMany: vi.fn() },
			}),
	},
}));
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: audit }));

import { permanentDeleteOrganization } from "../prisma/queries/organizations/deletion";
import {
	addOperatorMembershipForAdmin,
	demoteDepartingOperator,
	hasOperatorMembership,
	includesAdminRole,
	isPlatformAdmin,
} from "../prisma/queries/platform-admin";
import {
	createUser,
	updateUser as updateStoredUser,
} from "../prisma/queries/users";

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("OPERATOR_ORGANIZATION_ID", "example-org");
});
afterEach(() => vi.unstubAllEnvs());
describe("platform admin", () => {
	it.each([undefined, ""])(
		"preserves role-only access for %s",
		async (value) => {
			vi.stubEnv("OPERATOR_ORGANIZATION_ID", value);
			expect(
				await isPlatformAdmin({ id: "example-user", role: "admin" }),
			).toBe(true);
			expect(member).not.toHaveBeenCalled();
		},
	);
	it.each(["admin"])("requires membership for %s", async (role) => {
		expect(await isPlatformAdmin({ id: "example-user", role })).toBe(false);
		member.mockResolvedValue({ id: "example-member" });
		expect(await isPlatformAdmin({ id: "example-user", role })).toBe(true);
		expect(member).toHaveBeenCalledWith({
			where: {
				organizationId_userId: {
					organizationId: "example-org",
					userId: "example-user",
				},
			},
			select: { id: true },
		});
	});
	it.each([undefined, "", "example-org"])(
		"rejects combined read-side roles with setting %s",
		async (setting) => {
			vi.stubEnv("OPERATOR_ORGANIZATION_ID", setting);
			member.mockResolvedValue({ id: "example-member" });
			expect(
				await isPlatformAdmin({
					id: "example-user",
					role: "admin,user",
				}),
			).toBe(false);
			expect(
				await isPlatformAdmin({
					id: "example-user",
					role: "user,admin",
				}),
			).toBe(false);
			expect(member).not.toHaveBeenCalled();
		},
	);

	it("rejects non-admin roles and recognizes arrays", async () => {
		expect(
			await isPlatformAdmin({ id: "example-user", role: "user" }),
		).toBe(false);
		expect(includesAdminRole(["user", "admin"])).toBe(true);
		expect(includesAdminRole("superadmin")).toBe(false);
		expect(await hasOperatorMembership()).toBe(false);
	});
	it("propagates lookup errors", async () => {
		member.mockRejectedValue(new Error("unavailable"));
		await expect(
			isPlatformAdmin({ id: "example-user", role: "admin" }),
		).rejects.toThrow("unavailable");
	});
	it.each([
		["admin", "user"],
		["admin,user", "user"],
		["editor,admin,user", "editor,user"],
	])("demotes %s to %s with atomic audit", async (from, to) => {
		findUser.mockResolvedValue({ role: from });
		await demoteDepartingOperator("example-org", "example-user");
		expect(updateUser).toHaveBeenCalledWith({
			where: { id: "example-user" },
			data: { role: to },
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "account.role_changed",
				metadata: {
					fromRole: from,
					toRole: to,
					reason: "operator_membership_ended",
				},
			}),
		);
	});
	it("does not demote for other organizations or absent configuration", async () => {
		await demoteDepartingOperator("another-org", "example-user");
		vi.stubEnv("OPERATOR_ORGANIZATION_ID", "");
		await demoteDepartingOperator("example-org", "example-user");
		expect(findUser).not.toHaveBeenCalled();
	});
	it("provisions ordinary operator membership through the supplied transaction", async () => {
		const tx = { member: { upsert } };
		await addOperatorMembershipForAdmin(tx as never, {
			id: "example-user",
			role: "admin,user",
		});
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					role: "member",
					organizationId: "example-org",
					userId: "example-user",
				}),
				update: {},
			}),
		);
	});
});

it("refuses generic admin creation when configured", async () => {
	await expect(
		createUser({
			email: "dev@example.com",
			name: "Example",
			role: "admin",
			emailVerified: true,
			onboardingComplete: true,
		}),
	).rejects.toThrow("transactional admin provisioning");
});
it("refuses generic promotion of a non-member", async () => {
	await expect(
		updateStoredUser({ id: "example-user", role: "admin,user" }),
	).rejects.toThrow("operator organization membership");
});
it("demotes operator members in the purge transaction", async () => {
	findUser.mockResolvedValue({ role: "admin,user" });
	await permanentDeleteOrganization("example-org");
	expect(updateUser).toHaveBeenCalledWith({
		where: { id: "example-user" },
		data: { role: "user" },
	});
	expect(audit).toHaveBeenCalled();
});

it("allows promotion of an operator member", async () => {
	member.mockResolvedValue({ id: "example-member" });
	await updateStoredUser({ id: "example-user", role: "admin,user" });
	expect(updateUser).toHaveBeenCalledWith(
		expect.objectContaining({ where: { id: "example-user" } }),
	);
});
it("keeps generic admin creation and update available when unset", async () => {
	vi.stubEnv("OPERATOR_ORGANIZATION_ID", "");
	await createUser({
		email: "dev@example.com",
		name: "Example",
		role: "admin",
		emailVerified: true,
		onboardingComplete: true,
	});
	await updateStoredUser({ id: "example-user", role: "admin" });
	expect(member).not.toHaveBeenCalled();
});
