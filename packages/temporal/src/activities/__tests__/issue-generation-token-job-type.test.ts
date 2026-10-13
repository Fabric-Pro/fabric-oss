/**
 * A reissued generation token keeps the run's job type, so a batch
 * generation's agents still resolve on the organization's shared plans
 * (Fizzy #2770).
 */

import { runWithAiJobType } from "@repo/ai/lib/job-context";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueAIToken = vi.hoisted(() => vi.fn(async () => "example-token"));
vi.mock("@repo/ai-token", () => ({ issueAIToken }));

const mocks = vi.hoisted(() => ({
	runsStream: vi.fn(),
	hasProjectAccess: vi.fn(),
	projectFindUnique: vi.fn(),
	fetchAndRenderPrompt: vi.fn(),
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

vi.mock("@repo/rag", () => ({
	buildDocumentRetrievalQuery: () => "build document retrieval query",
	searchSimilarProjectContexts: vi.fn(),
	extractBaseContextId: (id: string) => id,
	enrichContextsWithRoleTags: vi.fn(),
	applyContextSummary: vi.fn(),
	rerankContexts: vi.fn(),
	embedProjectDocument: vi.fn(),
	reembedProjectDocument: vi.fn(),
	deleteStaleDocumentEmbeddingChunks: vi.fn(),
	searchSimilarEpisodes: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	getAIModelWithMetadata: vi.fn().mockResolvedValue({
		model: {},
		metadata: { modelString: "example-model", provider: "openai" },
		trackUsage: vi.fn(),
	}),
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
	renderPromptWithContext: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({
	Context: { current: { heartbeat: vi.fn() } },
	heartbeat: vi.fn(),
	ApplicationFailure: { nonRetryable: (msg: string) => new Error(msg) },
}));

vi.mock("../lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import AFTER mocks
// Import AFTER mocks
import { issueGenerationToken } from "../project-document-generation";

beforeEach(() => {
	issueAIToken.mockClear();
});

describe("issueGenerationToken", () => {
	it("carries the run's job type into the reissued token", async () => {
		await runWithAiJobType("batch-document-generation", () =>
			issueGenerationToken({ userId: "user-1", organizationId: "org-1" }),
		);
		expect(issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({ jobType: "batch-document-generation" }),
		);
	});

	it("names no job outside one", async () => {
		await issueGenerationToken({
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({ jobType: undefined }),
		);
	});
});
