import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.hoisted(() => vi.fn());
vi.mock("../prisma/client", () => ({
	db: { organizationModelPreference: { findFirst } },
	Prisma: {},
}));

import { getOrgDecisionProvider } from "../prisma/queries/ai-models";

beforeEach(() => vi.clearAllMocks());
describe("organization decision provider", () => {
	it.each(["DATABRICKS", "VERCEL_GATEWAY", null])(
		"returns the stored provider %s within the organization",
		async (provider) => {
			findFirst.mockResolvedValue(provider ? { provider } : null);
			expect(await getOrgDecisionProvider("example-org")).toBe(provider);
			expect(findFirst).toHaveBeenCalledWith({
				where: { organizationId: "example-org", taskType: "DECISION" },
				orderBy: { updatedAt: "desc" },
				select: { provider: true },
			});
		},
	);
});
