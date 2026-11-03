import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as Array<Record<string, unknown>>,
	org: vi.fn(),
	personal: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		cloudProviderConfig: { findFirst: mocks.org },
		userCloudProviderConfig: { findFirst: mocks.personal },
	},
}));
vi.mock("@repo/config", () => ({
	config: {
		ai: {
			enableGateway: true,
			gatewayApiKey: "example-platform-key",
			enabledProviders: [],
		},
	},
}));
vi.mock("../prisma/queries/task-default-snapshots", () => ({
	materializeTaskDefaultsSnapshot: vi.fn().mockResolvedValue(null),
}));

import { getOrganizationGatewaySearchConfig } from "../prisma/queries/ai-gateway";

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "example-config",
		organizationId: "example-org",
		provider: "VERCEL_GATEWAY",
		enabled: true,
		purpose: "ALL",
		encryptedApiKey: "encrypted-example-key",
		clientId: null,
		encryptedClientSecret: null,
		config: {},
		taskDefaultsSnapshot: null,
		...overrides,
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.rows.length = 0;
	mocks.org.mockImplementation(
		async ({ where }: { where: Record<string, unknown> }) =>
			mocks.rows.find((candidate) =>
				Object.entries(where).every(([key, value]) =>
					value && typeof value === "object" && "not" in value
						? candidate[key] !== value.not
						: candidate[key] === value,
				),
			) ?? null,
	);
});
afterEach(() => {
	expect(mocks.personal).not.toHaveBeenCalled();
});

describe("organization gateway search configuration", () => {
	it.each(["EMBEDDINGS_ONLY", "ALL"])(
		"resolves the organization's enabled %s key",
		async (purpose) => {
			mocks.rows.push(row({ purpose }));
			expect(
				await getOrganizationGatewaySearchConfig("example-org"),
			).toMatchObject({
				apiKey: "encrypted-example-key",
				configId: "example-config",
				provider: "VERCEL_GATEWAY",
				source: "organization",
			});
		},
	);
	it.each([
		["disabled", { enabled: false }],
		["another organization", { organizationId: "example-other-org" }],
		["another provider", { provider: "OPENAI_DIRECT" }],
		["missing credential", { encryptedApiKey: null }],
	] as const)("does not resolve %s rows", async (_label, overrides) => {
		mocks.rows.push(row(overrides));
		expect(
			await getOrganizationGatewaySearchConfig("example-org"),
		).toBeNull();
	});
	it("rejects an empty organization before querying", async () => {
		mocks.rows.push(row());
		expect(await getOrganizationGatewaySearchConfig("")).toBeNull();
		expect(mocks.org).not.toHaveBeenCalled();
	});
	it("returns null when no organization row exists despite a deployment key", async () => {
		expect(
			await getOrganizationGatewaySearchConfig("example-org"),
		).toBeNull();
		expect(mocks.org).toHaveBeenCalledOnce();
	});
});
