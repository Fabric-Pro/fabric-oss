import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockFindMany,
	mockFindFirst,
	mockGetDefaultProvider,
	mockGetProviderByProvider,
} = vi.hoisted(() => ({
	mockFindMany: vi.fn(),
	mockFindFirst: vi.fn(),
	mockGetDefaultProvider: vi.fn(),
	mockGetProviderByProvider: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		aiTaskModelDefault: { findMany: mockFindMany },
		cloudProviderConfig: { findFirst: mockFindFirst },
		userCloudProviderConfig: { findFirst: vi.fn() },
		aiModel: { findMany: vi.fn() },
	},
	getAiProviderApiKey: (...args: unknown[]) =>
		mockGetDefaultProvider(...args),
	getAiProviderApiKeyByProvider: (...args: unknown[]) =>
		mockGetProviderByProvider(...args),
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

import { getTaskDefaultsProcedure } from "../get-task-defaults";

const getTaskDefaults = getTaskDefaultsProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: { user: { id: string }; session: unknown };
	}) => Promise<Array<{ taskType: string; provider: string | null }>>;
};

const context = { user: { id: "user-1" }, session: {} };

function defaultFor(taskType: string, provider: string) {
	return {
		taskType,
		complexity: "MEDIUM",
		priority: 1,
		provider,
		model: {
			id: `${provider}-${taskType}`,
			canonicalName: `${provider.toLowerCase()}-${taskType.toLowerCase()}`,
			displayName: `${provider} ${taskType}`,
			family: "example",
			vendor: "Example AI",
			speedTier: "BALANCED",
			qualityTier: "STANDARD",
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetDefaultProvider.mockResolvedValue({ provider: "GROQ" });
	mockGetProviderByProvider.mockResolvedValue({
		provider: "VERCEL_GATEWAY",
		source: "organization",
		apiKey: "decrypted-placeholder",
	});
	mockFindFirst.mockResolvedValue({ id: "openai-config" });
	mockFindMany.mockImplementation(
		(args: { where: Record<string, unknown> }) => {
			if (args.where.provider === "GROQ") {
				return Promise.resolve(
					[
						"SIMPLE",
						"COMPLEX",
						"REASONING",
						"CHAT",
						"TOOL_CALLING",
						"EMBEDDING",
						"AUDIO",
						"EVAL",
					].map((taskType) => defaultFor(taskType, "GROQ")),
				);
			}
			if (args.where.provider === "VERCEL_GATEWAY") {
				return Promise.resolve([
					defaultFor("DECISION", "VERCEL_GATEWAY"),
				]);
			}
			return Promise.resolve([defaultFor("IMAGE", "OPENAI_DIRECT")]);
		},
	);
});

describe("task defaults for DECISION", () => {
	it("retains the Vercel decision default while adding an inference-primary fallback", async () => {
		const defaults = await getTaskDefaults._handler({
			input: { organizationId: "org-1" },
			context,
		});

		expect(defaults).toContainEqual(
			expect.objectContaining({
				taskType: "DECISION",
				provider: "VERCEL_GATEWAY",
			}),
		);
		expect(defaults).toContainEqual(
			expect.objectContaining({
				taskType: "IMAGE",
				provider: "OPENAI_DIRECT",
			}),
		);
	});
});
