/**
 * Integration tests for the write-time title/body normalization applied by
 * `createStoryFromProposal` (spec 2026-05-29-ai-update-title-formatting-cleanup).
 *
 * Contract being verified (AC1–AC8, REQ-21/AC12):
 *   - The persisted `title` passed to `createStory` has no leading work-item
 *     prefix (`[BUG]`, `Bug:`, `[FEATURE]`, …) across epic/feature/story/bug.
 *   - Repeated prefixes (`Bug: [BUG] …`) are fully stripped (AC4); casing is
 *     preserved (AC5).
 *   - A leading body H1 that duplicates the resolved title is removed (AC8,
 *     B-020 shape); an unrelated first heading (AC6) and a body with no leading
 *     H1 (AC7) are left intact.
 *   - The BUG empty/prefix-only-title fallback still resolves to "Untitled bug"
 *     (REQ-21 / AC12 — no regression).
 *
 * The LLM (`generateObject`) and the persistence layer (`createStory`) are
 * mocked; the pure normalizers from `@repo/utils` run for real so the assertion
 * exercises the actual write-time behavior.
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
	source: "AI_UPDATE" as const,
};

/** Wire up the common drafting-path mocks so drafting actually runs. */
function setupDraftingPath(): void {
	mocks.getBoundPromptForAgent.mockResolvedValue({
		key: "project_document_generator",
		format: "MARKDOWN",
		version: { content: "prompt content" },
	});
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

/** The single `createStory` call's first argument. */
function lastCreateStoryCall(): Record<string, unknown> {
	expect(mocks.createStory).toHaveBeenCalledOnce();
	return mocks.createStory.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createStory.mockResolvedValue({
		id: "story-1",
		identifier: "F-001",
		title: "stub",
		kind: "FEATURE",
	});
});

