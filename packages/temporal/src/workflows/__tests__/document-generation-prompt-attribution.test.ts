/**
 * Which prompt version the child workflow records on the new document version
 * (Fizzy #2807).
 *
 * The generation activity reports the version it rendered — an id, or null
 * when no prompt version produced the run — and the workflow records that, not
 * the client's `promptVersionId`, which can be a stale pin. A result recorded
 * by a worker from before that change has no key at all; a run in flight across
 * the deploy resumes with such a result and keeps the old fallback to the
 * client's id instead of losing its attribution.
 *
 * Convention (see `supplied-context-wiring.test.ts`): mock the activity surface
 * and drive the workflow body as a plain async function.
 */

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
		// The Proposal artifact gate is off (Fizzy #2801): no plan, so the
		// run takes the path these tests pin.
		planProposalArtifact: vi.fn(async () => null),
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
		executeChild: vi.fn(),
		startChild: vi.fn(),
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		ParentClosePolicy: {
			PARENT_CLOSE_POLICY_ABANDON: "ABANDON",
		},
		patched: () => true,
		proxyActivities: () => activityMocks,
		sleep: vi.fn(async () => undefined),
		workflowInfo: () => ({
			workflowId: "wf_1",
			runId: "run_1",
			continueAsNewSuggested: false,
		}),
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
	promptId: "prompt_proposal",
	// What the editor sent: the stale pin of a second binding.
	promptVersionId: "pv_3",
};

/** The prompt version id the new document version was recorded with. */
function recordedPromptVersionId(): unknown {
	const call = activityMocks.createDocumentVersion.mock.calls[0];
	if (!call) {
		throw new Error("createDocumentVersion was never called");
	}
	return call[3];
}

beforeEach(() => {
	vi.clearAllMocks();
	activityMocks.retrieveProjectContexts.mockResolvedValue([
		"retrieved context",
	]);
	activityMocks.retrieveAndFormatEpisodicMemory.mockResolvedValue({
		episodeCount: 0,
		formattedContext: "",
	});
	activityMocks.checkProjectHasTeamsIntegration.mockResolvedValue(false);
	activityMocks.checkProjectHasSlackIntegration.mockResolvedValue(false);
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

describe("prompt version recorded on the document version", () => {
	it("records the version the activity rendered, not the client's", async () => {
		activityMocks.generateDocumentWithAgent.mockResolvedValue({
			content: "# Generated",
			resolvedPromptVersionId: "pv_9",
		});

		await documentGenerationChildWorkflow(CHILD_INPUT);

		expect(recordedPromptVersionId()).toBe("pv_9");
	});

	it("records no version when the activity says none produced the run", async () => {
		activityMocks.generateDocumentWithAgent.mockResolvedValue({
			content: "# Generated",
			resolvedPromptVersionId: null,
		});

		await documentGenerationChildWorkflow(CHILD_INPUT);

		expect(recordedPromptVersionId()).toBeUndefined();
	});

	it("keeps the client's id for a result recorded before the activity reported it", async () => {
		// The shape an older worker recorded on the custom-prompt path.
		activityMocks.generateDocumentWithAgent.mockResolvedValue({
			content: "# Generated",
		});

		await documentGenerationChildWorkflow(CHILD_INPUT);

		expect(recordedPromptVersionId()).toBe("pv_3");
	});
});
