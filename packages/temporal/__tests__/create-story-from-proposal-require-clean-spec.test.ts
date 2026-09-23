/**
 * `createStoryFromProposal({ requireCleanSpec })` — the roadmap-recommendation
 * accept path (Fizzy #2208, FR27). A recommended feature must be drafted
 * through the bound Clean Spec prompt: no legacy prompt fallback, no
 * raw-field stub when drafting fails, and no `skipDrafting` shortcut. Every
 * created row carries its batch id.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		classifyWorkItem: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		getPromptById: vi.fn(),
		createStory: vi.fn(),
		createFeatureVersion: vi.fn(),
		retrieveProjectContexts: vi.fn(),
		formatContextsForPrompt: vi.fn(),
		fetchLiveIntegrationContext: vi.fn(),
		formatLiveContextForPrompt: vi.fn(),
		renderTemplate: vi.fn(),
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		logModelUsageAsync: vi.fn(),
		projectFindUnique: vi.fn(),
		promptVersionFindFirst: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {
		constructor() {
			super("AI provider not configured");
			this.name = "AIProviderNotConfiguredError";
		}
	},
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@repo/database", () => ({
	createFeatureVersion: mocks.createFeatureVersion,
	createStory: mocks.createStory,
	db: {
		project: { findUnique: mocks.projectFindUnique },
		promptVersion: { findFirst: mocks.promptVersionFindFirst },
	},
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	getPromptById: mocks.getPromptById,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/rag", () => ({
	formatContextsForPrompt: mocks.formatContextsForPrompt,
	retrieveProjectContexts: mocks.retrieveProjectContexts,
}));

vi.mock("@repo/rag/lib/project-contexts/live-integration-context", () => ({
	fetchLiveIntegrationContext: mocks.fetchLiveIntegrationContext,
	formatLiveContextForPrompt: mocks.formatLiveContextForPrompt,
}));

// Real `@repo/utils` normalizers; only `renderTemplate` is mocked.
vi.mock("@repo/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/utils")>();
	return {
		...actual,
		renderTemplate: mocks.renderTemplate,
	};
});

vi.mock("../src/lib/classify-work-item", () => ({
	classifyWorkItem: mocks.classifyWorkItem,
}));

import { createStoryFromProposal } from "../src/lib/create-story-from-proposal";

const BASE_PARAMS = {
	projectId: "proj-1",
	organizationId: "org-1",
	createdById: "user-1",
	source: "AI_RECOMMENDED" as const,
	title: "Saved searches",
	description: "Let people save a search.",
	kind: "FEATURE" as const,
	skipClassifier: true,
	createdFromProposalId: "proposal-1",
	aiRecommendationBatchId: "proposal-1",
	requireCleanSpec: true,
};

function setupDraftingContext(): void {
	mocks.renderTemplate.mockResolvedValue({
		rendered: "rendered prompt",
		error: null,
	});
	mocks.projectFindUnique.mockResolvedValue({
		name: "Test Project",
		description: null,
	});
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.formatContextsForPrompt.mockReturnValue("");
	mocks.fetchLiveIntegrationContext.mockResolvedValue({});
	mocks.formatLiveContextForPrompt.mockReturnValue(null);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { modelId: "test-model" },
		metadata: { provider: "test" },
		trackUsage: vi.fn(),
	});
	mocks.createFeatureVersion.mockResolvedValue({ id: "ver-1" });
}

const BOUND_CLEAN_SPEC = {
	key: "clean_spec_feature",
	format: "MARKDOWN",
	version: { content: "clean spec prompt" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createStory.mockResolvedValue({
		id: "story-1",
		identifier: "F-001",
		title: "Saved searches",
		kind: "FEATURE",
	});
	setupDraftingContext();
});

describe("createStoryFromProposal — requireCleanSpec", () => {
	it("throws and creates nothing when no Clean Spec prompt is bound, without trying the legacy fallback", async () => {
		mocks.getBoundPromptForAgent.mockImplementation(
			async (args: { documentType: string }) =>
				args.documentType === "CLEAN_SPEC" ? null : BOUND_CLEAN_SPEC,
		);

		await expect(createStoryFromProposal(BASE_PARAMS)).rejects.toThrow(
			/Feature specification prompt is not configured/,
		);
		expect(mocks.createStory).not.toHaveBeenCalled();
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledOnce();
	});

	it("throws instead of creating a raw-field stub when drafting fails", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue(BOUND_CLEAN_SPEC);
		mocks.generateObject.mockRejectedValue(new Error("model down"));

		await expect(createStoryFromProposal(BASE_PARAMS)).rejects.toThrow(
			/could not be drafted/,
		);
		expect(mocks.createStory).not.toHaveBeenCalled();
	});

	it("ignores skipDrafting / bodyAlreadyDrafted and drafts through Clean Spec", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue(BOUND_CLEAN_SPEC);
		mocks.generateObject.mockResolvedValue({
			object: {
				description: "Full drafted spec.",
				acceptanceCriteria: "- Given a search, it can be saved",
			},
			usage: { totalTokens: 10 },
		});

		const result = await createStoryFromProposal({
			...BASE_PARAMS,
			skipDrafting: true,
			bodyAlreadyDrafted: true,
		});

		expect(result.aiDrafted).toBe(true);
		expect(mocks.generateObject).toHaveBeenCalled();
		const call = mocks.createStory.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call).toMatchObject({
			source: "AI_RECOMMENDED",
			aiRecommendationBatchId: "proposal-1",
			createdFromProposalId: "proposal-1",
			description: "Full drafted spec.",
		});
	});

	it("without requireCleanSpec, an unbound prompt still creates from raw fields and carries no batch id", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue(null);

		await createStoryFromProposal({
			...BASE_PARAMS,
			source: "AI_UPDATE",
			requireCleanSpec: undefined,
			aiRecommendationBatchId: undefined,
		});

		const call = mocks.createStory.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call.source).toBe("AI_UPDATE");
		expect(call).not.toHaveProperty("aiRecommendationBatchId");
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledTimes(2);
	});
});
