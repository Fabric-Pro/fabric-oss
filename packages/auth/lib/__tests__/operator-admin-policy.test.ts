import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { member } = vi.hoisted(() => ({ member: vi.fn() }));
vi.mock("../../../database/prisma/client", () => ({
	db: { member: { findUnique: member } },
}));
vi.mock("../../../database/prisma/queries/audit-log", () => ({
	recordAuditTx: vi.fn(),
}));
vi.mock(
	"@repo/database",
	async () => await import("../../../database/prisma/queries/platform-admin"),
);

import { enforceOperatorAdminPolicy } from "../operator-admin-policy";

const caller = vi.fn(
	async (): Promise<{ id: string; role: string } | null> => ({
		id: "example-caller",
		role: "admin",
	}),
);
beforeEach(() => {
	vi.stubEnv("OPERATOR_ORGANIZATION_ID", "example-org");
	member.mockReset();
	member.mockImplementation(async ({ where }) =>
		where.organizationId_userId.userId === "example-caller"
			? { id: "example-member" }
			: null,
	);
	caller.mockReset();
	caller.mockResolvedValue({ id: "example-caller", role: "admin" });
});
afterEach(() => vi.unstubAllEnvs());
describe("operator admin before-hook policy", () => {
	it.each([
		[
			"/admin/set-role",
			{ userId: "example-target", role: ["admin", "user"] },
		],
		["/admin/create-user", { role: "admin,user" }],
		["/admin/create-user", { data: { role: "admin" } }],
		[
			"/admin/update-user",
			{ userId: "example-target", data: { role: "user,admin" } },
		],
	])("refuses a non-member grant at %s (%j)", async (path, body) => {
		await expect(
			enforceOperatorAdminPolicy({ path, body }, caller),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
	});
	it.each(["/admin/set-role", "/admin/update-user"])(
		"allows existing member grant at %s",
		async (path) => {
			member.mockResolvedValue({ id: "example-member" });
			await expect(
				enforceOperatorAdminPolicy(
					{
						path,
						body: {
							userId: "example-target",
							role: "admin",
							data: { role: "admin" },
						},
					},
					caller,
				),
			).resolves.toBeUndefined();
		},
	);
	it("refuses a stale admin caller on list-users", async () => {
		member.mockResolvedValue(null);
		await expect(
			enforceOperatorAdminPolicy({ path: "/admin/list-users" }, caller),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
	});
	it("allows stop-impersonating without admin membership", async () => {
		member.mockRejectedValue(new Error("unavailable"));
		await enforceOperatorAdminPolicy(
			{ path: "/admin/stop-impersonating" },
			caller,
		);
		expect(caller).not.toHaveBeenCalled();
	});
	it("fails closed on lookup error", async () => {
		member.mockRejectedValue(new Error("unavailable"));
		await expect(
			enforceOperatorAdminPolicy({ path: "/admin/list-users" }, caller),
		).rejects.toThrow("unavailable");
	});
	it("preserves grants when unset and allows non-admin account creation", async () => {
		await enforceOperatorAdminPolicy(
			{ path: "/admin/create-user", body: { role: "user" } },
			caller,
		);
		vi.stubEnv("OPERATOR_ORGANIZATION_ID", "");
		await enforceOperatorAdminPolicy(
			{ path: "/admin/create-user", body: { role: "admin" } },
			caller,
		);
	});
});

it("refuses combined plugin caller roles when configured", async () => {
	caller.mockResolvedValue({ id: "example-caller", role: "admin,user" });
	await expect(
		enforceOperatorAdminPolicy({ path: "/admin/list-users" }, caller),
	).rejects.toMatchObject({ status: "FORBIDDEN" });
});

it.each([
	{ id: "example-caller", role: "admin,user" },
	{ id: "example-outsider", role: "user" },
	null,
])("leaves every caller to Better Auth when unset (%o)", async (user) => {
	vi.stubEnv("OPERATOR_ORGANIZATION_ID", "");
	caller.mockResolvedValue(user);
	await enforceOperatorAdminPolicy({ path: "/admin/list-users" }, caller);
	expect(caller).not.toHaveBeenCalled();
	expect(member).not.toHaveBeenCalled();
});
