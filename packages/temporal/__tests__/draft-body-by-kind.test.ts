/**
 * Tests for draftBodyByKind — the non-persisting "format a body into a kind's
 * structure" helper that powers the proposal-review type-switch.
 *
 * Verifies (#1799): feature/bug route to the kind-scoped Clean Spec binding
 * (feature_clean_spec_generator / bug_clean_spec_generator, documentType
 * CLEAN_SPEC); when the Clean Spec prompt is unbound, resolution falls back to
 * the legacy project_document_generator/stage binding; no bound prompt at all
 * returns the input unchanged (aiDrafted=false).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
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
		classifyWorkItem: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
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
	return { ...actual, renderTemplate: mocks.renderTemplate };
});
vi.mock("../src/lib/classify-work-item", () => ({
	classifyWorkItem: mocks.classifyWorkItem,
}));

import { draftBodyByKind } from "../src/lib/create-story-from-proposal";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: vi.fn(),
	});
	mocks.renderTemplate.mockResolvedValue({ rendered: "PROMPT", error: null });
	mocks.projectFindUnique.mockResolvedValue({
		name: "Proj",
		description: "",
	});
	mocks.retrieveProjectContexts.mockResolvedValue([]);
});

const BASE = {
	projectId: "p1",
	organizationId: null as string | null,
	userId: "u1",
	title: "Bulk export",
};

describe("draftBodyByKind", () => {
	it("returns the input unchanged when no prompt is bound", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue(null);
		const res = await draftBodyByKind({
			...BASE,
			kind: "FEATURE",
			description: "raw desc",
		});
		expect(res.aiDrafted).toBe(false);
		expect(res.description).toBe("raw desc");
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("routes FEATURE to the Clean Spec feature binding and returns description+AC", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			version: { content: "T" },
			format: "HANDLEBARS",
			key: "feature_clean_spec_generator",
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				description: "structured feature",
				acceptanceCriteria: "GWT",
			},
			usage: {},
		});
		const res = await draftBodyByKind({
			...BASE,
			kind: "FEATURE",
			description: "raw",
		});
		expect(res.aiDrafted).toBe(true);
		expect(res.description).toBe("structured feature");
		expect(res.acceptanceCriteria).toBe("GWT");
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "feature_clean_spec_generator",
				documentType: "CLEAN_SPEC",
				storyKind: "FEATURE",
			}),
		);
	});

	it("routes BUG to the Clean Spec bug binding and returns the markdown card", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			version: { content: "T" },
			format: "HANDLEBARS",
			key: "bug_clean_spec_generator",
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				title: "",
				needsMoreInfo: true,
				markdown: "## Steps to Reproduce\n1. x",
			},
			usage: {},
		});
		const res = await draftBodyByKind({
			...BASE,
			kind: "BUG",
			description: "it crashes",
		});
		expect(res.aiDrafted).toBe(true);
		expect(res.description).toContain("Steps to Reproduce");
		expect(res.needsMoreInfo).toBe(true);
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "bug_clean_spec_generator",
				documentType: "CLEAN_SPEC",
				storyKind: "BUG",
			}),
		);
	});

	it("falls back to the legacy stage binding when the Clean Spec prompt is unbound", async () => {
		// #1799: Clean Spec unbound (null) → resolution must fall through to the
		// legacy project_document_generator / stage binding so drafting never stops.
		mocks.getBoundPromptForAgent
			.mockResolvedValueOnce(null) // clean-spec lookup: unbound
			.mockResolvedValueOnce({
				version: { content: "T" },
				format: "HANDLEBARS",
				key: "feature_placeholder",
			}); // legacy fallback
		mocks.generateObject.mockResolvedValue({
			object: { description: "legacy-drafted feature" },
			usage: {},
		});
		const res = await draftBodyByKind({
			...BASE,
			kind: "FEATURE",
			description: "raw",
		});
		expect(res.aiDrafted).toBe(true);
		expect(res.description).toBe("legacy-drafted feature");
		// First call = clean-spec (unbound); second = legacy stage binding.
		expect(mocks.getBoundPromptForAgent).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				agentName: "feature_clean_spec_generator",
				documentType: "CLEAN_SPEC",
			}),
		);
		expect(mocks.getBoundPromptForAgent).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				agentName: "project_document_generator",
				documentType: "PLACEHOLDER",
			}),
		);
	});
});
