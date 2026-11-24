/**
 * The document folder sync's loop paths the time-skipping server cannot
 * reach (Fizzy #2808): continuing as new when the server suggests it, with
 * the same input and even after a failed pass, and a processing child an
 * earlier run still holds open. The workflow's own module runs here with
 * `@temporalio/workflow` replaced, as `idle-monitor-lifecycle.test.ts` does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	acts: {} as Record<string, ReturnType<typeof vi.fn>>,
	suggested: false,
	continueAsNew: vi.fn(),
	executeChild: vi.fn(),
}));

class ContinuedAsNew extends Error {}

vi.mock("@temporalio/workflow", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/workflow")>();
	return {
		...actual,
		// The module destructures its activities once, at import: forward
		// each call to whatever the current test set.
		proxyActivities: () =>
			new Proxy(
				{},
				{
					get:
						(_target, name: string) =>
						(...args: unknown[]) =>
							(state.acts[name] as (...a: unknown[]) => unknown)(
								...args,
							),
				},
			),
		setHandler: () => undefined,
		uuid4: () => "pass-1",
		// The wait always runs out at once; the scripted listings end the run.
		condition: async () => false,
		executeChild: (...args: unknown[]) => state.executeChild(...args),
		workflowInfo: () => ({ continueAsNewSuggested: state.suggested }),
		continueAsNew: async (input: unknown) => {
			state.continueAsNew(input);
			throw new ContinuedAsNew();
		},
	};
});

import {
	ActivityFailure,
	RetryState,
	WorkflowExecutionAlreadyStartedError,
} from "@temporalio/common";
import { documentFolderSyncWorkflow } from "../document-folder-sync";

const INPUT = { projectId: "project-1", organizationId: "org-1" };

const CONNECTED = {
	anyConnected: true,
	dueFolderIds: ["folder-1"],
	nextReadAfter: null,
};
const NONE_CONNECTED = {
	anyConnected: false,
	dueFolderIds: [],
	nextReadAfter: null,
};

function activityFailure(activityType: string): ActivityFailure {
	return new ActivityFailure(
		"Activity task failed",
		activityType,
		"1",
		RetryState.MAXIMUM_ATTEMPTS_REACHED,
		"worker",
	);
}

beforeEach(() => {
	state.suggested = false;
	state.continueAsNew.mockReset();
	state.executeChild.mockReset();
	state.acts = {
		listDocumentFoldersToSync: vi
			.fn()
			.mockResolvedValueOnce(CONNECTED)
			.mockResolvedValue(NONE_CONNECTED),
		readDocumentFolder: vi.fn(async () => ({
			complete: true,
			candidates: [],
			nextReadAfter: null,
		})),
		confirmDocumentFolderCandidates: vi.fn(async () => ({
			status: "retired",
			retiredCount: 0,
		})),
		listDocumentFolderDeletions: vi.fn(async () => ({ deletions: [] })),
		finishDocumentFolderContextDeletion: vi.fn(),
		listDocumentFolderImports: vi.fn(async () => ({ fileIds: [] })),
		importDocumentFolderFile: vi.fn(),
		markDocumentFolderFileDownloadFailed: vi.fn(),
		recordDocumentFolderFileProcessing: vi.fn(async () => ({
			settled: true,
		})),
	};
});

describe("documentFolderSyncWorkflow loop", () => {
	it("continues as new with the same input when the server suggests it", async () => {
		state.suggested = true;

		await expect(documentFolderSyncWorkflow(INPUT)).rejects.toBeInstanceOf(
			ContinuedAsNew,
		);

		expect(state.continueAsNew).toHaveBeenCalledWith(INPUT);
		expect(state.acts.readDocumentFolder).toHaveBeenCalledTimes(1);
	});

	it("still continues as new after a pass whose listing failed", async () => {
		state.suggested = true;
		state.acts.listDocumentFoldersToSync = vi
			.fn()
			.mockRejectedValue(activityFailure("listDocumentFoldersToSync"));

		await expect(documentFolderSyncWorkflow(INPUT)).rejects.toBeInstanceOf(
			ContinuedAsNew,
		);

		expect(state.continueAsNew).toHaveBeenCalledWith(INPUT);
	});

	it("records processing as unknown when an earlier run's child still holds the context", async () => {
		state.acts.listDocumentFolderImports = vi
			.fn()
			.mockResolvedValueOnce({ fileIds: ["file-1"] })
			.mockResolvedValue({ fileIds: [] });
		state.acts.importDocumentFolderFile = vi.fn(async () => ({
			outcome: "process",
			contextId: "ctx-1",
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
		}));
		state.executeChild.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"Workflow execution already started",
				"project-context-processing-ctx-1",
				"projectContextProcessingWorkflow",
			),
		);

		await expect(
			documentFolderSyncWorkflow(INPUT),
		).resolves.toBeUndefined();

		expect(state.executeChild).toHaveBeenCalledTimes(1);
		expect(
			state.acts.recordDocumentFolderFileProcessing,
		).toHaveBeenCalledWith({
			fileId: "file-1",
			contextId: "ctx-1",
			processing: "unknown",
		});
	});
});
