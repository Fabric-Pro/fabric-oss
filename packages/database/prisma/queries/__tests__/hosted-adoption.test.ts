import { beforeEach, describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({
	organization: vi.fn(),
	project: vi.fn(),
	user: vi.fn(),
}));
vi.mock("../../client", () => ({
	db: {
		organization: { count: counts.organization },
		project: { count: counts.project },
		user: { count: counts.user },
	},
}));

import { getHostedAdoptionCounts } from "../hosted-adoption";
import { FABRIC_SYSTEM_USER_ID } from "../projects/comments";

beforeEach(() => vi.clearAllMocks());
describe("hosted adoption count predicates", () => {
	it("excludes deleted organizations and projects, including projects under deleted organizations, without filtering project status", async () => {
		counts.organization.mockResolvedValue(2);
		counts.project.mockResolvedValue(4);
		counts.user.mockResolvedValue(3);
		expect(await getHostedAdoptionCounts()).toEqual({
			organizations: 2,
			projects: 4,
			users: 3,
		});
		expect(counts.organization).toHaveBeenCalledExactlyOnceWith({
			where: { deletedAt: null },
		});
		expect(counts.project).toHaveBeenCalledExactlyOnceWith({
			where: {
				deletedAt: null,
				OR: [
					{ organizationId: null },
					{ organization: { deletedAt: null } },
				],
			},
		});
	});
	it("excludes the system bot while counting human User rows without banned or membership filters", async () => {
		counts.organization.mockResolvedValue(0);
		counts.project.mockResolvedValue(0);
		counts.user.mockResolvedValue(2);
		expect(await getHostedAdoptionCounts()).toEqual({
			organizations: 0,
			projects: 0,
			users: 2,
		});
		expect(counts.user).toHaveBeenCalledExactlyOnceWith({
			where: { id: { not: FABRIC_SYSTEM_USER_ID } },
		});
	});
	it("returns zero for an empty platform", async () => {
		for (const count of Object.values(counts)) {
			count.mockResolvedValue(0);
		}
		expect(await getHostedAdoptionCounts()).toEqual({
			organizations: 0,
			projects: 0,
			users: 0,
		});
	});
});
