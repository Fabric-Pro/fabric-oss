import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ member: vi.fn() }));
vi.mock("../prisma/client", () => ({
	db: { member: { findFirst: m.member } },
}));

import {
	canReadOrganizationAgents,
	canScheduleOrganizationAgents,
} from "../prisma/queries/organization-permissions";

beforeEach(() => vi.resetAllMocks());
describe("agent control current role predicates", () => {
	it.each(["owner", "admin", "member"])(
		"allows recurring work for current %s",
		async (role) => {
			m.member.mockResolvedValue({ role });
			expect(
				await canScheduleOrganizationAgents(
					"example-user",
					"example-org",
				),
			).toBe(true);
			expect(m.member).toHaveBeenCalledWith({
				where: {
					userId: "example-user",
					organizationId: "example-org",
				},
				select: { role: true },
			});
		},
	);
	it.each([null, { role: "viewer" }, { role: "unknown" }])(
		"does not grant recurring work to removed/read-only/unrecognized role",
		async (member) => {
			m.member.mockResolvedValue(member);
			expect(
				await canScheduleOrganizationAgents(
					"example-user",
					"example-org",
				),
			).toBe(false);
		},
	);
	it("read is permitted for a viewer but not unknown/removed membership", async () => {
		m.member.mockResolvedValue({ role: "viewer" });
		expect(
			await canReadOrganizationAgents("example-user", "example-org"),
		).toBe(true);
		m.member.mockResolvedValue(null);
		expect(
			await canReadOrganizationAgents("example-user", "example-org"),
		).toBe(false);
	});
});
