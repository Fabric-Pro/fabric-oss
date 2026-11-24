/**
 * Database queries for OneDrive and SharePoint document folders (Fizzy #2808).
 *
 * A connected folder is read with its reader's Microsoft connection. Each file
 * found there gets one ledger row, keyed by folder and drive item, and the
 * row's status is what the file became. The source drive is the authority: a
 * file that changes there is imported again, and one that leaves is removed
 * once two complete listings miss it and a lookup confirms it is gone.
 *
 * NOTE: like `transcript-folders.ts`, these are called from procedures that
 * have already authorized the project and from Temporal activities that check
 * the reader's access themselves, so tenant filtering is not applied here; the
 * raw client is used on purpose. Every write still names the project or the
 * folder it belongs to.
 */

export type {
	DocumentFolderSelection,
	FolderConnectRefusal,
	TranscriptFolderDrivePath,
} from "./connect";
export {
	connectDocumentFolders,
	describeDocumentFolder,
	disconnectDocumentFolder,
	FolderConnectRefusedError,
	lockProjectFolderConnects,
	sameItem,
} from "./connect";
export type {
	DocumentFolderFailureCode,
	DocumentFolderFileStatus,
	DocumentFolderPausedRemovalsCode,
	DocumentFolderProblemCode,
	DocumentFolderProvider,
	DocumentFolderSkipCode,
} from "./constants";
export {
	DOCUMENT_FOLDER_CONTEXT_PROVIDER,
	DOCUMENT_FOLDER_CONTEXT_PROVIDERS,
	DOCUMENT_FOLDER_DELETIONS_PER_PASS,
	DOCUMENT_FOLDER_DESCRIPTION_MAX,
	DOCUMENT_FOLDER_FAILURE_CODE,
	DOCUMENT_FOLDER_FILE_STATUS,
	DOCUMENT_FOLDER_IMPORT_CAP,
	DOCUMENT_FOLDER_MASS_REMOVAL_MIN,
	DOCUMENT_FOLDER_MASS_REMOVAL_RATIO,
	DOCUMENT_FOLDER_MAX_PER_PROJECT,
	DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE,
	DOCUMENT_FOLDER_PROBLEM_CODE,
	DOCUMENT_FOLDER_SKIP_CODE,
	FOLDER_CONNECT_TRANSACTION,
} from "./constants";
export {
	classifyDocumentFolderFile,
	foldersOverlap,
	normalizeDocumentFolderDescription,
} from "./helpers";
export type { DocumentFolderFileOutcome } from "./imports";
export {
	claimDocumentFolderFile,
	completeDocumentFolderFileDeletion,
	createDocumentFolderFileContext,
	getDocumentFolderFileForImport,
	listDocumentFolderFilesNeedingDeletion,
	listPendingDocumentFolderFileIds,
	recordDocumentFolderFileOutcome,
} from "./imports";
export type {
	DocumentFolderCounts,
	DocumentFolderEditorItem,
	DocumentFolderViewerItem,
} from "./list";
export { listDocumentFolders } from "./list";
export type {
	DocumentFolderLedgerRow,
	DocumentFolderListedFile,
	DocumentFolderReconcilePlan,
	DocumentFolderRowPatch,
} from "./plan";
export { planDocumentFolderReconcile } from "./plan";
export {
	finishDocumentFolderRead,
	listDocumentFolderSyncState,
	startDocumentFolderRead,
} from "./read-lifecycle";
export type { DocumentFolderReconcileResult } from "./reconcile";
export { reconcileDocumentFolderListing } from "./reconcile";
export {
	confirmDocumentFolderRemovals,
	recordDocumentFolderLookupsThrottled,
	tombstoneDocumentFolderFiles,
} from "./removals";
