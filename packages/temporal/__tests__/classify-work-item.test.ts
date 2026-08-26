/**
 * Unit tests for the F-171 work-item classifier helper.
 *
 * Covers:
 *   - Happy path: bug_classifier prompt is bound → LLM returns valid JSON →
 *     classifyWorkItem returns the parsed output verbatim.
 *   - Fallback paths: bound prompt missing, LLM unconfigured, LLM throws,
 *     schema mismatch — all return the safe SAFE_FALLBACK
 *     (kind=FEATURE, fallback_used=true). REQ-22 / NFR observability:
 *     silent corruption of `kind` must not happen.
 *
 * Mocks @repo/ai, @repo/database, @repo/utils so we exercise the helper's
 * branching without a live AI provider or DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, AIProviderNotConfiguredError } = vi.hoisted(() => {
	class AIProviderNotConfiguredError extends Error {
		constructor() {
			super("AI provider not configured");
			this.name = "AIProviderNotConfiguredError";
		}
	}
	return {
		AIProviderNotConfiguredError,
		mocks: {
			getBoundPromptForAgent: vi.fn(),
			generateObject: vi.fn(),
			getAIModelWithMetadata: vi.fn(),
			logModelUsageAsync: vi.fn(),
			renderTemplate: vi.fn(),
		},
	};
});

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError,
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {},
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("@repo/utils", () => ({
	renderTemplate: mocks.renderTemplate,
}));

import { classifyWorkItem } from "../src/lib/classify-work-item";

const STANDARD_INPUT = {
	reporterText: "Login button stops working after 2 clicks, returns 500",
	creationSource: "MANUAL" as const,
	userId: "user-1",
	organizationId: "org-1",
	projectId: "proj-1",
};

const SAFE_FALLBACK = {
	kind: "FEATURE" as const,
	confidence: "Low" as const,
	fallback_used: true,
	primary_signals: [] as string[],
	rationale: "classifier_error",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.renderTemplate.mockResolvedValue({
		rendered: "rendered-prompt",
		error: null,
	});
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { modelId: "test-model" },
		metadata: { provider: "test" },
		trackUsage: vi.fn(),
	});
});

describe("classifyWorkItem", () => {
	it("returns the LLM output verbatim on happy path (BUG)", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_classifier",
			format: "MARKDOWN",
			version: { content: "classifier prompt body" },
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				kind: "BUG",
				confidence: "High",
				fallback_used: false,
				primary_signals: ["returns 500", "stops working"],
				rationale: "explicit regression signal",
			},
			usage: { totalTokens: 42 },
		});

		const result = await classifyWorkItem(STANDARD_INPUT);

		expect(result.kind).toBe("BUG");
		expect(result.confidence).toBe("High");
		expect(result.fallback_used).toBe(false);
		expect(result.primary_signals).toContain("returns 500");
		expect(mocks.generateObject).toHaveBeenCalledOnce();
		expect(mocks.logModelUsageAsync).toHaveBeenCalledOnce();
	});

	it("returns SAFE_FALLBACK when bug_classifier prompt is not bound", async () => {
		// No prompt resolves — environment hasn't been seeded yet.
		mocks.getBoundPromptForAgent.mockResolvedValue(null);

		const result = await classifyWorkItem(STANDARD_INPUT);

		expect(result).toEqual(SAFE_FALLBACK);
		// We should NOT have called the LLM if no prompt is bound.
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("returns SAFE_FALLBACK when the bound key isn't bug_classifier", async () => {
		// Some other prompt is bound at (project_document_generator, GENERAL,
		// null) — guard against shipping the wrong prompt to the classifier.
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "some_other_prompt",
			format: "MARKDOWN",
			version: { content: "wrong prompt" },
		});

		const result = await classifyWorkItem(STANDARD_INPUT);

		expect(result).toEqual(SAFE_FALLBACK);
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("returns SAFE_FALLBACK when AI provider is not configured", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_classifier",
			format: "MARKDOWN",
			version: { content: "classifier prompt body" },
		});
		mocks.generateObject.mockRejectedValue(
			new AIProviderNotConfiguredError(),
		);

		const result = await classifyWorkItem(STANDARD_INPUT);

		expect(result).toEqual(SAFE_FALLBACK);
	});

	it("returns SAFE_FALLBACK when the LLM call throws unexpectedly", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_classifier",
			format: "MARKDOWN",
			version: { content: "classifier prompt body" },
		});
		mocks.generateObject.mockRejectedValue(new Error("network down"));

		const result = await classifyWorkItem(STANDARD_INPUT);

		expect(result).toEqual(SAFE_FALLBACK);
	});

	it("reconciles to FEATURE when LLM returns BUG with fallback_used=true", async () => {
		// Defense-in-depth: some models report fallback_used=true (per the
		// prompt's low-confidence rule) but still emit kind=BUG anyway.
		// The helper must override to FEATURE so the contract holds.
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_classifier",
			format: "HANDLEBARS",
			version: { content: "classifier prompt body" },
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				kind: "BUG",
				confidence: "High",
				fallback_used: true,
				primary_signals: ["nothing clear"],
				rationale: "Reverting to conservative BUG (LLM misbehavior)",
			},
			usage: { totalTokens: 20 },
		});

		const result = await classifyWorkItem(STANDARD_INPUT);

		expect(result.kind).toBe("FEATURE");
		expect(result.fallback_used).toBe(true);
	});

	it("reconciles to FEATURE when LLM returns BUG with confidence=Low", async () => {
		// Same contract for Low confidence — the prompt's heuristics say
		// "Low: vague, short, or mixed; use fallback to FEATURE".
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_classifier",
			format: "HANDLEBARS",
			version: { content: "classifier prompt body" },
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				kind: "BUG",
				confidence: "Low",
				fallback_used: false,
				primary_signals: [],
				rationale: "Input is terse",
			},
			usage: { totalTokens: 15 },
		});

		const result = await classifyWorkItem(STANDARD_INPUT);

		expect(result.kind).toBe("FEATURE");
		expect(result.fallback_used).toBe(true);
	});

	it("preserves BUG when confidence is High and fallback_used is false", async () => {
		// Sanity check: reconciliation only kicks in for Low/fallback cases.
		// Genuine high-confidence BUG classifications must pass through.
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_classifier",
			format: "HANDLEBARS",
			version: { content: "classifier prompt body" },
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				kind: "BUG",
				confidence: "High",
				fallback_used: false,
				primary_signals: ["returns 500", "stops working"],
				rationale: "Clear regression",
			},
			usage: { totalTokens: 40 },
		});

		const result = await classifyWorkItem(STANDARD_INPUT);

		expect(result.kind).toBe("BUG");
		expect(result.fallback_used).toBe(false);
	});

	it("classifies FEATURE-shaped text as FEATURE", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_classifier",
			format: "MARKDOWN",
			version: { content: "classifier prompt body" },
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				kind: "FEATURE",
				confidence: "Medium",
				fallback_used: false,
				primary_signals: ["we should add"],
				rationale: "asks for a new capability",
			},
			usage: { totalTokens: 30 },
		});

		const result = await classifyWorkItem({
			...STANDARD_INPUT,
			reporterText: "We should add bulk export to the dashboard.",
		});

		expect(result.kind).toBe("FEATURE");
		expect(result.fallback_used).toBe(false);
	});

	it("passes reporterText through the template renderer in the right slot", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_classifier",
			format: "MARKDOWN",
			version: { content: "classifier prompt body" },
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				kind: "FEATURE",
				confidence: "Low",
				fallback_used: true,
				primary_signals: [],
				rationale: "vague",
			},
			usage: { totalTokens: 10 },
		});

		await classifyWorkItem({
			...STANDARD_INPUT,
			reporterText: "very specific text",
			creationSource: "SLACK",
			additionalContext: "thread context",
		});

		expect(mocks.renderTemplate).toHaveBeenCalledWith(
			expect.objectContaining({
				variables: expect.objectContaining({
					reporter_text: "very specific text",
					creation_source: "SLACK",
					additional_context: "thread context",
				}),
			}),
		);
	});
});
