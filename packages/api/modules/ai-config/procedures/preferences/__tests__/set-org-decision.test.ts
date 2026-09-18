import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDeleteByTask,
	mockGetDefaultProvider,
	mockGetProviderByProvider,
	mockGetModel,
	mockSetPreference,
} = vi.hoisted(() => ({
	mockDeleteByTask: vi.fn(),
	mockGetDefaultProvider: vi.fn(),
	mockGetProviderByProvider: vi.fn(),
	mockGetModel: vi.fn(),
	mockSetPreference: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	deleteOrgModelPreferencesByTaskType: (...args: unknown[]) =>
		mockDeleteByTask(...args),
	getAiProviderApiKey: (...args: unknown[]) =>
		mockGetDefaultProvider(...args),
	getAiProviderApiKeyByProvider: (...args: unknown[]) =>
		mockGetProviderByProvider(...args),
	getModelByCanonicalName: (...args: unknown[]) => mockGetModel(...args),
	isGatewayProvider: (provider: string) => provider === "VERCEL_GATEWAY",
	setOrgModelPreference: (...args: unknown[]) => mockSetPreference(...args),
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
		requirePermission: vi.fn(() => ({})),
		Permissions: { ORG_AI_CONFIG_EDIT: "org_ai_config_edit" },
	};
});

vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: vi.fn(async () => ({ id: "member-1" })),
}));

import { setOrgModelPreferenceProcedure } from "../set-org";

const setPreference = setOrgModelPreferenceProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: { user: { id: string }; session: unknown };
	}) => Promise<unknown>;
};

const context = { user: { id: "user-1" }, session: {} };

const decisionModel = {
	id: "model-jev",
	canonicalName: "typesafe-ai-jev",
	capabilities: ["EVALUATION"],
	suitableForTasks: ["DECISION"],
	providerMappings: [
		{
			provider: "VERCEL_GATEWAY",
			providerModelId: "typesafe-ai/jev",
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	mockGetDefaultProvider.mockResolvedValue({ provider: "OPENAI_DIRECT" });
	mockGetModel.mockResolvedValue(decisionModel);
	mockDeleteByTask.mockResolvedValue(undefined);
	mockSetPreference.mockResolvedValue({
		id: "preference-1",
		provider: "VERCEL_GATEWAY",
		taskType: "DECISION",
		model: {
			canonicalName: "typesafe-ai-jev",
			displayName: "TypeSafe AI Jev",
		},
	});
});

describe("set organization decision model preference", () => {
	it("allows Jev through a configured secondary organization Vercel gateway", async () => {
		mockGetProviderByProvider.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
			source: "organization",
			apiKey: "decrypted-placeholder",
		});

		await setPreference._handler({
			input: {
				organizationId: "org-1",
				taskType: "DECISION",
				modelCanonicalName: "typesafe-ai-jev",
				overrideProvider: "VERCEL_GATEWAY",
			},
			context,
		});

		expect(mockGetProviderByProvider).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			provider: "VERCEL_GATEWAY",
		});
		expect(mockSetPreference).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				provider: "VERCEL_GATEWAY",
				taskType: "DECISION",
				modelId: "model-jev",
			}),
		);
	});

	it("refuses a personal or missing Vercel credential before saving", async () => {
		mockGetProviderByProvider.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
			source: "user",
			apiKey: "decrypted-placeholder",
		});

		await expect(
			setPreference._handler({
				input: {
					organizationId: "org-1",
					taskType: "DECISION",
					modelCanonicalName: "typesafe-ai-jev",
					overrideProvider: "VERCEL_GATEWAY",
				},
				context,
			}),
		).rejects.toMatchObject({
			message:
				"Decision models require an organization Vercel AI Gateway configuration",
		});
		expect(mockSetPreference).not.toHaveBeenCalled();
	});

	it("refuses an evaluation-capable model without an available Vercel mapping", async () => {
		mockGetProviderByProvider.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
			source: "organization",
			apiKey: "decrypted-placeholder",
		});
		mockGetModel.mockResolvedValue({
			...decisionModel,
			providerMappings: [],
		});

		await expect(
			setPreference._handler({
				input: {
					organizationId: "org-1",
					taskType: "DECISION",
					modelCanonicalName: "typesafe-ai-jev",
					overrideProvider: "VERCEL_GATEWAY",
				},
				context,
			}),
		).rejects.toMatchObject({
			message:
				"Decision tasks require an evaluation model through Vercel AI Gateway.",
		});
		expect(mockSetPreference).not.toHaveBeenCalled();
	});

	it("keeps ordinary catalog choices available for their existing text tasks", async () => {
		mockGetModel.mockResolvedValue({
			id: "model-gpt-4o",
			canonicalName: "gpt-4o",
			capabilities: ["TEXT"],
			// The settings form has historically offered this model for SIMPLE
			// based on capability, even though the catalog does not tag SIMPLE.
			suitableForTasks: ["CHAT", "COMPLEX"],
			providerMappings: [
				{
					provider: "OPENAI_DIRECT",
					providerModelId: "gpt-4o",
				},
			],
		});
		mockGetDefaultProvider.mockResolvedValue({ provider: "OPENAI_DIRECT" });

		await setPreference._handler({
			input: {
				organizationId: "org-1",
				taskType: "SIMPLE",
				modelCanonicalName: "gpt-4o",
			},
			context,
		});

		expect(mockSetPreference).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "OPENAI_DIRECT",
				taskType: "SIMPLE",
				modelId: "model-gpt-4o",
			}),
		);
	});

	it("rejects Jev for a text task before provider routing", async () => {
		await expect(
			setPreference._handler({
				input: {
					organizationId: "org-1",
					taskType: "SIMPLE",
					modelCanonicalName: "typesafe-ai-jev",
					overrideProvider: "VERCEL_GATEWAY",
				},
				context,
			}),
		).rejects.toMatchObject({
			message:
				"Evaluation models can only be configured for DECISION tasks.",
		});
		expect(mockSetPreference).not.toHaveBeenCalled();
	});
});
