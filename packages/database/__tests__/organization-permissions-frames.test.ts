import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ membership: vi.fn() }));
vi.mock("../prisma/client", () => ({
	db: { member: { findFirst: m.membership } },
}));

import {
	canDeleteOrganizationFrames,
	canUpdateOrganizationFrames,
} from "../prisma/queries/organization-permissions";

beforeEach(() => vi.clearAllMocks());
it("keeps revocation's delete capability separate from editing and sharing", async () => {
	m.membership.mockResolvedValue({ role: "member" });
	expect(
		await canUpdateOrganizationFrames("example-user", "example-org"),
	).toBe(true);
	expect(
		await canDeleteOrganizationFrames("example-user", "example-org"),
	).toBe(false);
	expect(m.membership).toHaveBeenCalledWith({
		where: { organizationId: "example-org", userId: "example-user" },
		select: { role: true },
	});
});
it.each(["owner", "admin"])(
	"allows current %s revocation capability",
	async (role) => {
		m.membership.mockResolvedValue({ role });
		expect(
			await canDeleteOrganizationFrames("example-user", "example-org"),
		).toBe(true);
	},
);
it.each([null, { role: "viewer" }, { role: "example-unknown" }])(
	"refuses missing, demoted or unknown membership: %s",
	async (row) => {
		m.membership.mockResolvedValue(row);
		expect(
			await canDeleteOrganizationFrames("example-user", "example-org"),
		).toBe(false);
	},
);
it("rechecks capability after the creator's membership is removed", async () => {
	m.membership
		.mockResolvedValueOnce({ role: "owner" })
		.mockResolvedValueOnce(null);
	expect(
		await canDeleteOrganizationFrames("example-user", "example-org"),
	).toBe(true);
	expect(
		await canDeleteOrganizationFrames("example-user", "example-org"),
	).toBe(false);
});
