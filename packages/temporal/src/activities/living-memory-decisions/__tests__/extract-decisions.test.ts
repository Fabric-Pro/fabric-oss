/**
 * `extractLivingMemoryDecisionsActivity`: one confirmed content version of a
 * synced Living Memory file in, one extraction row out.
 *
 * Pinned here: the decisions are recorded with the version's hash; a version
 * with no decision is recorded as an empty list (so it is never read again);
 * a version is extracted at most once; store-only, non-synced and superseded
 * rows are skipped; a project without an AI provider is skipped without a
 * record; the instructions come from the Prompt Library binding with the
 * seeded body as the fallback; and only an extraction that found something
 * announces it.
 */
import {
	LIVING_MEMORY_DECISIONS_FALLBACK_BODY,
	LIVING_MEMORY_DECISIONS_PROMPT_AGENT_KEY,
} from "@repo/utils/living-memory-decisions-prompt";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	class TestAIProviderNotConfiguredError extends Error {}
	return {
		TestAIProviderNotConfiguredError,
		contextFindUnique: vi.fn(),
		extractionFindUnique: vi.fn(),
		extractionCreate: vi.fn(),
		notify: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		generateText: vi.fn(),
		trackUsage: vi.fn(),
		resolveBoundPromptText: vi.fn(),
	};
});

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: mocks.TestAIProviderNotConfiguredError,
	generateText: mocks.generateText,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	Output: { object: (spec: unknown) => spec },
}));

vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeScaledOutputTokenBudget: () => undefined,
}));

vi.mock("@repo/ai/lib/structured-output", () => ({
	requireStructuredOutput: <T>(pending: Promise<T>) => pending,
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContext: { findUnique: mocks.contextFindUnique },
		projectContextDecisionExtraction: {
			findUnique: mocks.extractionFindUnique,
			create: mocks.extractionCreate,
		},
	},
	createDecisionCandidatesReadyNotifications: mocks.notify,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

vi.mock("../../lib/bound-prompt", () => ({
	resolveBoundPromptText: mocks.resolveBoundPromptText,
}));

import { extractLivingMemoryDecisionsActivity } from "../extract-decisions";

const HASH = "a".repeat(64);
const input = { contextId: "ctx-1", contentHash: HASH };

const syncedRow = {
	id: "ctx-1",
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
	sourcePath: "docs/architecture.md",
	contentHash: HASH,
	indexingExcluded: false,
	content: "# Architecture\n\nWe use Postgres for all persistence.",
	project: { userId: "owner-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.contextFindUnique.mockResolvedValue(syncedRow);
	mocks.extractionFindUnique.mockResolvedValue(null);
	mocks.extractionCreate.mockResolvedValue({ id: "ext-1" });
	mocks.notify.mockResolvedValue(1);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: "model",
		metadata: { modelString: "example-model" },
		trackUsage: mocks.trackUsage,
	});
	mocks.resolveBoundPromptText.mockResolvedValue({
		text: "SYSTEM INSTRUCTIONS",
		source: "BOUND",
	});
	mocks.generateText.mockResolvedValue({
		output: {
			decisions: [
				{
					text: "  We use Postgres for all persistence.  ",
					rationale: "One operational store.",
					sourceQuote: "We use Postgres for all persistence.",
				},
				{ text: "We use Postgres for all persistence." },
				{ text: "   " },
			],
		},
	});
});

