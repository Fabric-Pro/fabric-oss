/**
 * `extractLivingMemoryDecisionsActivity`: one confirmed content version of a
 * synced Living Memory file in, one extraction row out.
 *
 * Pinned here: the decisions are recorded with the version's hash; a version
 * with no decision is recorded as an empty list (so it is never read again);
 * a version is extracted at most once; store-only, non-synced and superseded
 * rows are skipped; a project without an AI provider is skipped without a
 * record; the instructions come from the Prompt Library binding with the
 * seeded body as the fallback; only an extraction that found something
 * announces it, leaving out the member whose own scan started it; a decision
 * is linked to the one project work item it (or else its file) names; and the
 * record says when the file met the character or decision limit.
 */
import {
	LIVING_MEMORY_DECISION_FILE_CHAR_CAP,
	LIVING_MEMORY_DECISION_MAX_PER_FILE,
} from "@repo/utils/living-memory-decision-limits";
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
		resolveProjectFeatureRef: vi.fn(),
		warn: vi.fn(),
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
	logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

vi.mock("../../lib/bound-prompt", () => ({
	resolveBoundPromptText: mocks.resolveBoundPromptText,
}));

vi.mock("../../shared/project-feature-reads", () => ({
	resolveProjectFeatureRef: mocks.resolveProjectFeatureRef,
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
	mocks.resolveProjectFeatureRef.mockResolvedValue(undefined);
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
				contentTruncated: false,
				decisionsCapped: false,
				userId: "user-1",
				organizationId: "org-1",
			},
			select: { id: true },
		});
		expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
		expect(mocks.notify).toHaveBeenCalledWith({ extractionId: "ext-1" });
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("announces a requested scan's decisions to the reviewers, leaving out the member who asked", async () => {
		await expect(
			extractLivingMemoryDecisionsActivity({
				...input,
				requestedByUserId: "member-9",
			}),
		).resolves.toMatchObject({ status: "recorded" });

		expect(mocks.notify).toHaveBeenCalledWith({
			extractionId: "ext-1",
			excludeUserIds: ["member-9"],
		});
	});

	it("records without notifying when the start said not to", async () => {
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

	describe("the work item a decision came from", () => {
		/** The decisions the activity recorded. */
		function recorded(): Array<Record<string, unknown>> {
			return mocks.extractionCreate.mock.calls[0]?.[0].data.decisions;
		}

		beforeEach(() => {
			mocks.resolveProjectFeatureRef.mockImplementation(
				async (ref: string) =>
					ref === "F-12"
						? {
								id: "story-12",
								identifier: "F-012",
								kind: "FEATURE",
								title: "Storage",
							}
						: undefined,
			);
		});

		it("links the one work item the decision's quote names, within the project", async () => {
			mocks.generateText.mockResolvedValue({
				output: {
					decisions: [
						{
							text: "We use Postgres.",
							sourceQuote: "Decided in F-012: we use Postgres.",
						},
					],
				},
			});

			await extractLivingMemoryDecisionsActivity(input);

			expect(mocks.resolveProjectFeatureRef).toHaveBeenCalledWith(
				"F-12",
				"proj-1",
			);
			expect(recorded()).toEqual([
				{
					text: "We use Postgres.",
					sourceQuote: "Decided in F-012: we use Postgres.",
					workItem: { id: "story-12", identifier: "F-012" },
				},
			]);
		});

		it("reads the decision's text when its quote names none", async () => {
			mocks.generateText.mockResolvedValue({
				output: { decisions: [{ text: "F-12 keeps Postgres." }] },
			});

			await extractLivingMemoryDecisionsActivity(input);

			expect(recorded()[0]?.workItem).toEqual({
				id: "story-12",
				identifier: "F-012",
			});
		});

		it("falls back to the one work item the file names", async () => {
			mocks.contextFindUnique.mockResolvedValue({
				...syncedRow,
				sourcePath: "specs/F-012-storage/decisions.md",
				content:
					"# Storage decisions\n\nWe use Postgres for all persistence.",
			});

			await extractLivingMemoryDecisionsActivity(input);

			expect(recorded()[0]?.workItem).toEqual({
				id: "story-12",
				identifier: "F-012",
			});
		});

		it("links nothing when the file names more than one work item", async () => {
			mocks.contextFindUnique.mockResolvedValue({
				...syncedRow,
				content:
					"# F-012 and F-013\n\nWe use Postgres for all persistence.",
			});

			await extractLivingMemoryDecisionsActivity(input);

			expect(mocks.resolveProjectFeatureRef).not.toHaveBeenCalled();
			expect(recorded()[0]).not.toHaveProperty("workItem");
		});

		it("links nothing when the decision itself names more than one", async () => {
			mocks.generateText.mockResolvedValue({
				output: {
					decisions: [
						{
							text: "We use Postgres.",
							sourceQuote: "F-012 replaces B-4: we use Postgres.",
						},
					],
				},
			});

			await extractLivingMemoryDecisionsActivity(input);

			expect(mocks.resolveProjectFeatureRef).not.toHaveBeenCalled();
			expect(recorded()[0]).not.toHaveProperty("workItem");
		});

		it("links nothing for an identifier the project does not have", async () => {
			mocks.generateText.mockResolvedValue({
				output: {
					decisions: [
						{ text: "We use Postgres.", sourceQuote: "Per B-77." },
					],
				},
			});

			await extractLivingMemoryDecisionsActivity(input);

			expect(mocks.resolveProjectFeatureRef).toHaveBeenCalledWith(
				"B-77",
				"proj-1",
			);
			expect(recorded()[0]).not.toHaveProperty("workItem");
		});

		it("looks each identifier up once per file", async () => {
			mocks.generateText.mockResolvedValue({
				output: {
					decisions: [
						{ text: "F-012 uses Postgres." },
						{ text: "F-12 keeps one store." },
					],
				},
			});

			await extractLivingMemoryDecisionsActivity(input);

			expect(mocks.resolveProjectFeatureRef).toHaveBeenCalledTimes(1);
			expect(recorded().map((d) => d.workItem)).toEqual([
				{ id: "story-12", identifier: "F-012" },
				{ id: "story-12", identifier: "F-012" },
			]);
		});
	});

	describe("a file that met a limit", () => {
		it("records that only the first characters of a long file were read", async () => {
			mocks.contextFindUnique.mockResolvedValue({
				...syncedRow,
				content: `We use Postgres.\n${"x".repeat(LIVING_MEMORY_DECISION_FILE_CHAR_CAP)}`,
			});

			await extractLivingMemoryDecisionsActivity(input);

			expect(mocks.extractionCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						contentTruncated: true,
						decisionsCapped: false,
					}),
				}),
			);
			expect(mocks.generateText.mock.calls[0]?.[0].prompt).toContain(
				`[truncated at ${LIVING_MEMORY_DECISION_FILE_CHAR_CAP} characters]`,
			);
			expect(mocks.warn).toHaveBeenCalledWith(
				"[LivingMemoryDecisions] file only partly read",
				expect.objectContaining({
					contextId: "ctx-1",
					contentTruncated: true,
				}),
			);
		});

		it("records that only the first decisions were kept, counting distinct ones past the cap", async () => {
			mocks.generateText.mockResolvedValue({
				output: {
					decisions: Array.from(
						{ length: LIVING_MEMORY_DECISION_MAX_PER_FILE + 1 },
						(_, i) => ({ text: `Decision ${i}` }),
					),
				},
			});

			await expect(
				extractLivingMemoryDecisionsActivity(input),
			).resolves.toMatchObject({
				decisionCount: LIVING_MEMORY_DECISION_MAX_PER_FILE,
			});

			expect(mocks.extractionCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						contentTruncated: false,
						decisionsCapped: true,
					}),
				}),
			);
			expect(mocks.warn).toHaveBeenCalledTimes(1);
		});

		it("does not call a file capped when its extras past the cap are only repeats", async () => {
			mocks.generateText.mockResolvedValue({
				output: {
					decisions: [
						...Array.from(
							{ length: LIVING_MEMORY_DECISION_MAX_PER_FILE },
							(_, i) => ({ text: `Decision ${i}` }),
						),
						{ text: "decision 0" },
						{ text: "  " },
					],
				},
			});

			await extractLivingMemoryDecisionsActivity(input);

			expect(mocks.extractionCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ decisionsCapped: false }),
				}),
			);
			expect(mocks.warn).not.toHaveBeenCalled();
		});
	});
});
