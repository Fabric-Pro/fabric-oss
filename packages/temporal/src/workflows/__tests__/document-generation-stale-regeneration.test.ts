/**
 * A regeneration of a document that holds visual slots must not overwrite a
 * newer version of it (Fizzy #2589, KTD17).
 *
 * `generateDocumentWithAgent` splices the slots of the body the run started
 * from back into the generated body. If the person adds, deletes or moves a
 * slot while the run is generating, writing that body would restore the old
 * slot layout over their newer document. So when slots are involved the
 * generation activity reports the version its slots were lifted from
 * (`baselineVersion`), and the workflow hands it to `saveProjectDocument`,
 * which writes only if the document is still at that version.
 *
 * Pinned here, at the workflow seam between the two activities:
 *  - a slot-free generation saves with exactly the three arguments it always
 *    had, so its history and its write are unchanged;
 *  - a baseline reported by the generation reaches the save;
 *  - a save that finds the document moved abandons the run through the
 *    existing failure path: FAILED with the activity's own sentence, nothing
 *    versioned or embedded, and a non-retryable failure;
 *  - the same baseline reaches `createDocumentVersion`, and a version step
 *    that finds the regenerated body no longer live abandons the run the
 *    same way, instead of being shrugged off like an ordinary version
 *    failure. A slot-free run calls it with exactly its four arguments.
 */
import { ActivityFailure, ApplicationFailure } from "@temporalio/workflow";
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
	// The Proposal artifact gate is off (Fizzy #2801): no plan, so the
	// run takes the path these tests pin.
	planProposalArtifact: vi.fn(async () => null),
}));

vi.mock("@temporalio/workflow", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/workflow")>();
	return {
		...actual,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		patched: vi.fn(() => true),
		proxyActivities: vi.fn(() => activityStubs),
		// A Proposal asks the (gate-off) plan, handing it the run id.
		workflowInfo: () => ({ runId: "run-1", startTime: new Date() }),
	};
});

import { documentGenerationChildWorkflow } from "../document-generation-child";

const INPUT = {
	projectId: "project-1",
	documentId: "doc-1",
	documentType: "PROPOSAL",
	userId: "user-1",
	organizationId: "org-1",
	aiToken: "token-1",
	currentDocument: "# Proposal\n\nThe body the run started from.",
};

const GENERATED = "# Proposal\n\nThe regenerated body.";

/** The sentence the save activity refuses a moved document with. */
const STALE_MESSAGE =
	"This document changed while it was being regenerated, so the regenerated text was discarded and the newer version was kept. Regenerate again to start from the current version.";

/** What the save activity does against a document now at version 8. */
async function saveRefusingBaseline7(...args: unknown[]): Promise<void> {
	const options = args[3] as { baselineVersion?: number } | undefined;
	// Only the guarded call can see the move — a save that never received
	// the baseline writes blind.
	if (options?.baselineVersion === 7) {
		throw ApplicationFailure.nonRetryable(
			STALE_MESSAGE,
			"DOCUMENT_GENERATION_STALE",
		);
	}
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(error: unknown) => error,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	activityStubs.retrieveProjectContexts.mockResolvedValue([]);
	activityStubs.retrieveAndFormatEpisodicMemory.mockResolvedValue({
		formattedContext: "",
		episodeCount: 0,
	});
	activityStubs.checkProjectHasTeamsIntegration.mockResolvedValue(false);
	activityStubs.checkProjectHasSlackIntegration.mockResolvedValue(false);
	activityStubs.saveProjectDocument.mockResolvedValue(undefined);
	activityStubs.createDocumentVersion.mockResolvedValue(undefined);
	activityStubs.embedProjectDocumentActivity.mockResolvedValue({
		success: true,
	});
	activityStubs.updateProjectDocumentStatus.mockResolvedValue(undefined);
	activityStubs.runDocumentDecisionPrecheckActivity.mockResolvedValue(
		undefined,
	);
});

describe("document generation — slot-free regeneration is unchanged", () => {
	it("saves with exactly the three arguments it always had", async () => {
		activityStubs.generateDocumentWithAgent.mockResolvedValue({
			content: GENERATED,
		});

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(activityStubs.saveProjectDocument).toHaveBeenCalledTimes(1);
		// Not `toHaveBeenCalledWith`: a trailing `undefined` would be a fourth
		// payload in the activity's scheduled input, and this pins that there
		// is none.
		const [call] = activityStubs.saveProjectDocument.mock.calls;
		expect(call).toEqual(["doc-1", GENERATED, "user-1"]);
		expect(call).toHaveLength(3);
		expect(activityStubs.createDocumentVersion).toHaveBeenCalledTimes(1);
		const [versionCall] = activityStubs.createDocumentVersion.mock.calls;
		expect(versionCall).toEqual(["doc-1", GENERATED, "user-1", undefined]);
		expect(versionCall).toHaveLength(4);
	});
});

