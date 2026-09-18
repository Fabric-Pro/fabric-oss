import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.hoisted(() => vi.fn());
const mockConfiguredProviders = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => ({
	db: { aiModel: { findMany: mockFindMany } },
	getProviderDisplayName: (provider: string) => provider,
}));

vi.mock("../../../lib/configured-providers", () => ({
	getConfiguredProviders: (...args: unknown[]) =>
		mockConfiguredProviders(...args),
	PROVIDERS_WITH_SUBPROVIDERS: new Set(["VERCEL_GATEWAY"]),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string) => organizationId,
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: { ORG_AI_CONFIG_READ: "org_ai_config_read" },
	};
});

import { listAvailableModelsProcedure } from "../list-available";

const listAvailable = listAvailableModelsProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: { user: { id: string }; session: unknown };
	}) => Promise<unknown>;
};

const context = { user: { id: "user-1" }, session: {} };

beforeEach(() => {
	vi.clearAllMocks();
	mockConfiguredProviders.mockResolvedValue({
		allProviders: [
			{
				id: "vercel-config",
				provider: "VERCEL_GATEWAY",
				displayName: "Vercel AI Gateway",
				isDefault: true,
				priority: 1,
				enabledProviders: [],
				source: "org_config",
			},
		],
		defaultProvider: { provider: "VERCEL_GATEWAY" },
		defaultProviderType: "VERCEL_GATEWAY",
		effectiveProviders: ["VERCEL_GATEWAY"],
	});
	mockFindMany.mockResolvedValue([]);
});

describe("available decision models", () => {
	it("queries only DECISION-suitable models for the typed decision selector", async () => {
		await listAvailable._handler({
			input: { organizationId: "org-1", taskType: "DECISION" },
			context,
		});

		expect(mockConfiguredProviders).toHaveBeenCalledWith(
			"user-1",
			"org-1",
			"DECISION",
		);
		expect(mockFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					suitableForTasks: { has: "DECISION" },
				}),
			}),
		);
	});

	it("excludes decision models from the ordinary language-model response", async () => {
		await listAvailable._handler({
			input: { organizationId: "org-1" },
			context,
		});

		expect(mockFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					NOT: { suitableForTasks: { has: "DECISION" } },
				}),
			}),
		);
	});
});
