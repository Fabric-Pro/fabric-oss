/**
 * Focused tests for the `skipDrafting` parameter on createStoryFromProposal.
 *
 * Contract being verified:
 *   - skipDrafting: true + effectiveKind === "FEATURE" → raw fields persisted,
 *     no prompt resolution, no drafting LLM call, no FeatureVersion created.
 *   - skipDrafting: true + effectiveKind === "BUG" → still drafts (bug_creation
 *     prompt is what populates needsMoreInfo; AC3 must not regress).
 *   - skipDrafting: false (default) → existing behavior unchanged.
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

// `stripWorkItemTitlePrefix` / `stripLeadingDuplicateTitleHeading` are pure
// helpers consumed by the function under test — use the real implementations
// so the mock faithfully exercises the write-time normalization, while
// `renderTemplate` stays mocked to avoid the template engine.
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
	title: "Add SSO login option",
	description: "Original analyzer-produced description.",
	source: "AI_UPDATE" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createStory.mockResolvedValue({
		id: "story-1",
		identifier: "F-001",
		title: BASE_PARAMS.title,
		kind: "FEATURE",
	});
});

describe("createStoryFromProposal — skipDrafting", () => {
	it("skipDrafting + classifier=FEATURE → bypasses prompt resolution and drafting", async () => {
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "FEATURE",
			confidence: "High",
			fallback_used: false,
			primary_signals: [],
			rationale: "feature signal",
		});

		const result = await createStoryFromProposal({
			...BASE_PARAMS,
			skipDrafting: true,
		});

		// Drafting infrastructure must NOT be touched.
		expect(mocks.getBoundPromptForAgent).not.toHaveBeenCalled();
		expect(mocks.getPromptById).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
		expect(mocks.retrieveProjectContexts).not.toHaveBeenCalled();
		expect(mocks.fetchLiveIntegrationContext).not.toHaveBeenCalled();
		expect(mocks.createFeatureVersion).not.toHaveBeenCalled();

		// Story persisted with the analyzer-produced description verbatim.
		expect(mocks.createStory).toHaveBeenCalledOnce();
		const createCall = mocks.createStory.mock.calls[0]?.[0];
		expect(createCall).toMatchObject({
			projectId: "proj-1",
			title: BASE_PARAMS.title,
			description: BASE_PARAMS.description,
			kind: "FEATURE",
			source: "AI_UPDATE",
		});
		expect(result.aiDrafted).toBe(false);
		expect(result.featureVersionId).toBeUndefined();
	});

	it("skipDrafting + classifier=BUG → still drafts (needsMoreInfo contract)", async () => {
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "BUG",
			confidence: "High",
			fallback_used: false,
			primary_signals: ["regression", "500"],
			rationale: "bug signal",
		});
		// Set up the drafting path enough that it doesn't short-circuit.
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_creation",
			format: "MARKDOWN",
			version: { content: "bug prompt" },
		});
		mocks.renderTemplate.mockResolvedValue({
			rendered: "rendered bug prompt",
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
		mocks.generateObject.mockResolvedValue({
			object: {
				title: undefined,
				needsMoreInfo: false,
				markdown: "Bug card markdown.",
			},
			usage: { totalTokens: 100 },
		});
		mocks.createFeatureVersion.mockResolvedValue({ id: "ver-1" });
		mocks.createStory.mockResolvedValue({
			id: "story-1",
			identifier: "F-001",
			title: BASE_PARAMS.title,
			kind: "BUG",
		});

		const result = await createStoryFromProposal({
			...BASE_PARAMS,
			skipDrafting: true, // ← ignored for BUG
		});

		// Drafting MUST run for bugs even when skipDrafting=true, otherwise
		// needsMoreInfo defaults to false silently.
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalled();
		expect(mocks.generateObject).toHaveBeenCalled();
		expect(mocks.createFeatureVersion).toHaveBeenCalled();
		expect(result.aiDrafted).toBe(true);
	});

	it("skipDrafting + bodyAlreadyDrafted + BUG → persists body verbatim, no re-draft, keeps needsMoreInfo", async () => {
		// The review-time lazy draft already ran bug_creation, so apply must NOT
		// re-draft — but the F-171 triage flag still has to land on the row.
		mocks.createStory.mockResolvedValue({
			id: "story-9",
			identifier: "F-009",
			title: BASE_PARAMS.title,
			kind: "BUG",
		});
		const preDraftedBugBody =
			"## Steps to Reproduce\n1. x\n## Actual Result\ny";

		const result = await createStoryFromProposal({
			...BASE_PARAMS,
			kind: "BUG",
			skipClassifier: true, // kind fixed at review time
			skipDrafting: true,
			bodyAlreadyDrafted: true,
			needsMoreInfo: true,
			description: preDraftedBugBody,
		});

		// No classifier, no prompt, no drafting LLM call, no version.
		expect(mocks.classifyWorkItem).not.toHaveBeenCalled();
		expect(mocks.getBoundPromptForAgent).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
		expect(mocks.createFeatureVersion).not.toHaveBeenCalled();

		// Body persisted verbatim + triage flag carried (not silently dropped).
		expect(mocks.createStory).toHaveBeenCalledOnce();
		const createCall = mocks.createStory.mock.calls[0]?.[0];
		expect(createCall).toMatchObject({
			kind: "BUG",
			description: preDraftedBugBody,
			needsMoreInfo: true,
		});
		expect(result.aiDrafted).toBe(false);
	});

	it("skipDrafting WITHOUT bodyAlreadyDrafted + BUG → still drafts (F-171 unchanged)", async () => {
		// Guards the exception: only `bodyAlreadyDrafted` lets a bug skip drafting.
		// A plain skipDrafting bug must still run bug_creation (existing contract).
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "BUG",
			confidence: "High",
			fallback_used: false,
			primary_signals: ["regression"],
			rationale: "bug signal",
		});
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_creation",
			format: "MARKDOWN",
			version: { content: "bug prompt" },
		});
		mocks.renderTemplate.mockResolvedValue({
			rendered: "rendered bug prompt",
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
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: "Bug card." },
			usage: { totalTokens: 100 },
		});
		mocks.createFeatureVersion.mockResolvedValue({ id: "ver-1" });
		mocks.createStory.mockResolvedValue({
			id: "story-9",
			identifier: "F-009",
			title: BASE_PARAMS.title,
			kind: "BUG",
		});

		const result = await createStoryFromProposal({
			...BASE_PARAMS,
			skipDrafting: true, // ← but no bodyAlreadyDrafted
		});

		expect(mocks.generateObject).toHaveBeenCalled();
		expect(result.aiDrafted).toBe(true);
	});

	it("skipDrafting omitted (default) + classifier=FEATURE → drafting path runs (no regression)", async () => {
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "FEATURE",
			confidence: "High",
			fallback_used: false,
			primary_signals: [],
			rationale: "feature signal",
		});
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "project_document_generator",
			format: "MARKDOWN",
			version: { content: "feature prompt" },
		});
		mocks.renderTemplate.mockResolvedValue({
			rendered: "rendered feature prompt",
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
		mocks.generateObject.mockResolvedValue({
			object: { description: "Re-drafted feature description." },
			usage: { totalTokens: 80 },
		});
		mocks.createFeatureVersion.mockResolvedValue({ id: "ver-1" });

		const result = await createStoryFromProposal({
			...BASE_PARAMS,
			// no skipDrafting field
		});

		// Default behavior preserved: drafting runs for features when a
		// prompt is bound (matches Slack/Teams approval, manual UI, tool).
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalled();
		expect(mocks.generateObject).toHaveBeenCalled();
		expect(result.aiDrafted).toBe(true);
	});
});
