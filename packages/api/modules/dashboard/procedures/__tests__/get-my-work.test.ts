import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMyWork } = vi.hoisted(() => ({ getMyWork: vi.fn() }));

vi.mock("@repo/database", () => ({ getMyWork }));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		route: () => chain,
		input: () => ({
			...chain,
			handler: (handler: unknown) => handler,
		}),
		handler: (handler: unknown) => handler,
	};
	return {
		Permissions: new Proxy({}, { get: (_target, property) => property }),
		requireInputOrgPermission: vi.fn(),
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
		tenantProtectedProcedure: chain,
	};
});

import { getDashboardMyWork } from "../get-my-work";

describe("getDashboardMyWork", () => {
	beforeEach(() => {
		getMyWork.mockReset();
		getMyWork.mockResolvedValue({});
	});

	it("passes the requested organization and delivery stage to the query", async () => {
		await (
			getDashboardMyWork as unknown as (args: unknown) => Promise<unknown>
		)({
			input: {
				organizationId: "org-a",
				organizationSlug: "example-org",
				limit: 8,
				featureStage: "readyForDev",
			},
			context: {
				user: { id: "user-1" },
				session: { activeOrganizationId: "org-b" },
			},
		});

		expect(getMyWork).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-a",
			organizationSlug: "example-org",
			limit: 8,
			featureStage: "readyForDev",
		});
	});
});