describe("extractLivingMemoryDecisionsActivity", () => {
	it("records the decisions under the version's hash and announces them", async () => {
		const result = await extractLivingMemoryDecisionsActivity(input);

		expect(result).toEqual({
			status: "recorded",
			extractionId: "ext-1",
			decisionCount: 1,
		});
		expect(mocks.extractionCreate).toHaveBeenCalledWith({
			data: {
				contextId: "ctx-1",
				projectId: "proj-1",
				contentHash: HASH,
				sourcePath: "docs/architecture.md",
				decisions: [
					{
						text: "We use Postgres for all persistence.",
						rationale: "One operational store.",
						sourceQuote: "We use Postgres for all persistence.",
					},
				],
				model: "example-model",
				userId: "user-1",
				organizationId: "org-1",
			},
			select: { id: true },
		});
		expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
		expect(mocks.notify).toHaveBeenCalledWith({ extractionId: "ext-1" });
	});

	it("records a requested scan's decisions without notifying per file", async () => {
		await expect(
			extractLivingMemoryDecisionsActivity({ ...input, notify: false }),
		).resolves.toMatchObject({ status: "recorded" });

		expect(mocks.extractionCreate).toHaveBeenCalledTimes(1);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("reads its instructions from the Prompt Library, with the seeded body as the fallback", async () => {
		await extractLivingMemoryDecisionsActivity(input);

		expect(mocks.resolveBoundPromptText).toHaveBeenCalledWith(
			expect.objectContaining({
				agentKey: LIVING_MEMORY_DECISIONS_PROMPT_AGENT_KEY,
				fallbackBody: LIVING_MEMORY_DECISIONS_FALLBACK_BODY,
				scope: {
					userId: "owner-1",
					organizationId: "org-1",
					projectId: "proj-1",
				},
			}),
		);
		const call = mocks.generateText.mock.calls[0]?.[0];
		expect(call.system).toBe("SYSTEM INSTRUCTIONS");
		// Only the data is assembled in code: the file, fenced.
		expect(call.prompt).toContain("File path: docs/architecture.md");
		expect(call.prompt).toContain(
			"<file>\n# Architecture\n\nWe use Postgres for all persistence.\n</file>",
		);
	});

	it("records an empty list for a version with no decision, and announces nothing", async () => {
		mocks.generateText.mockResolvedValue({ output: { decisions: [] } });

		const result = await extractLivingMemoryDecisionsActivity(input);

		expect(result).toEqual({
			status: "recorded",
			extractionId: "ext-1",
			decisionCount: 0,
		});
		expect(mocks.extractionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ decisions: [] }),
			}),
		);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("records an empty file without asking a model", async () => {
		mocks.contextFindUnique.mockResolvedValue({
			...syncedRow,
			content: "  \n",
		});

		const result = await extractLivingMemoryDecisionsActivity(input);

		expect(result).toMatchObject({ status: "recorded", decisionCount: 0 });
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(mocks.generateText).not.toHaveBeenCalled();
	});

	it("extracts a version at most once", async () => {
		mocks.extractionFindUnique.mockResolvedValue({ id: "ext-0" });

		await expect(
			extractLivingMemoryDecisionsActivity(input),
		).resolves.toEqual({ status: "skipped", reason: "already_extracted" });
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.extractionCreate).not.toHaveBeenCalled();
	});

	it("treats a concurrent run's record of the same version as already extracted", async () => {
		mocks.extractionCreate.mockRejectedValue(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
			}),
		);

		await expect(
			extractLivingMemoryDecisionsActivity(input),
		).resolves.toEqual({ status: "skipped", reason: "already_extracted" });
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it.each([
		["a store-only row", { indexingExcluded: true }],
		["a row that is not a synced file", { sourcePath: null }],
	])("skips %s", async (_label, override) => {
		mocks.contextFindUnique.mockResolvedValue({
			...syncedRow,
			...override,
		});

		await expect(
			extractLivingMemoryDecisionsActivity(input),
		).resolves.toEqual({ status: "skipped", reason: "not_eligible" });
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.extractionCreate).not.toHaveBeenCalled();
	});

	it("skips a version the row no longer holds", async () => {
		mocks.contextFindUnique.mockResolvedValue({
			...syncedRow,
			contentHash: "b".repeat(64),
		});

		await expect(
			extractLivingMemoryDecisionsActivity(input),
		).resolves.toEqual({ status: "skipped", reason: "content_changed" });
		expect(mocks.extractionCreate).not.toHaveBeenCalled();
	});

	it("skips without a record when the project has no AI provider", async () => {
		mocks.getAIModelWithMetadata.mockRejectedValue(
			new mocks.TestAIProviderNotConfiguredError("none"),
		);

		await expect(
			extractLivingMemoryDecisionsActivity(input),
		).resolves.toEqual({ status: "skipped", reason: "no_ai_provider" });
		expect(mocks.extractionCreate).not.toHaveBeenCalled();
	});

	it("rethrows any other model failure, for the workflow's retry policy", async () => {
		mocks.generateText.mockRejectedValue(new Error("provider down"));

		await expect(
			extractLivingMemoryDecisionsActivity(input),
		).rejects.toThrow("provider down");
		expect(mocks.extractionCreate).not.toHaveBeenCalled();
	});
});
