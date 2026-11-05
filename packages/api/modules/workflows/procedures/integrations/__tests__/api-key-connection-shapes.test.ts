import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	membership: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("@repo/database", () => ({ listWorkflowIntegrations: mocks.list }));
vi.mock("@repo/utils", () => ({ decryptApiKey: (value: string) => value }));
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		handler: (fn: unknown) => fn,
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { WORKSPACE_READ: "workspace:read" },
		requirePermission: vi.fn(),
		resolveOrganizationId: (id: string) => id,
	};
});

import { testIntegrationConnectionProcedure } from "../test-connection";
import { testSavedConnectionProcedure } from "../test-saved-connection";

type Args = {
	input: {
		type: string;
		credentials?: Record<string, string>;
		organizationId?: string;
	};
	context: { user: { id: string }; session: object };
};
const unsaved = testIntegrationConnectionProcedure as unknown as (
	args: Args,
) => Promise<{ success: boolean }>;
const saved = testSavedConnectionProcedure as unknown as (
	args: Args,
) => Promise<{ success: boolean }>;
const context = { user: { id: "example-user" }, session: {} };
const providers = [
	["BLOB", "BLOB_READ_WRITE_TOKEN"],
	["CLERK", "CLERK_SECRET_KEY"],
	["STRIPE", "STRIPE_SECRET_KEY"],
	["SUPERAGENT", "SUPERAGENT_API_KEY"],
	["WEBFLOW", "WEBFLOW_API_KEY"],
] as const;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.membership.mockResolvedValue({ role: "owner" });
	mocks.fetch.mockImplementation(
		async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());
describe.each(providers)("%s connection key shapes", (type, envKey) => {
	for (const [shape, credentials] of [
		["UI", { apiKey: "example-ui-key" }],
		["legacy", { [envKey]: "example-ui-key" }],
	] as const) {
		it(`tests unsaved ${shape} credentials`, async () => {
			expect(
				(await unsaved({ input: { type, credentials }, context }))
					.success,
			).toBe(true);
			expect(
				new Headers(mocks.fetch.mock.calls[0][1].headers).get(
					"Authorization",
				),
			).toBe("Bearer example-ui-key");
		});
		it(`tests saved ${shape} credentials`, async () => {
			mocks.list.mockResolvedValue([
				{
					id: "example-connection",
					workflowId: null,
					credentials: JSON.stringify(credentials),
				},
			]);
			expect(
				(
					await saved({
						input: { type, organizationId: "example-org" },
						context,
					})
				).success,
			).toBe(true);
			expect(
				new Headers(mocks.fetch.mock.calls[0][1].headers).get(
					"Authorization",
				),
			).toBe("Bearer example-ui-key");
		});
	}
	it("uses the canonical UI key when both shapes exist", async () => {
		expect(
			(
				await unsaved({
					input: {
						type,
						credentials: {
							apiKey: "example-ui-key",
							[envKey]: "example-legacy-key",
						},
					},
					context,
				})
			).success,
		).toBe(true);
		expect(
			new Headers(mocks.fetch.mock.calls[0][1].headers).get(
				"Authorization",
			),
		).toBe("Bearer example-ui-key");
	});

	it("reports rejected credentials", async () => {
		mocks.fetch.mockImplementation(
			async () => new Response("{}", { status: 401 }),
		);
		expect(
			(
				await unsaved({
					input: { type, credentials: { apiKey: "example-key" } },
					context,
				})
			).success,
		).toBe(false);
	});
});
