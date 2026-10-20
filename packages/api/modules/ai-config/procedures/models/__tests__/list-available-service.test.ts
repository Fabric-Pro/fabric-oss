import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	service: vi.fn(),
	permission: vi.fn(),
	handler: vi.fn(),
}));
vi.mock("../../../lib/available-models", () => ({
	listAvailableModels: mocks.service,
}));
vi.mock("../../../../../orpc/procedures", () => {
	type Builder = {
		use: () => Builder;
		route: () => Builder;
		input: () => Builder;
		output: () => Builder;
		handler: typeof mocks.handler;
	};
	const builder: Builder = {
		use: () => builder,
		route: () => builder,
		input: () => builder,
		output: () => builder,
		handler: mocks.handler,
	};
	return {
		tenantProtectedProcedure: builder,
		Permissions: { ORG_AI_CONFIG_READ: "org:ai-config:read" },
		requireInputOrgPermission: mocks.permission,
		resolveOrganizationId: (
			id: string | undefined,
			session: { activeOrganizationId: string },
		) => id ?? session.activeOrganizationId,
	};
});

import "../list-available";

describe("available-model route/service parity", () => {
	it("keeps the existing permission gate and passes the resolved and session tenants separately", async () => {
		const result = {
			models: [],
			chatgptPlan: null,
			configuredProviders: [],
			defaultProvider: null,
			providerIds: [],
			modelsByProvider: {},
			modelsByGatewayAndProvider: {},
		};
		mocks.service.mockResolvedValueOnce(result);
		const handler = mocks.handler.mock.calls[0][0];
		expect(
			await handler({
				context: {
					user: { id: "user-1" },
					session: { activeOrganizationId: "org-1" },
				},
				input: {
					organizationId: "org-2",
					taskType: "CHAT",
					planTaskType: "TOOL_CALLING",
				},
			}),
		).toBe(result);
		expect(mocks.permission).toHaveBeenCalledWith("org:ai-config:read");
		expect(mocks.service).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-2",
			sessionOrganizationId: "org-1",
			taskType: "CHAT",
			planTaskType: "TOOL_CALLING",
		});
	});
});
