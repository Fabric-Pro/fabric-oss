/**
 * An embeddings model whose vectors the document index cannot hold is never
 * saved (Fizzy #2770): every collection is 1536 wide, so a 3072-dimension
 * model would fail every write and search.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getModel: vi.fn(),
	setOrg: vi.fn(),
	setUser: vi.fn(),
	orgPreference: vi.fn(),
	userPreference: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		organizationModelPreference: { findFirst: mocks.orgPreference },
		userModelPreference: { findFirst: mocks.userPreference },
	},
	deleteOrgModelPreferencesByTaskType: vi.fn(),
	deleteUserModelPreferencesByTaskType: vi.fn(),
	getAiProviderApiKey: vi.fn(async () => ({ provider: null })),
	getAiProviderApiKeyByProvider: vi.fn(),
	getModelByCanonicalName: mocks.getModel,
	isGatewayProvider: (provider: string) => provider === "VERCEL_GATEWAY",
	setOrgModelPreference: mocks.setOrg,
	setUserModelPreference: mocks.setUser,
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
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId ?? null,
		requirePermission: vi.fn(() => ({})),
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: { ORG_AI_CONFIG_EDIT: "org_ai_config_edit" },
	};
});

vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: vi.fn(async () => ({ id: "member-1" })),
}));

import { assertEmbeddingPreferenceFitsVectorStore } from "../../../lib/embedding-model-guard";
import { setOrgModelPreferenceProcedure } from "../set-org";
import { setUserModelPreferenceProcedure } from "../set-user";

type Handler = {
	_handler: (args: { input: unknown; context: unknown }) => Promise<unknown>;
};
const context = { user: { id: "user-1" }, session: {} };

function embeddingModel(canonicalName: string, displayName: string) {
	return {
		id: `model-${canonicalName}`,
		canonicalName,
		displayName,
		capabilities: ["EMBEDDING"],
		suitableForTasks: ["EMBEDDING"],
		providerMappings: [
			{ provider: "VERCEL_GATEWAY", providerModelId: canonicalName },
		],
	};
}

const LARGE = embeddingModel(
	"text-embedding-3-large",
	"Text Embedding 3 Large",
);
const SMALL = embeddingModel(
	"text-embedding-3-small",
	"Text Embedding 3 Small",
);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.setOrg.mockResolvedValue({
		id: "pref-1",
		provider: "VERCEL_GATEWAY",
		taskType: "EMBEDDING",
		model: SMALL,
	});
	mocks.setUser.mockResolvedValue({
		id: "pref-2",
		provider: "VERCEL_GATEWAY",
		taskType: "EMBEDDING",
		model: SMALL,
	});
});

const embeddingInput = (modelCanonicalName: string) => ({
	organizationId: "org-1",
	taskType: "EMBEDDING",
	modelCanonicalName,
	overrideProvider: "VERCEL_GATEWAY",
});

describe.each([
	["organization", setOrgModelPreferenceProcedure, mocks.setOrg],
	["member", setUserModelPreferenceProcedure, mocks.setUser],
])("saving the %s embeddings model", (_scope, procedure, save) => {
	it("refuses a model with 3072-dimension vectors and saves nothing", async () => {
		mocks.getModel.mockResolvedValue(LARGE);
		await expect(
			(procedure as unknown as Handler)._handler({
				input: embeddingInput("text-embedding-3-large"),
				context,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"Text Embedding 3 Large produces vectors the document index cannot store. Choose a model with 1536-dimension vectors.",
		});
		expect(save).not.toHaveBeenCalled();
	});

	it("saves a model with 1536-dimension vectors", async () => {
		mocks.getModel.mockResolvedValue(SMALL);
		await (procedure as unknown as Handler)._handler({
			input: embeddingInput("text-embedding-3-small"),
			context,
		});
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				taskType: "EMBEDDING",
				modelId: "model-text-embedding-3-small",
			}),
		);
	});
});

describe("making a provider the documents provider", () => {
	it("refuses when the organization's embeddings model for it does not fit", async () => {
		mocks.orgPreference.mockResolvedValue({ model: LARGE });
		await expect(
			assertEmbeddingPreferenceFitsVectorStore({
				organizationId: "org-1",
				userId: "user-1",
				provider: "OPENAI_DIRECT",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.orgPreference).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					taskType: "EMBEDDING",
					provider: "OPENAI_DIRECT",
					organizationId: "org-1",
				},
			}),
		);
	});

	it("allows a fitting model, or none chosen, and checks a member's own in personal scope", async () => {
		mocks.orgPreference.mockResolvedValue({ model: SMALL });
		await expect(
			assertEmbeddingPreferenceFitsVectorStore({
				organizationId: "org-1",
				userId: "user-1",
				provider: "OPENAI_DIRECT",
			}),
		).resolves.toBeUndefined();
		mocks.userPreference.mockResolvedValue(null);
		await expect(
			assertEmbeddingPreferenceFitsVectorStore({
				organizationId: null,
				userId: "user-1",
				provider: "OPENAI_DIRECT",
			}),
		).resolves.toBeUndefined();
		expect(mocks.userPreference).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					taskType: "EMBEDDING",
					provider: "OPENAI_DIRECT",
					userId: "user-1",
				},
			}),
		);
	});
});
