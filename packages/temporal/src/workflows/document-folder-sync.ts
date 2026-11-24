/**
 * One per project: keeps its connected OneDrive and SharePoint document
 * folders in step with the drive (Fizzy #2808).
 *
 * Started, or woken, by connecting a folder and by Sync now, both through
 * signal-with-start, so either one restarts a run that has ended. Each pass
 * reads the due folders one at a time, confirms the files two complete reads
 * missed, deletes the contexts of files that left or changed, and imports the
 * files waiting in the due folders, each through the generic processing
 * workflow as a child. It then waits for Sync now, or for the earlier of the
 * interval and a throttled folder's next-read-after time.
 *
 * It ends only when the project has no connected document folder; an
 * activity that fails past its retries ends that pass, not the run. While the
 * feature flag is off its activities report nothing due, so it waits rather
 * than ends, and reads resume once the flag is on again; the flag is read in
 * activities only.
 *
 * Transcript folders run in their own workflow and are not touched here.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules.
 */

import {
	type RetryPolicy,
	WorkflowExecutionAlreadyStartedError,
} from "@temporalio/common";
import {
	ActivityFailure,
	ChildWorkflowFailure,
	condition,
	continueAsNew,
	defineSignal,
	executeChild,
	proxyActivities,
	setHandler,
	uuid4,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import { PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE } from "../task-queues";
import {
	type ContextDeletionWorkflowOutput,
	contextDeletionWorkflow,
} from "./context-deletion";
import { projectContextProcessingWorkflow } from "./project-context-processing";

const RETRY: RetryPolicy = {
	initialInterval: "10s",
	backoffCoefficient: 2,
	maximumInterval: "2m",
	maximumAttempts: 5,
	nonRetryableErrorTypes: ["ValidationError", "TenantViolation"],
};

const {
	listDocumentFoldersToSync,
	listDocumentFolderDeletions,
	finishDocumentFolderContextDeletion,
	listDocumentFolderImports,
	importDocumentFolderFile,
	markDocumentFolderFileDownloadFailed,
	recordDocumentFolderFileProcessing,
} = proxyActivities<typeof activities>({
	taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
	// A file download is at most the upload limit of 20 MB.
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "2 minutes",
	retry: RETRY,
});

const { readDocumentFolder, confirmDocumentFolderCandidates } = proxyActivities<
	typeof activities
>({
	taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
	// A tree walk of up to 5,000 items, one Graph request per folder and
	// page. It heartbeats after every request, and the request helper's
	// longest wait between retries is 15 seconds.
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "2 minutes",
	retry: { ...RETRY, maximumAttempts: 3 },
});

/** How long a project's document folders rest between reads. */
const DOCUMENT_FOLDER_SYNC_INTERVAL_MS = 30 * 60 * 1000;

/** Files imported per batch, between continue-as-new checks. */
const DOCUMENT_FOLDER_IMPORT_BATCH = 20;

/** Shortest wait, so a next-read-after already past cannot spin the loop. */
const MIN_WAIT_MS = 1000;

/** Wakes the sync at once: a folder was connected, or Sync now was asked. */
export const syncDocumentFoldersNowSignal = defineSignal(
	"syncDocumentFoldersNow",
);

export interface DocumentFolderSyncWorkflowInput {
	projectId: string;
	/** A hint only: activities read the organization from the project row. */
	organizationId: string;
}

/** One deletion child per context, so a retried pass cannot start two. */
function documentFolderContextDeletionWorkflowId(contextId: string): string {
	return `document-folder-context-deletion-${contextId}`;
}

function earlier(a: string | null, b: string | null): string | null {
	if (!a) {
		return b;
	}
	if (!b) {
		return a;
	}
	return Date.parse(a) <= Date.parse(b) ? a : b;
}

function waitMs(nextReadAfter: string | null): number {
	if (!nextReadAfter) {
		return DOCUMENT_FOLDER_SYNC_INTERVAL_MS;
	}
	const until = Date.parse(nextReadAfter) - Date.now();
	if (Number.isNaN(until)) {
		return DOCUMENT_FOLDER_SYNC_INTERVAL_MS;
	}
	return Math.min(
		DOCUMENT_FOLDER_SYNC_INTERVAL_MS,
		Math.max(until, MIN_WAIT_MS),
	);
}

function isActivityFailure(error: unknown): boolean {
	return error instanceof ActivityFailure;
}

/**
 * Read one folder and, after a complete read, confirm its candidates. A read
 * whose retries ran out removes nothing, and the next pass tries again.
 * Returns the folder's next-read-after time, if it was throttled.
 */
async function readFolder(folderId: string): Promise<string | null> {
	let read: Awaited<ReturnType<typeof readDocumentFolder>>;
	try {
		read = await readDocumentFolder({ folderId, passId: uuid4() });
	} catch (error) {
		if (!isActivityFailure(error)) {
			throw error;
		}
		return null;
	}
	if (read.complete) {
		try {
			await confirmDocumentFolderCandidates({
				folderId,
				candidates: read.candidates,
			});
		} catch (error) {
			if (!isActivityFailure(error)) {
				throw error;
			}
		}
	}
	return read.nextReadAfter;
}

/**
 * Delete one pass's worth of contexts whose files left, changed or fell out
 * of the import window. A row is released only after its deletion child
 * succeeded and the follow-up confirmed it; otherwise it stays for the next
 * pass, as do rows past this pass's share.
 */
async function runDeletions(projectId: string): Promise<void> {
	const { deletions } = await listDocumentFolderDeletions({ projectId });
	for (const row of deletions) {
		let result: ContextDeletionWorkflowOutput;
		try {
			result = await executeChild(contextDeletionWorkflow, {
				workflowId: documentFolderContextDeletionWorkflowId(
					row.contextId,
				),
				args: [
					{
						contextId: row.contextId,
						projectId: row.projectId,
						userId: row.userId,
						organizationId: row.organizationId,
						metadata: { reason: "document-folder-sync" },
					},
				],
			});
		} catch (error) {
			// Still running from an earlier run, or failed: the row keeps its
			// context and the next pass drives it again.
			if (
				error instanceof WorkflowExecutionAlreadyStartedError ||
				error instanceof ChildWorkflowFailure
			) {
				continue;
			}
			throw error;
		}
		if (!result.success) {
			continue;
		}
		try {
			await finishDocumentFolderContextDeletion({
				fileId: row.fileId,
				contextId: row.contextId,
				organizationId: row.organizationId,
			});
		} catch (error) {
			if (!isActivityFailure(error)) {
				throw error;
			}
		}
	}
}

/** Import one file. False when it settled nothing and still waits. */
async function importFile(fileId: string): Promise<boolean> {
	let imported: Awaited<ReturnType<typeof importDocumentFolderFile>>;
	try {
		imported = await importDocumentFolderFile({ fileId });
	} catch (error) {
		if (!isActivityFailure(error)) {
			throw error;
		}
		// The copy kept failing. The file says so; a new version tries again.
		// Nothing settled when the file was never claimed.
		const { settled } = await markDocumentFolderFileDownloadFailed({
			fileId,
		});
		return settled;
	}
	if (imported.outcome === "waiting") {
		return false;
	}
	if (imported.outcome === "done") {
		return true;
	}

	let processing: "succeeded" | "failed" | "unknown" = "unknown";
	if (imported.outcome === "process") {
		try {
			await executeChild(projectContextProcessingWorkflow, {
				// The upload's own id, so a context is never processed twice.
				workflowId: `project-context-processing-${imported.contextId}`,
				args: [
					{
						contextId: imported.contextId,
						projectId: imported.projectId,
						userId: imported.userId,
						organizationId: imported.organizationId,
						extractionStrategy: "local-only",
					},
				],
			});
			processing = "succeeded";
		} catch (error) {
			if (error instanceof ChildWorkflowFailure) {
				processing = "failed";
			} else if (
				!(error instanceof WorkflowExecutionAlreadyStartedError)
			) {
				throw error;
			}
		}
	}
	const { settled } = await recordDocumentFolderFileProcessing({
		fileId,
		contextId: imported.contextId,
		processing,
	});
	return settled;
}

export async function documentFolderSyncWorkflow(
	input: DocumentFolderSyncWorkflowInput,
): Promise<void> {
	let syncRequested = false;
	setHandler(syncDocumentFoldersNowSignal, () => {
		syncRequested = true;
	});

	const continueIfSuggested = async () => {
		if (workflowInfo().continueAsNewSuggested) {
			await continueAsNew<typeof documentFolderSyncWorkflow>(input);
		}
	};

	/** Drain a folder's waiting files, a batch at a time. */
	const importFolder = async (folderId: string) => {
		for (;;) {
			const { fileIds } = await listDocumentFolderImports({
				folderId,
				limit: DOCUMENT_FOLDER_IMPORT_BATCH,
			});
			let settled = 0;
			for (const fileId of fileIds) {
				if (await importFile(fileId)) {
					settled += 1;
				}
			}
			// A short batch was the last; a full one that settled nothing is
			// waiting on a connection, and waits for the next pass.
			if (
				fileIds.length < DOCUMENT_FOLDER_IMPORT_BATCH ||
				settled === 0
			) {
				return;
			}
			await continueIfSuggested();
		}
	};

	for (;;) {
		// Signals that arrive from here on, during the pass, coalesce into
		// one more pass.
		syncRequested = false;
		let nextReadAfter: string | null = null;
		try {
			const state = await listDocumentFoldersToSync({
				projectId: input.projectId,
			});
			if (!state.anyConnected) {
				// A folder connected while the list was being read signals
				// this run, which a fresh start would not hear: read the list
				// again rather than end with the new folder unread.
				if (syncRequested) {
					continue;
				}
				return;
			}

			nextReadAfter = state.nextReadAfter;
			for (const folderId of state.dueFolderIds) {
				nextReadAfter = earlier(
					nextReadAfter,
					await readFolder(folderId),
				);
			}

			await runDeletions(input.projectId);
			await continueIfSuggested();

			for (const folderId of state.dueFolderIds) {
				await importFolder(folderId);
			}
		} catch (error) {
			// An activity whose retries ran out ends this pass only: nothing
			// restarts an ended run but connect and Sync now, so the next
			// pass comes after the usual wait.
			if (!isActivityFailure(error)) {
				throw error;
			}
		}
		await continueIfSuggested();

		await condition(() => syncRequested, waitMs(nextReadAfter));
	}
}