describe("createStoryFromProposal — write-time title/body normalization", () => {
	describe("AC3: all kinds persist a prefix-free title", () => {
		// AC3 epic coverage: `createStoryFromProposal`'s StoryKind is now
		// FEATURE | BUG (User Story was retired) — the epic/feature distinction
		// lives upstream in applyBacklogChanges. Here the [EPIC]-prefixed title
		// flows through the non-BUG path (title from params.title), so we assert
		// the [EPIC] prefix strip on a FEATURE-classified row.
		it("EPIC-prefixed title: strips the [EPIC] prefix and removes the duplicating H1", async () => {
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "FEATURE",
				confidence: "High",
				fallback_used: false,
				primary_signals: [],
				rationale: "epic signal",
			});
			setupDraftingPath();
			mocks.generateObject.mockResolvedValue({
				object: {
					description: "# Payments Platform\n\nEpic body text.",
				},
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "[EPIC] Payments Platform",
				description: "raw",
				kind: "FEATURE",
			});

			const call = lastCreateStoryCall();
			expect(call.title).toBe("Payments Platform");
			expect(call.description).toBe("Epic body text.");
		});

		it("FEATURE: strips the [FEATURE] prefix and removes the duplicating H1", async () => {
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "FEATURE",
				confidence: "High",
				fallback_used: false,
				primary_signals: [],
				rationale: "feature signal",
			});
			setupDraftingPath();
			mocks.generateObject.mockResolvedValue({
				object: {
					description: "# SSO Login\n\nFeature body text.",
				},
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "[FEATURE] SSO Login",
				description: "raw",
				kind: "FEATURE",
			});

			const call = lastCreateStoryCall();
			expect(call.title).toBe("SSO Login");
			expect(call.description).toBe("Feature body text.");
		});

		// AC3 legacy-"story" coverage: a "story"-shaped capability now persists
		// as a FEATURE (User Story was retired). The `Story:` colon-prefixed
		// title flows through the non-BUG path, so we assert the colon-prefix
		// strip on a FEATURE row.
		it("STORY-prefixed (now FEATURE): strips the Story: prefix and removes the duplicating H1", async () => {
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "FEATURE",
				confidence: "High",
				fallback_used: false,
				primary_signals: [],
				rationale: "story signal",
			});
			setupDraftingPath();
			mocks.generateObject.mockResolvedValue({
				object: {
					description: "# Export to CSV\n\nStory body text.",
				},
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "Story: Export to CSV",
				description: "raw",
				kind: "FEATURE",
			});

			const call = lastCreateStoryCall();
			expect(call.title).toBe("Export to CSV");
			expect(call.description).toBe("Story body text.");
		});

		it("BUG: strips the prefix from the drafted title and removes the duplicating H1", async () => {
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "BUG",
				confidence: "High",
				fallback_used: false,
				primary_signals: ["500"],
				rationale: "bug signal",
			});
			setupDraftingPath();
			mocks.generateObject.mockResolvedValue({
				object: {
					title: "[BUG] No output generated",
					needsMoreInfo: false,
					markdown:
						"# Bug: No output generated\n\nBug Metadata\n- Severity: High",
				},
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "ignored caller title",
				description: "raw",
				kind: "BUG",
			});

			const call = lastCreateStoryCall();
			expect(call.title).toBe("No output generated");
			expect(call.description).toBe("Bug Metadata\n- Severity: High");
		});
	});

	describe("AC4 / AC5: repeated prefixes and casing", () => {
		it("AC4: 'Bug: [BUG] No output generated' persists as 'No output generated'", async () => {
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "BUG",
				confidence: "High",
				fallback_used: false,
				primary_signals: [],
				rationale: "bug signal",
			});
			setupDraftingPath();
			mocks.generateObject.mockResolvedValue({
				object: {
					title: "Bug: [BUG] No output generated",
					needsMoreInfo: false,
					markdown: "Some bug body without a duplicating heading.",
				},
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "caller title",
				description: "raw",
				kind: "BUG",
			});

			expect(lastCreateStoryCall().title).toBe("No output generated");
		});

		it("AC5: '[BUG] No Output Generated' keeps its casing (not lowercased)", async () => {
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "FEATURE",
				confidence: "High",
				fallback_used: false,
				primary_signals: [],
				rationale: "feature signal",
			});
			setupDraftingPath();
			mocks.generateObject.mockResolvedValue({
				object: { description: "Feature body, no duplicate heading." },
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "[BUG] No Output Generated",
				description: "raw",
				kind: "FEATURE",
			});

			expect(lastCreateStoryCall().title).toBe("No Output Generated");
		});
	});

	describe("AC8: B-020 body-H1 shape", () => {
		it("removes a '# Bug: <title>' H1 and preserves the Bug Metadata block", async () => {
			const title =
				"AI Update incorrectly includes Teams channel chat messages";
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "BUG",
				confidence: "High",
				fallback_used: false,
				primary_signals: [],
				rationale: "bug signal",
			});
			setupDraftingPath();
			mocks.generateObject.mockResolvedValue({
				object: {
					title,
					needsMoreInfo: false,
					markdown: `# Bug: ${title}\n\nBug Metadata\n- Severity: Medium\n- Area: AI Update`,
				},
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "caller title",
				description: "raw",
				kind: "BUG",
			});

			const call = lastCreateStoryCall();
			expect(call.title).toBe(title);
			expect(call.description).toBe(
				"Bug Metadata\n- Severity: Medium\n- Area: AI Update",
			);
		});
	});

	describe("AC6 / AC7: non-duplicate or no leading H1 preserved", () => {
		it("AC6: an unrelated first heading is left intact", async () => {
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "FEATURE",
				confidence: "High",
				fallback_used: false,
				primary_signals: [],
				rationale: "feature signal",
			});
			setupDraftingPath();
			const body = "# Overview\n\nThis describes the feature.";
			mocks.generateObject.mockResolvedValue({
				object: { description: body },
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "No output generated",
				description: "raw",
				kind: "FEATURE",
			});

			expect(lastCreateStoryCall().description).toBe(body);
		});

		it("AC7: a body with no leading H1 is persisted unchanged", async () => {
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "FEATURE",
				confidence: "High",
				fallback_used: false,
				primary_signals: [],
				rationale: "feature signal",
			});
			setupDraftingPath();
			const body =
				"This feature lets users export.\n\n## Details\n\nMore text.";
			mocks.generateObject.mockResolvedValue({
				object: { description: body },
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "Export feature",
				description: "raw",
				kind: "FEATURE",
			});

			expect(lastCreateStoryCall().description).toBe(body);
		});
	});

	describe("REQ-21 / AC12: BUG empty/prefix-only-title fallback preserved", () => {
		it("resolves an empty drafted+caller title to 'Untitled bug'", async () => {
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "BUG",
				confidence: "High",
				fallback_used: false,
				primary_signals: [],
				rationale: "bug signal",
			});
			setupDraftingPath();
			mocks.generateObject.mockResolvedValue({
				object: {
					title: undefined,
					needsMoreInfo: false,
					markdown: "Bug body without a heading.",
				},
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "   ",
				description: "raw",
				kind: "BUG",
			});

			expect(lastCreateStoryCall().title).toBe("Untitled bug");
		});

		it("resolves a prefix-only drafted title to 'Untitled bug'", async () => {
			mocks.classifyWorkItem.mockResolvedValue({
				kind: "BUG",
				confidence: "High",
				fallback_used: false,
				primary_signals: [],
				rationale: "bug signal",
			});
			setupDraftingPath();
			mocks.generateObject.mockResolvedValue({
				object: {
					title: "[BUG] Bug:",
					needsMoreInfo: false,
					markdown: "Bug body without a heading.",
				},
				usage: { totalTokens: 10 },
			});

			await createStoryFromProposal({
				...BASE_PARAMS,
				title: "caller title",
				description: "raw",
				kind: "BUG",
			});

			expect(lastCreateStoryCall().title).toBe("Untitled bug");
		});
	});
});
