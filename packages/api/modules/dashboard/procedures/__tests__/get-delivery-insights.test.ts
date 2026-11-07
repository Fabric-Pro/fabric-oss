import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDeliveryInsights } = vi.hoisted(() => ({
	getDeliveryInsights: vi.fn(),
}));

vi.mock("@repo/database", () => ({ getDeliveryInsights }));
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

import { getDashboardDeliveryInsights } from "../get-delivery-insights";

describe("getDashboardDeliveryInsights", () => {
	beforeEach(() => {
		getDeliveryInsights.mockReset();
		getDeliveryInsights.mockResolvedValue({});
	});

	it("passes the resolved organization, caller, and range to the query", async () => {
		await (
			getDashboardDeliveryInsights as unknown as (
				args: unknown,
			) => Promise<unknown>
		)({
			input: { organizationId: "org-a", days: 90 },
			context: {
				user: { id: "user-1" },
				session: { activeOrganizationId: "org-b" },
			},
		});

		expect(getDeliveryInsights).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-a",
			days: 90,
		});
	});

	it("fails closed when no organization can be resolved", async () => {
		await expect(
			(
				getDashboardDeliveryInsights as unknown as (
					args: unknown,
				) => Promise<unknown>
			)({
				input: { organizationId: null, days: 30 },
				context: {
					user: { id: "user-1" },
					session: { activeOrganizationId: null },
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(getDeliveryInsights).not.toHaveBeenCalled();
	});
});
