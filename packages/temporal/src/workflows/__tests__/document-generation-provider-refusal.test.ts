/**
 * Step 1 of document generation retrieves RAG context, and its catch decides
 * whether the failure is fatal or merely means "generate without RAG".
 *
 * That decision used to be two substring tests — `"No AI provider configured"`
 * and `"Please configure"`. `@repo/ai` throws four messages behind ONE error
 * class, and the embedding one that context retrieval actually hits ("No
 * embedding provider configured. Please set an embedding provider in
 * Settings → AI Providers.") matches neither. A provider-less tenant therefore
 * had its configuration verdict read as a transient Qdrant outage: the workflow
 * carried on, spent the full retry budget on generation, and failed there
 * instead — with copy about generation rather than about the missing provider.
 *
 * The branch now matches on the error's IDENTITY, which is what survives
 * Temporal's ActivityFailure -> ApplicationFailure wrapping.
 */
import { ApplicationFailure } from "@temporalio/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	retrieveProjectContexts: vi.fn(),
	retrieveAndFormatEpisodicMemory: vi.fn(),
	generateDocumentWithAgent: vi.fn(),
	saveProjectDocument: vi.fn(),
	createDocumentVersion: vi.fn(),
	embedProjectDocumentActivity: vi.fn(),
	checkProjectHasTeamsIntegration: vi.fn(),
	fetchRecentTeamsMessages: vi.fn(),
	checkProjectHasSlackIntegration: vi.fn(),
	fetchRecentSlackMessages: vi.fn(),
	updateProjectDocumentStatus: vi.fn(),
	runDocumentDecisionPrecheckActivity: vi.fn(),
}));

const capturedBags = vi.hoisted(() => [] as Array<Record<string, unknown>>);

/** Drives `patched()` — true is a new execution, false replays an old history. */
const patchedGate = vi.hoisted(() => ({ on: true }));

vi.mock("@temporalio/workflow", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/workflow")>();
	return {
		...actual,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		patched: vi.fn(() => patchedGate.on),
		proxyActivities: vi.fn((options: Record<string, unknown>) => {
			capturedBags.push(options);
			return activityStubs;
		}),
	};
});

import { documentGenerationChildWorkflow } from "../document-generation-child";

const INPUT = {
	projectId: "p1",
	documentId: "d1",
	documentType: "PRD",
	userId: "u1",
	organizationId: "org1",
	aiToken: "token",
};

/** Exactly what a keyless tenant's embedding resolution throws. */
const EMBEDDING_REFUSAL =
	"No embedding provider configured. Please set an embedding provider in Settings → AI Providers.";
/** …and what the language-model path throws instead. */
const LANGUAGE_MODEL_REFUSAL =
	"No AI provider configured. Please configure an AI provider in Settings → AI Providers.";

beforeEach(() => {
	vi.clearAllMocks();
	patchedGate.on = true;
	activityStubs.updateProjectDocumentStatus.mockResolvedValue(undefined);
	activityStubs.retrieveAndFormatEpisodicMemory.mockResolvedValue({
		formatted: "",
		count: 0,
	});
	activityStubs.checkProjectHasTeamsIntegration.mockResolvedValue(false);
	activityStubs.checkProjectHasSlackIntegration.mockResolvedValue(false);
	activityStubs.runDocumentDecisionPrecheckActivity.mockResolvedValue(
		undefined,
	);
});

describe("document generation, context retrieval refused for want of a provider", () => {
	it.each([
		["the embedding refusal", EMBEDDING_REFUSAL],
		["the language-model refusal", LANGUAGE_MODEL_REFUSAL],
	])(
		"treats %s as fatal and never reaches generation",
		async (_l, message) => {
			activityStubs.retrieveProjectContexts.mockRejectedValue(
				// How it arrives from a worker: the class name is recorded as the
				// ApplicationFailure `type`, and the message rides along.
				ApplicationFailure.nonRetryable(
					message,
					"AIProviderNotConfiguredError",
				),
			);

			await expect(
				documentGenerationChildWorkflow(INPUT),
			).rejects.toThrow(message);
			expect(
				activityStubs.generateDocumentWithAgent,
			).not.toHaveBeenCalled();
			expect(activityStubs.saveProjectDocument).not.toHaveBeenCalled();
		},
	);

	it("still degrades to no-RAG when retrieval fails for an unrelated reason", async () => {
		// The other half of the contract: a Qdrant outage is NOT a reason to
		// abandon the document, and widening the fatal branch must not have
		// made it one.
		activityStubs.retrieveProjectContexts.mockRejectedValue(
			new Error("Qdrant connection refused"),
		);
		activityStubs.generateDocumentWithAgent.mockResolvedValue({
			content: "# Draft",
		});
		activityStubs.saveProjectDocument.mockResolvedValue(undefined);
		activityStubs.createDocumentVersion.mockResolvedValue(undefined);
		activityStubs.embedProjectDocumentActivity.mockResolvedValue({
			success: true,
		});

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(activityStubs.generateDocumentWithAgent).toHaveBeenCalled();
	});

	it("leaves an in-flight execution on its recorded path", async () => {
		// The widened branch is gated: a history recorded before this change
		// carried on without RAG after the same failure, and replaying it down
		// the new branch would fail with a non-determinism error (TMPRL1100).
		patchedGate.on = false;
		activityStubs.retrieveProjectContexts.mockRejectedValue(
			ApplicationFailure.nonRetryable(
				EMBEDDING_REFUSAL,
				"AIProviderNotConfiguredError",
			),
		);
		activityStubs.generateDocumentWithAgent.mockResolvedValue({
			content: "# Draft",
		});
		activityStubs.saveProjectDocument.mockResolvedValue(undefined);
		activityStubs.createDocumentVersion.mockResolvedValue(undefined);
		activityStubs.embedProjectDocumentActivity.mockResolvedValue({
			success: true,
		});

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
	});

	it("does not retry the refusal on the model-touching proxy", async () => {
		// Retrieval, generation and embedding share one proxy at 5 attempts
		// backing off to a minute. Without the policy a provider-less tenant
		// pays that ladder per activity to learn what the first attempt knew.
		const modelProxy = capturedBags.find(
			(bag) =>
				(bag.retry as { maximumAttempts?: number } | undefined)
					?.maximumAttempts === 5,
		);
		expect(modelProxy).toBeDefined();
		expect(
			(
				modelProxy?.retry as
					| { nonRetryableErrorTypes?: string[] }
					| undefined
			)?.nonRetryableErrorTypes,
		).toContain("AIProviderNotConfiguredError");
	});
});