describe("document generation — the generation baseline reaches the save", () => {
	it("hands the version the slots were lifted from to saveProjectDocument", async () => {
		activityStubs.generateDocumentWithAgent.mockResolvedValue({
			content: GENERATED,
			baselineVersion: 7,
		});

		await documentGenerationChildWorkflow(INPUT);

		expect(activityStubs.saveProjectDocument).toHaveBeenCalledTimes(1);
		expect(activityStubs.saveProjectDocument.mock.calls[0]).toEqual([
			"doc-1",
			GENERATED,
			"user-1",
			{ baselineVersion: 7 },
		]);
	});

	it("abandons the run as stale when the document moved past the baseline", async () => {
		activityStubs.generateDocumentWithAgent.mockResolvedValue({
			content: GENERATED,
			baselineVersion: 7,
		});
		activityStubs.saveProjectDocument.mockImplementation(
			saveRefusingBaseline7,
		);

		const failure = await failureOf(documentGenerationChildWorkflow(INPUT));

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect((failure as ApplicationFailure).nonRetryable).toBe(true);
		expect((failure as ApplicationFailure).message).toBe(STALE_MESSAGE);

		// Not left GENERATING: the existing failure path marks the row FAILED
		// and records the activity's sentence as the reason.
		expect(activityStubs.updateProjectDocumentStatus).toHaveBeenCalledWith({
			documentId: "doc-1",
			status: "FAILED",
			progress: 0,
			error: STALE_MESSAGE,
		});

		// Nothing after the refused save runs: the discarded body is neither
		// versioned, pre-checked nor embedded.
		expect(activityStubs.createDocumentVersion).not.toHaveBeenCalled();
		expect(
			activityStubs.runDocumentDecisionPrecheckActivity,
		).not.toHaveBeenCalled();
		expect(
			activityStubs.embedProjectDocumentActivity,
		).not.toHaveBeenCalled();
	});
});

/**
 * The failure a real version step's refusal reaches the workflow as: Temporal
 * wraps the activity's `ApplicationFailure` in an `ActivityFailure`.
 */
function staleVersionStepFailure(): ActivityFailure {
	return new ActivityFailure(
		"Activity task failed",
		"createDocumentVersion",
		"7",
		"NON_RETRYABLE_FAILURE",
		"worker@example.com",
		ApplicationFailure.nonRetryable(
			STALE_MESSAGE,
			"DOCUMENT_GENERATION_STALE",
		),
	);
}

describe("document generation — the generation baseline reaches the version step", () => {
	it("hands the same baseline to createDocumentVersion", async () => {
		activityStubs.generateDocumentWithAgent.mockResolvedValue({
			content: GENERATED,
			resolvedPromptVersionId: "prompt-v1",
			baselineVersion: 7,
		});

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(activityStubs.createDocumentVersion).toHaveBeenCalledTimes(1);
		expect(activityStubs.createDocumentVersion.mock.calls[0]).toEqual([
			"doc-1",
			GENERATED,
			"user-1",
			"prompt-v1",
			{ baselineVersion: 7 },
		]);
	});

	it("abandons the run as stale when the document moved between the save and the version step", async () => {
		activityStubs.generateDocumentWithAgent.mockResolvedValue({
			content: GENERATED,
			baselineVersion: 7,
		});
		activityStubs.createDocumentVersion.mockRejectedValue(
			staleVersionStepFailure(),
		);

		const failure = await failureOf(documentGenerationChildWorkflow(INPUT));

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect((failure as ApplicationFailure).nonRetryable).toBe(true);
		expect((failure as ApplicationFailure).message).toBe(STALE_MESSAGE);
		expect(activityStubs.updateProjectDocumentStatus).toHaveBeenCalledWith({
			documentId: "doc-1",
			status: "FAILED",
			progress: 0,
			error: STALE_MESSAGE,
		});
		// The person's newer document is not embedded as this run's output.
		expect(
			activityStubs.embedProjectDocumentActivity,
		).not.toHaveBeenCalled();
	});

	it("still treats any other version-step failure as non-fatal", async () => {
		activityStubs.generateDocumentWithAgent.mockResolvedValue({
			content: GENERATED,
			baselineVersion: 7,
		});
		activityStubs.createDocumentVersion.mockRejectedValue(
			new Error("connection reset"),
		);

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(
			activityStubs.embedProjectDocumentActivity,
		).toHaveBeenCalledTimes(1);
		expect(
			activityStubs.updateProjectDocumentStatus,
		).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "FAILED" }),
		);
	});
});
