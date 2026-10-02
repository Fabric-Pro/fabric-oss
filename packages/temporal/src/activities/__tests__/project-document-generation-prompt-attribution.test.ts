/**
 * Which prompt version a generation is attributed to (Fizzy #2807).
 *
 * The editor's Regenerate passes an explicit `promptId`, and the client's
 * `promptVersionId` beside it can be a stale pin. The run renders the prompt's
 * newest version either way, so the activity — not the client — has to say
 * which version that was. Otherwise the workflow falls back to the client's id
 * and the document's version history names a version that never ran, while the
 * list page's Regenerate (bound path) records the right one for the same text.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	runsStream: vi.fn(),
	hasProjectAccess: vi.fn(),
	projectFindUnique: vi.fn(),
	fetchAndRenderPrompt: vi.fn(),
	renderPromptWithContext: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
}));

vi.mock("@langchain/langgraph-sdk", () => ({
	Client: class {
		assistants = { getSchemas: vi.fn().mockResolvedValue({}) };
		runs = {
			stream: (...args: unknown[]) => mocks.runsStream(...args),
		};
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) =>
				mocks.projectFindUnique(...args),
		},
	},
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
	recordAuditDurable: vi.fn(),
	listEmbeddedDocumentsForSweep: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/rag", () => ({}));

vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	getAIModelWithMetadata: (...args: unknown[]) =>
		mocks.getAIModelWithMetadata(...args),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@repo/ai/skills", () => ({
	isTextContentType: vi.fn(),
	loadSkillBundle: vi.fn(),
	readSkillFile: vi.fn(),
}));

vi.mock("../prompt-activities", () => ({
	fetchAndRenderPrompt: (...args: unknown[]) =>
		mocks.fetchAndRenderPrompt(...args),
	renderPromptWithContext: (...args: unknown[]) =>
		mocks.renderPromptWithContext(...args),
}));

vi.mock("@temporalio/activity", async () => {
	const temporalCommon = await import("@temporalio/common");
	return {
		Context: { current: { heartbeat: vi.fn() } },
		heartbeat: vi.fn(),
		ApplicationFailure: temporalCommon.ApplicationFailure,
	};
});

vi.mock("../lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { generateDocumentWithAgent } from "../project-document-generation";

function generate(promptId?: string) {
	return generateDocumentWithAgent({
		projectId: "project-1",
		documentId: "doc-1",
		documentType: "PROPOSAL",
		prompt: "",
		contexts: ["The client picks 4,000 orders a day on paper."],
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		promptId,
		hasRagContexts: true,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.projectFindUnique.mockResolvedValue({
		name: "Warehouse modernization",
		description: "Replace paper-based picking.",
		goals: null,
		techStack: ["React"],
		features: [],
		projectTypes: [],
		qaStrategyLevel: null,
	});
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "example-model", provider: "openai" },
		trackUsage: vi.fn(),
	});
	mocks.runsStream.mockImplementation(() =>
		(async function* () {
			yield {
				event: "values",
				data: { document: "## Executive Summary\n\nBody." },
			};
		})(),
	);
});

describe("prompt version attribution", () => {
	it("attributes an explicitly chosen prompt to the version it rendered", async () => {
		mocks.renderPromptWithContext.mockResolvedValue({
			rendered: "Write the client-facing proposal.",
			version: 9,
			versionId: "pv_9",
			format: "MARKDOWN",
		});

		const result = await generate("prompt_proposal");

		expect(mocks.renderPromptWithContext).toHaveBeenCalledWith(
			expect.objectContaining({ promptId: "prompt_proposal" }),
		);
		expect(result.resolvedPromptVersionId).toBe("pv_9");
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ promptVersionId: "pv_9" }),
		);
	});

	it("attributes the bound prompt to the version the renderer reports", async () => {
		mocks.fetchAndRenderPrompt.mockResolvedValue({
			rendered: "Write the client-facing proposal.",
			promptId: "prompt_proposal",
			promptName: "Project Proposal Document",
			promptVersionId: "pv_9",
			scope: "SYSTEM",
		});

		const result = await generate();

		expect(mocks.renderPromptWithContext).not.toHaveBeenCalled();
		expect(result.resolvedPromptVersionId).toBe("pv_9");
	});

	it("leaves attribution open when the explicit prompt fails to render", async () => {
		mocks.renderPromptWithContext.mockRejectedValue(
			new Error("Prompt not found: prompt_gone"),
		);

		const result = await generate("prompt_gone");

		// The run fell back to the built-in instructions, so no prompt version
		// produced it — said with an explicit null, which the workflow reads
		// as an answer rather than as a result from an older worker.
		expect(result).toHaveProperty("resolvedPromptVersionId", null);
	});
});
