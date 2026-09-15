/**
 * createStoryFromProposal must forward `proposalApplicationKey` (plan §F3)
 * and `deliveryTrack` / `trackSetBy` (plan Slice 3) on EVERY `createStory`
 * branch: no prompt bound, drafting failed, drafting succeeded. A branch
 * that drops them silently breaks apply idempotency or leaves Explore
 * spikes UNCLASSIFIED.
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

const baseParams = {
	projectId: "p1",
	organizationId: null,
	createdById: "u1",
	title: "Teams idea",
	description: "Analyzer body.",
	draftingStage: "PLACEHOLDER" as const,
	source: "APPROVED_PROPOSAL" as const,
	kind: "FEATURE" as const,
	skipClassifier: true,
	proposalApplicationKey: "proposal:prop-2:4",
	deliveryTrack: "SPIKE" as const,
	trackSetBy: "AI" as const,
};

const FORWARDED = {
	proposalApplicationKey: "proposal:prop-2:4",
	deliveryTrack: "SPIKE",
	trackSetBy: "AI",
};

function bindPromptAndModel() {
	mocks.getBoundPromptForAgent.mockResolvedValue({
		promptId: "prompt-1",
		version: { id: "ver-1", content: "Draft {{title}}" },
		format: "handlebars",
	});
	mocks.renderTemplate.mockResolvedValue({ rendered: "Draft Teams idea" });
	mocks.projectFindUnique.mockResolvedValue({
		name: "Proj",
		description: null,
	});
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.fetchLiveIntegrationContext.mockResolvedValue({});
	mocks.formatLiveContextForPrompt.mockReturnValue("");
	mocks.formatContextsForPrompt.mockReturnValue("");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createStory.mockResolvedValue({
		id: "s1",
		identifier: "F-001",
		title: "Teams idea",
		description: null,
		acceptanceCriteria: null,
		kind: "FEATURE",
	});
	mocks.createFeatureVersion.mockResolvedValue({ id: "ver-row" });
});

describe("createStoryFromProposal — key and track on every create path", () => {
	it("no prompt bound → non-AI create still carries them", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue(null);
		const result = await createStoryFromProposal(baseParams as never);
		expect(result.aiDrafted).toBe(false);
		expect(mocks.createStory).toHaveBeenCalledTimes(1);
		expect(mocks.createStory.mock.calls[0][0]).toMatchObject({
			...FORWARDED,
			source: "APPROVED_PROPOSAL",
		});
	});

	it("AI drafting fails → fallback create still carries them", async () => {
		bindPromptAndModel();
		mocks.getAIModelWithMetadata.mockRejectedValue(
			new Error("provider down"),
		);
		const result = await createStoryFromProposal(baseParams as never);
		expect(result.aiDrafted).toBe(false);
		expect(mocks.createStory).toHaveBeenCalledTimes(1);
		expect(mocks.createStory.mock.calls[0][0]).toMatchObject(FORWARDED);
	});

	it("AI drafting succeeds → drafted create carries them", async () => {
		bindPromptAndModel();
		mocks.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: { provider: "x", modelId: "y", modelString: "x/y" },
			trackUsage: vi.fn(),
		});
		mocks.generateObject.mockResolvedValue({
			object: { description: "d", acceptanceCriteria: "ac" },
			usage: {},
		});
		const result = await createStoryFromProposal(baseParams as never);
		expect(result.aiDrafted).toBe(true);
		expect(mocks.createStory).toHaveBeenCalledTimes(1);
		expect(mocks.createStory.mock.calls[0][0]).toMatchObject({
			...FORWARDED,
			description: "d",
		});
	});

	it("leaves the track undefined when the proposal carried none", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue(null);
		const { deliveryTrack: _t, trackSetBy: _s, ...noTrack } = baseParams;
		await createStoryFromProposal(noTrack as never);
		expect(mocks.createStory.mock.calls[0][0]).toMatchObject({
			proposalApplicationKey: "proposal:prop-2:4",
			deliveryTrack: undefined,
			trackSetBy: undefined,
		});
	});
});
