import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDefault = vi.hoisted(() => vi.fn());
const mockDb = vi.hoisted(() => ({
	cloudProviderConfig: { findMany: vi.fn() },
	userCloudProviderConfig: { findMany: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	db: mockDb,
	getOrganizationDefaultProvider: mockDefault,
	ALL_AUDIO_CAPABLE_PROVIDERS: [],
	ALL_EMBEDDING_CAPABLE_PROVIDERS: ["OPENAI_DIRECT", "VERCEL_GATEWAY"],
	ALL_IMAGE_CAPABLE_PROVIDERS: [],
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY"],
}));

import { getConfiguredProviders } from "../configured-providers";

beforeEach(() => {
	vi.clearAllMocks();
	mockDefault.mockResolvedValue("OPENAI_DIRECT");
});

describe("getConfiguredProviders for DECISION", () => {
	it("uses a configured Vercel AI Gateway even when another provider is primary", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			{
				id: "primary-config",
				provider: "OPENAI_DIRECT",
				displayName: null,
				isDefault: true,
				priority: 10,
				config: {},
			},
			{
				id: "decision-config",
				provider: "VERCEL_GATEWAY",
				displayName: null,
				isDefault: false,
				priority: 5,
				config: { enabledProviders: ["OPENAI_DIRECT"] },
			},
		]);

		const result = await getConfiguredProviders(
			"user-1",
			"org-1",
			"DECISION",
		);

		expect(result.defaultProviderType).toBe("OPENAI_DIRECT");
		expect(result.effectiveProviders).toEqual(["VERCEL_GATEWAY"]);
		expect(mockDb.cloudProviderConfig.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1", enabled: true },
			}),
		);
	});

	it("does not use a personal provider in an organization context", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			{
				id: "primary-config",
				provider: "OPENAI_DIRECT",
				displayName: null,
				isDefault: true,
				priority: 10,
				config: {},
			},
		]);

		const result = await getConfiguredProviders(
			"user-1",
			"org-1",
			"DECISION",
		);

		expect(result.effectiveProviders).toEqual(["OPENAI_DIRECT"]);
		expect(mockDb.userCloudProviderConfig.findMany).not.toHaveBeenCalled();
	});
});

describe("getConfiguredProviders with an embeddings-only key", () => {
	it("never falls back to an embeddings-only key as the default", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			{
				id: "embed-config",
				provider: "OPENAI_DIRECT",
				displayName: null,
				isDefault: false,
				priority: 10,
				purpose: "EMBEDDINGS_ONLY",
				config: {},
			},
		]);

		const result = await getConfiguredProviders("user-1", "org-1");

		expect(result.defaultProvider).toBeNull();
		expect(result.allProviders[0]).toMatchObject({
			isDefault: false,
			purpose: "EMBEDDINGS_ONLY",
		});
	});
});

it.each([false, true])(
	"does not invent an organization default from a row with isDefault=%s when no usable default resolves",
	async (isDefault) => {
		mockDefault.mockResolvedValue(null);
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			{
				id: "example-config",
				provider: "ANTHROPIC_DIRECT",
				displayName: null,
				isDefault,
				priority: 1,
				purpose: "ALL",
				encryptedApiKey: null,
				clientId: null,
				encryptedClientSecret: null,
				config: {},
			},
		]);
		const result = await getConfiguredProviders(
			"example-user",
			"example-org",
			"CHAT",
		);
		expect(result.defaultProvider).toBeNull();
		expect(result.defaultProviderType).toBeNull();
		expect(result.effectiveProviders).toEqual([]);
		expect(result.allProviders[0].isDefault).toBe(false);
		expect(mockDefault).toHaveBeenCalledWith("example-org");
	},
);

it("lists both configured decision providers with tenant-scoped discovery", async () => {
	mockDb.cloudProviderConfig.findMany.mockResolvedValue(
		["VERCEL_GATEWAY", "DATABRICKS"].map((provider) => ({
			id: `example-${provider}`,
			provider,
			isDefault: false,
			config: {},
			purpose: "ALL",
		})),
	);
	const result = await getConfiguredProviders(
		"example-user",
		"example-org",
		"DECISION",
	);
	expect(result.effectiveProviders).toEqual(["VERCEL_GATEWAY", "DATABRICKS"]);
	expect(mockDb.userCloudProviderConfig.findMany).not.toHaveBeenCalled();
});
it("lists Databricks decisions without a gateway configuration", async () => {
	mockDefault.mockResolvedValue(null);
	mockDb.cloudProviderConfig.findMany.mockResolvedValue([
		{
			id: "example-config",
			provider: "DATABRICKS",
			isDefault: false,
			config: {},
			purpose: "ALL",
		},
	]);
	const result = await getConfiguredProviders(
		"example-user",
		"example-org",
		"DECISION",
	);
	expect(result.effectiveProviders).toEqual(["DATABRICKS"]);
});

it.each(["CHAT", "EMBEDDING", undefined] as const)(
	"limits explicit text tasks to the default provider (%s)",
	async (taskType) => {
		mockDefault.mockResolvedValue("ANTHROPIC_DIRECT");
		mockDb.cloudProviderConfig.findMany.mockResolvedValue(
			["ANTHROPIC_DIRECT", "VERCEL_GATEWAY"].map((provider) => ({
				id: `example-${provider}`,
				provider,
				isDefault: provider === "ANTHROPIC_DIRECT",
				purpose: "ALL",
				config: {},
			})),
		);
		const result = await getConfiguredProviders(
			"example-user",
			"example-org",
			taskType,
		);
		expect(result.effectiveProviders).toEqual(
			taskType === "CHAT"
				? ["ANTHROPIC_DIRECT"]
				: taskType === "EMBEDDING"
					? ["VERCEL_GATEWAY"]
					: ["ANTHROPIC_DIRECT", "VERCEL_GATEWAY"],
		);
	},
);
