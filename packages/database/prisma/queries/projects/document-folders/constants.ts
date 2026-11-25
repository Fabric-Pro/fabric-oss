/**
 * Document-folder statuses, codes and limits.
 */

export const DOCUMENT_FOLDER_FILE_STATUS = {
	PENDING: "PENDING",
	IMPORTING: "IMPORTING",
	IMPORTED: "IMPORTED",
	SKIPPED: "SKIPPED",
	FAILED: "FAILED",
	EXCLUDED: "EXCLUDED",
	REFRESHING: "REFRESHING",
} as const;

export type DocumentFolderFileStatus =
	(typeof DOCUMENT_FOLDER_FILE_STATUS)[keyof typeof DOCUMENT_FOLDER_FILE_STATUS];

export const DOCUMENT_FOLDER_SKIP_CODE = {
	UNSUPPORTED: "UNSUPPORTED",
	TOO_BIG: "TOO_BIG",
	CAP_REACHED: "CAP_REACHED",
	/** The drive refuses to hand the file over (Google: `canDownload: false`). */
	NOT_DOWNLOADABLE: "NOT_DOWNLOADABLE",
} as const;

export type DocumentFolderSkipCode =
	(typeof DOCUMENT_FOLDER_SKIP_CODE)[keyof typeof DOCUMENT_FOLDER_SKIP_CODE];

export const DOCUMENT_FOLDER_FAILURE_CODE = {
	DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
	PROCESSING_FAILED: "PROCESSING_FAILED",
} as const;

export type DocumentFolderFailureCode =
	(typeof DOCUMENT_FOLDER_FAILURE_CODE)[keyof typeof DOCUMENT_FOLDER_FAILURE_CODE];

export const DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE = {
	TOO_LARGE: "TOO_LARGE",
	THROTTLED: "THROTTLED",
	/** Graph refused part of the tree for a reason other than throttling. */
	PARTIAL_READ: "PARTIAL_READ",
	MASS_REMOVAL: "MASS_REMOVAL",
} as const;

export type DocumentFolderPausedRemovalsCode =
	(typeof DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE)[keyof typeof DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE];

export const DOCUMENT_FOLDER_PROBLEM_CODE = {
	RECONNECT: "RECONNECT",
	NO_ACCESS: "NO_ACCESS",
	FOLDER_GONE: "FOLDER_GONE",
	SYNC_START_FAILED: "SYNC_START_FAILED",
} as const;

export type DocumentFolderProblemCode =
	(typeof DOCUMENT_FOLDER_PROBLEM_CODE)[keyof typeof DOCUMENT_FOLDER_PROBLEM_CODE];

export type DocumentFolderProvider = "onedrive" | "sharepoint" | "googledrive";

/** `metadata.provider` of a context imported from a document folder. */
export const DOCUMENT_FOLDER_CONTEXT_PROVIDER = {
	onedrive: "onedrive-documents",
	sharepoint: "sharepoint-documents",
	googledrive: "googledrive-documents",
} as const satisfies Record<DocumentFolderProvider, string>;

export const DOCUMENT_FOLDER_CONTEXT_PROVIDERS: readonly string[] =
	Object.values(DOCUMENT_FOLDER_CONTEXT_PROVIDER);

/** Files a folder imports: the most recently modified, as a rolling window. */
export const DOCUMENT_FOLDER_IMPORT_CAP = 500;
/** Connected document folders a project may have. */
export const DOCUMENT_FOLDER_MAX_PER_PROJECT = 20;
/** A read that would remove more than this share of a folder's files... */
export const DOCUMENT_FOLDER_MASS_REMOVAL_RATIO = 0.2;
/** ...and at least this many, waits for an editor to confirm instead. */
export const DOCUMENT_FOLDER_MASS_REMOVAL_MIN = 10;
/** Longest stored folder description, in characters. */
export const DOCUMENT_FOLDER_DESCRIPTION_MAX = 500;
/** Context deletions one pass drives, which bounds the workflow's history. */
export const DOCUMENT_FOLDER_DELETIONS_PER_PASS = 200;

/** Misses in consecutive complete listings before a file is looked up. */
export const MISSES_BEFORE_LOOKUP = 2;
/** Reads of the same new version before a changed file is imported again. */
export const READS_BEFORE_REFRESH = 2;
/** Files that need attention a folder lists by name, for its editors. */
export const ATTENTION_FILES_SHOWN = 10;
export const INSERT_CHUNK = 1000;

/**
 * Advisory-lock class for connecting folders to a project, document or
 * transcript. One class for both, so the checks that keep the two kinds from
 * overlapping read a state no other connect is changing.
 */
export const FOLDER_CONNECT_ADVISORY_CLASS = 0x44664378; // "DfCx"

/** One read's reconciliation may write a few thousand rows. */
export const RECONCILE_TRANSACTION = { timeout: 60_000, maxWait: 10_000 };
/** Options for a transaction holding the folder-connect lock. */
export const FOLDER_CONNECT_TRANSACTION = { timeout: 30_000, maxWait: 10_000 };
