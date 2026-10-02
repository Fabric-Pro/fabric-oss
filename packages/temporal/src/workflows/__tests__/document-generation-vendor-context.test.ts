/**
 * `hasRagContexts` at the child workflow counts only the project's own
 * context (Fizzy #2719).
 *
 * Proposal and Business Case retrieval can now return the organization's
 * company context too, as vendor-marked entries. The flag decides whether the
 * generation prompt keeps the project's wizard features: retrieved context
 * defines the product and replaces them. Vendor material describes the
 * organization writing the document, not this product, so a project whose only
 * retrieved entries are vendor material must keep its features.
 *
 * Harness convention (see `supplied-context-wiring.test.ts`): mock the activity
 * surface and drive the workflow body as a plain async function. Replay safety
 * is covered by the replay-validation matrix: recorded histories hold no
 * marked entries, so the flag's value for them is unchanged.
 */

import { VENDOR_CONTEXT_MARKER } from "@repo/agent-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { activityMocks } = vi.hoisted(() => ({
	activityMocks: {
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
	},
}));

vi.mock("@temporalio/workflow", () => {
	class ActivityFailure extends Error {}
	class ApplicationFailure extends Error {
		static nonRetryable(message: string, type?: string) {
			const failure = new ApplicationFailure(message);
			(failure as ApplicationFailure & { type?: string }).type = type;
			return failure;
		}
	}
	return {
		ActivityFailure,
		ApplicationFailure,
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		patched: () => true,
		proxyActivities: () => activityMocks,
	};
});

import { documentGenerationChildWorkflow } from "../document-generation-child";

const CHILD_INPUT = {
	projectId: "proj_1",
	documentId: "doc_1",
	documentType: "PROPOSAL",
	userId: "user_1",
	organizationId: "org_1",
	aiToken: "ai-token",
	prompt: "",
};

const VENDOR_ENTRY = `${VENDOR_CONTEXT_MARKER}\n[Source: Case study]\nWe rolled out scanning.`;

/** The arguments the generation activity was handed. */
function generationArgs(): { contexts: string[]; hasRagContexts: boolean } {
	const call = activityMocks.generateDocumentWithAgent.mock.calls[0]?.[0];
	if (!call) {
		throw new Error("generateDocumentWithAgent was never called");
	}
	return call;
}

beforeEach(() => {
	vi.clearAllMocks();

	activityMocks.retrieveAndFormatEpisodicMemory.mockResolvedValue({
		episodeCount: 0,
		formattedContext: "",
	});
	activityMocks.checkProjectHasTeamsIntegration.mockResolvedValue(false);
	activityMocks.checkProjectHasSlackIntegration.mockResolvedValue(false);
	activityMocks.generateDocumentWithAgent.mockResolvedValue({
		content: "# Generated",
	});
	activityMocks.saveProjectDocument.mockResolvedValue(undefined);
	activityMocks.createDocumentVersion.mockResolvedValue(undefined);
	activityMocks.embedProjectDocumentActivity.mockResolvedValue({
		success: true,
	});
	activityMocks.updateProjectDocumentStatus.mockResolvedValue(undefined);
	activityMocks.runDocumentDecisionPrecheckActivity.mockResolvedValue(
		undefined,
	);
});

describe("documentGenerationChildWorkflow hasRagContexts", () => {
	it("is false when the only retrieved entries are vendor material", async () => {
		activityMocks.retrieveProjectContexts.mockResolvedValue([VENDOR_ENTRY]);

		await documentGenerationChildWorkflow(CHILD_INPUT);

		const args = generationArgs();
		// The vendor material still reaches generation …
		expect(args.contexts).toEqual([VENDOR_ENTRY]);
		// … but does not count as the project's own context.
		expect(args.hasRagContexts).toBe(false);
	});

	it("is true when the project has context of its own beside vendor material", async () => {
		activityMocks.retrieveProjectContexts.mockResolvedValue([
			"project context",
			VENDOR_ENTRY,
		]);

		await documentGenerationChildWorkflow(CHILD_INPUT);

		expect(generationArgs().hasRagContexts).toBe(true);
	});

	it("is unchanged without vendor material: true with context, false without", async () => {
		activityMocks.retrieveProjectContexts.mockResolvedValue([
			"project context",
		]);
		await documentGenerationChildWorkflow(CHILD_INPUT);
		expect(generationArgs().hasRagContexts).toBe(true);

		vi.clearAllMocks();
		activityMocks.retrieveAndFormatEpisodicMemory.mockResolvedValue({
			episodeCount: 0,
			formattedContext: "",
		});
		activityMocks.checkProjectHasTeamsIntegration.mockResolvedValue(false);
		activityMocks.checkProjectHasSlackIntegration.mockResolvedValue(false);
		activityMocks.generateDocumentWithAgent.mockResolvedValue({
			content: "# Generated",
		});
		activityMocks.retrieveProjectContexts.mockResolvedValue([]);
		await documentGenerationChildWorkflow(CHILD_INPUT);
		expect(generationArgs().hasRagContexts).toBe(false);
	});

	it("counts supplied source text as the project's own context", async () => {
		activityMocks.retrieveProjectContexts.mockResolvedValue([VENDOR_ENTRY]);

		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			suppliedContext: "[Uploaded Document: Pasted source]\ndraft text",
		});

		expect(generationArgs().hasRagContexts).toBe(true);
	});
});
