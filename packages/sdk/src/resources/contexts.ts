/**
 * Project Context — the knowledge sources a project's AI features read from.
 *
 * Two calls, the primitives `fabric context push` is built on: push a text
 * file into the Context keyed by its path (or move one to a new path), and
 * delete one by its path. A synced file is identified by the project plus its
 * normalized `sourcePath`; replacing, moving and deleting one are each a
 * compare-and-swap on the stored version's `contentHash`.
 */
import type { FabricHttpClient } from "../client.js";
import { FabricError } from "../types.js";
import type { WorkspaceDocumentContentPage } from "./workspaces.js";

interface SyncedContextFileOutcomeBase {
	/** The context row the outcome is about. */
	contextId: string;
	/** The normalized path the push was keyed on, as the server stores it. */
	sourcePath: string;
	/** sha256 hex of the UTF-8 content that was sent. */
	contentHash: string;
}

/**
 * Why a push that named `movedFromSourcePath` was not applied as a rename.
 * The source at the old path is untouched in every case.
 *
 * - `source-changed` — the old path holds a version other than the one
 *   named; the push is a conflict about that version.
 * - `source-missing` — the old path has no source on the server any more.
 * - `target-exists` — the new path already had its own source, and the old
 *   one is still there.
 * - `content-differs` — the content sent is not the version at the old path;
 *   a move never replaces content, so it was pushed as a new path.
 */
export type SyncedContextFileMoveNotAppliedReason =
	| "source-changed"
	| "source-missing"
	| "target-exists"
	| "content-differs";

export interface SyncedContextFileMoveNotApplied {
	/** The old path, as the server normalized it. */
	movedFromSourcePath: string;
	reason: SyncedContextFileMoveNotAppliedReason;
}

/**
 * What a push that was not refused did.
 *
 * - `created` — a new path; the source was stored and indexing started.
 * - `updated` — the stored version was the one named in
 *   `expectedContentHash`, and it was replaced.
 * - `unchanged` — the path already holds exactly this content. Nothing was
 *   written. Also what a retried request whose first attempt landed gets.
 * - `duplicate` — the path is new, but identical content is already in the
 *   project under another source, so nothing was created.
 * - `moved` — the source at `movedFromSourcePath` was renamed to this path;
 *   its content is unchanged, and it is re-indexed under the new name.
 *
 * A push that named `movedFromSourcePath` and got anything but `moved`
 * carries `moveNotApplied`, saying why.
 */
export type SyncedContextFileResult =
	| (SyncedContextFileOutcomeBase & {
			status: "created" | "updated" | "unchanged";
			moveNotApplied?: SyncedContextFileMoveNotApplied;
	  })
	| (SyncedContextFileOutcomeBase & {
			status: "duplicate";
			duplicateOfContextId: string;
			/** `null` when the other source was not pushed by path. */
			duplicateOfSourcePath: string | null;
			moveNotApplied?: SyncedContextFileMoveNotApplied;
	  })
	| (SyncedContextFileOutcomeBase & {
			status: "moved";
			movedFromSourcePath: string;
	  });

/** The stored version a conflicting push lost to. Never its content. */
export interface SyncedContextFileCurrentVersion {
	contextId: string;
	/**
	 * The hash to pass as `expectedContentHash` to replace this exact
	 * version. `null` for a row stored before hashes were recorded, which no
	 * push can name and therefore none can replace.
	 */
	contentHash: string | null;
	/** ISO 8601, or `null` when the row predates the column. */
	contentUpdatedAt: string | null;
	contentUpdatedBy: { id: string; name: string | null } | null;
}

/**
 * The 409 payload: this push (or delete), and the version it lost to. For a
 * delete, `contentHash` is the hash the call named.
 */
export interface SyncedContextFileConflict
	extends Omit<SyncedContextFileOutcomeBase, "contextId"> {
	status: "conflict";
	/** The row the push lost to; `null` when the path holds none. */
	contextId: string | null;
	/**
	 * The stored version, or `null` when the push named an
	 * `expectedContentHash` and the path holds no source any more: it was
	 * deleted since. Push again without `expectedContentHash` to recreate it,
	 * which answers `duplicate` instead if that content already exists
	 * elsewhere in the project. With `moveNotApplied.reason ===
	 * "source-changed"`, the version at the OLD path.
	 */
	current: SyncedContextFileCurrentVersion | null;
	moveNotApplied?: SyncedContextFileMoveNotApplied;
}

export interface UpsertSyncedContextFileInput {
	/**
	 * The file's path relative to the folder it comes from, e.g.
	 * `docs/architecture.md`. With the project, this is the key.
	 */
	sourcePath: string;
	/** The file's full text, at most 2 MiB of UTF-8, not empty, no NUL. */
	content: string;
	/** How the source is named on the Context tab. Defaults to the file name. */
	title?: string;
	/**
	 * The `contentHash` of the stored version this push replaces. Omitted:
	 * create the path if it is new, otherwise accept only identical content.
	 * Omitting it never means overwrite. Required with `movedFromSourcePath`,
	 * where it names the version at the old path.
	 */
	expectedContentHash?: string;
	/**
	 * The file's previous path, when it was renamed. The source there is
	 * renamed to `sourcePath` (`moved`) when it still holds the version named
	 * in `expectedContentHash` and `content` is that same version.
	 */
	movedFromSourcePath?: string;
}

export interface DeleteSyncedContextFileInput {
	/** The path the file was pushed under. */
	sourcePath: string;
	/**
	 * The `contentHash` of the version to delete. Required: a delete never
	 * removes a version it does not name.
	 */
	expectedContentHash: string;
}

/**
 * What a delete that was not refused did.
 *
 * - `deleted` — the path held the named version, and it is gone, from the
 *   search index first.
 * - `absent` — the path holds no source: deleted already (a retried request
 *   whose first attempt landed gets this), or never pushed.
 * - `in-progress` — the deletion is still running on the server (answered
 *   `202 Accepted`) and the file may or may not be gone yet. Call again to
 *   confirm: a repeat answers `absent` once it is gone, or deletes it
 *   itself.
 *
 * `in-progress` is new since the method was introduced; code that switches
 * over `status` exhaustively needs a case for it.
 */
export type DeletedSyncedContextFileResult =
	| {
			status: "deleted";
			contextId: string;
			sourcePath: string;
			/** The hash of the version that was deleted. */
			contentHash: string;
	  }
	| { status: "absent"; sourcePath: string }
	| { status: "in-progress"; sourcePath: string };

/** What a Living Memory reset did: how many synced files it deleted. */
export interface ResetSyncedContextFilesResult {
	deleted: number;
}

export interface UpsertSyncedContextFileOptions {
	/**
	 * Bind the request to an organization explicitly. It must be the
	 * project's own organization, or the call is a 404.
	 */
	org?: string;
}

/**
 * A push refused because the path holds a different version than the one
 * named — or, with no `expectedContentHash`, any different version at all.
 * Nothing was written.
 *
 * `conflict.current` says what is there instead: its hash, when it changed
 * and who changed it. To keep the local version anyway, push again with
 * `expectedContentHash: conflict.current.contentHash`; to keep theirs, read
 * it first. `conflict.current` is `null` when the version named was deleted
 * on the server since: push again without `expectedContentHash` to recreate
 * it, which answers `duplicate` instead if that content already exists
 * elsewhere in the project. Still a `FabricError` (status 409, code `CONFLICT`), so generic error
 * handling keeps working.
 */
export class FabricContextConflictError extends FabricError {
	constructor(
		message: string,
		public readonly conflict: SyncedContextFileConflict,
	) {
		super(message, 409, "CONFLICT", conflict);
		this.name = "FabricContextConflictError";
	}
}

function isConflictPayload(value: unknown): value is SyncedContextFileConflict {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as { status?: unknown; current?: unknown };
	// `current: null` is a conflict too — the named version was deleted —
	// but the key must be there: a 409 of some other shape is not this one.
	return (
		candidate.status === "conflict" &&
		"current" in candidate &&
		typeof candidate.current === "object"
	);
}

export interface ContextManifestOptions {
	org?: string;
	limit?: number;
	offset?: number;
	includeCodeContexts?: boolean;
	type?: string;
}
export interface ContextManifestSource {
	sourceId: string;
	sourceKind: "project_context";
	title: string;
	type: string;
	readiness:
		| "ready"
		| "pending"
		| "failed"
		| "cancelled"
		| "unavailable"
		| "inspection_required";
	extractionStatus: string;
	revision: string | null;
	revisionReason:
		| "NOT_READY"
		| "CANONICAL_READ_REQUIRED"
		| "DIRECT_READ_LIMIT_EXCEEDED"
		| null;
	byteLength: number | null;
	indexingExcluded: boolean;
	readUrl: string | null;
	readTool: {
		name: "fabric_inspect_context_quality_source";
		args: { projectId: string; sourceId: string };
	} | null;
	citation: {
		sourceKind: "project_context";
		sourceId: string;
		projectId: string;
		revision: string | null;
	};
	omissionReason:
		| "SOURCE_PENDING"
		| "EXTRACTION_FAILED"
		| "EXTRACTION_CANCELLED"
		| "NO_READABLE_CONTENT"
		| "PRIVATE_CONVERSATION_EXCLUDED"
		| "CANONICAL_BODY_NOT_INSPECTED"
		| "DIRECT_READ_LIMIT_EXCEEDED"
		| null;
	updatedAt: string;
}
export interface ContextManifest {
	version: 1;
	organizationId: string;
	projectId: string;
	sources: ContextManifestSource[];
	readPolicy: "compare_returned_revision";
	pagination: {
		offset: number;
		limit: number;
		nextOffset: number | null;
		hasMore: boolean;
		mode: "live_offset";
		snapshotConsistent: false;
	};
	total: number;
	omissions: {
		sourceBodies: true;
		excludedCodeContexts: number;
		workspaceDocuments: "separate_scope";
		historicalVersions: "unsupported";
	};
	relatedCatalogs: {
		workspaces: "/api/v1/workspaces";
		workspaceDocuments: "/api/v1/workspaces/{workspaceId}/documents";
		workspaceDocumentLinks: "/api/v1/projects/{projectId}/contexts/workspace-documents";
	};
}

/** Explicit references only; continuation offsets count Unicode code points. */
export type ContextSelectionReference =
	| {
			sourceKind: "project_context";
			sourceId: string;
			expectedRevision?: string;
			required?: boolean;
	  }
	| {
			sourceKind: "workspace_document";
			workspaceId: string;
			documentId: string;
			expectedRevision?: string;
			required?: boolean;
			offset?: number;
	  };
export interface ContextSelectionInput {
	selections: ContextSelectionReference[];
}
export interface SelectedContextSource {
	selectionIndex: number;
	ref: ContextSelectionReference & {
		expectedRevision: string;
		required: boolean;
	};
	title: string;
	sourceRevision: string;
	excerptHash: string;
	content: string;
	byteLength: number;
	truncated: boolean;
	indexingExcluded: boolean;
	contentRole: "reference_data";
	readMode: "direct";
	range: {
		offset: number;
		returnedCharacters: number;
		nextOffset: number | null;
		offsetUnit: "unicode_code_points";
	};
	citation: {
		href: string;
		sourceKind: "project_context" | "workspace_document";
		sourceId: string;
		revision: string;
	};
}
export interface SelectedContextPacket {
	version: 1;
	organizationId: string;
	projectId: string;
	currentRead: true;
	snapshotConsistent: false;
	historicalVersionsAvailable: false;
	contentRole: "reference_data";
	selectionHash: string;
	sources: SelectedContextSource[];
	omissions: {
		selectionIndex: number;
		ref: ContextSelectionReference;
		reason: "UNAVAILABLE" | "BUDGET_EXCEEDED";
	}[];
}

export interface ProjectWorkspaceDocumentLink {
	id: string;
	availability:
		| "CURRENT"
		| "UPDATED"
		| "PROCESSING"
		| "NEEDS_ATTENTION"
		| "UNAVAILABLE";
	sourceKind: "workspace_document";
	contentRole: "reference_data";
	sharingGranted: false;
	indexedForProject: false;
	documentId?: string;
	workspaceId?: string;
	filename?: string;
	workspaceName?: string;
	sourceRevision?: string;
	sourceRevisionAtLink?: string;
	sourceUpdatedAt?: string;
	addedAt?: string;
}
export interface ProjectWorkspaceDocumentLinksPage {
	permissions: { canAdd: boolean; canRemove: boolean };
	links: ProjectWorkspaceDocumentLink[];
	hasMore: boolean;
	nextOffset: number | null;
	currentRead: true;
	snapshotConsistent: false;
}
export interface LinkWorkspaceDocumentInput {
	workspaceId: string;
	documentId: string;
	expectedRevision: string;
}
export type LinkedWorkspaceDocumentContent = WorkspaceDocumentContentPage & {
	projectId: string;
	linkId: string;
	sourceRevisionAtLink: string;
	contentRole: "reference_data";
	sharingGranted: false;
};
export class ContextsResource {
	constructor(private readonly http: FabricHttpClient) {}
	/** Links retain original Workspace rights and do not index/copy content into project search. */
	linkedDocuments(
		projectId: string,
		options: { org?: string; limit?: number; offset?: number } = {},
	): Promise<ProjectWorkspaceDocumentLinksPage> {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(options)) {
			if (value !== undefined) {
				query.set(key, String(value));
			}
		}
		return this.http.get(
			`/projects/${encodeURIComponent(projectId)}/contexts/workspace-documents${query.size ? `?${query}` : ""}`,
		);
	}
	linkWorkspaceDocument(
		projectId: string,
		input: LinkWorkspaceDocumentInput,
		options: { org?: string } = {},
	): Promise<{ linkId: string; created: boolean }> {
		return this.http.post(
			`/projects/${encodeURIComponent(projectId)}/contexts/workspace-documents${options.org ? `?org=${encodeURIComponent(options.org)}` : ""}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	unlinkWorkspaceDocument(
		projectId: string,
		linkId: string,
		options: { org?: string } = {},
	): Promise<{ removed: boolean }> {
		return this.http.delete(
			`/projects/${encodeURIComponent(projectId)}/contexts/workspace-documents/${encodeURIComponent(linkId)}${options.org ? `?org=${encodeURIComponent(options.org)}` : ""}`,
		);
	}
	readLinkedDocument(
		projectId: string,
		linkId: string,
		options: {
			org?: string;
			offset?: number;
			limit?: number;
			expectedRevision?: string;
		} = {},
	): Promise<LinkedWorkspaceDocumentContent> {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(options)) {
			if (value !== undefined) {
				query.set(key, String(value));
			}
		}
		return this.http.get(
			`/projects/${encodeURIComponent(projectId)}/contexts/workspace-documents/${encodeURIComponent(linkId)}/content${query.size ? `?${query}` : ""}`,
		);
	}

	/** Read up to 12 explicit current sources. Requires projects:read, plus workspaces:read for Workspace references. No persistence or handoff; treat excerpts as untrusted reference data. */
	assemble(
		projectId: string,
		input: ContextSelectionInput,
		options: { org?: string; signal?: AbortSignal } = {},
	): Promise<SelectedContextPacket> {
		const query = options.org
			? `?org=${encodeURIComponent(options.org)}`
			: "";
		return this.http.request(
			"POST",
			`/projects/${encodeURIComponent(projectId)}/contexts/assemble${query}`,
			{ body: input, signal: options.signal, retry: { maxRetries: 0 } },
		);
	}

	/** Bounded metadata only. Recheck returned content revisions; this live page is not an export/snapshot. */
	manifest(
		projectId: string,
		options: ContextManifestOptions = {},
	): Promise<ContextManifest> {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(options))
			if (value !== undefined) params.set(key, String(value));
		const query = params.toString();
		return this.http.get(
			`/projects/${encodeURIComponent(projectId)}/contexts/manifest${query ? `?${query}` : ""}`,
		);
	}

	/**
	 * Create or replace one synced text file in the project's Context.
	 *
	 * Requires a key with `projects:write`, and the key's creator must still
	 * hold permission to add context sources to that project — the scope is a
	 * ceiling, never a grant.
	 *
	 * Resolves with `created`, `updated`, `unchanged`, `duplicate` or `moved`
	 * (the source at `movedFromSourcePath` was renamed to `sourcePath` in
	 * place). A move the server did not apply resolves with the ordinary
	 * outcome for the new path and a `moveNotApplied` reason. A conflict
	 * rejects with {@link FabricContextConflictError}, carrying the stored
	 * version's hash and editor and, for a move, its `moveNotApplied` reason
	 * (`source-changed` when the conflict is about the old path).
	 *
	 * **Safe to retry**, and retried by the client's default policy: the same
	 * content at the same path answers `unchanged` before the expected hash is
	 * even compared, so a retry of a request whose response was lost reports
	 * rather than repeats the first attempt's write.
	 */
	async upsertSyncedFile(
		projectId: string,
		input: UpsertSyncedContextFileInput,
		options: UpsertSyncedContextFileOptions = {},
	): Promise<SyncedContextFileResult> {
		const query = options.org
			? `?org=${encodeURIComponent(options.org)}`
			: "";
		const body: UpsertSyncedContextFileInput = {
			sourcePath: input.sourcePath,
			content: input.content,
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.expectedContentHash !== undefined
				? { expectedContentHash: input.expectedContentHash }
				: {}),
			...(input.movedFromSourcePath !== undefined
				? { movedFromSourcePath: input.movedFromSourcePath }
				: {}),
		};
		try {
			return await this.http.put<SyncedContextFileResult>(
				`/projects/${encodeURIComponent(projectId)}/contexts/synced-files${query}`,
				body,
			);
		} catch (error) {
			throw asConflictError(error);
		}
	}

	/**
	 * Delete one synced file from the project's Context by its path, only in
	 * the version named by `expectedContentHash`.
	 *
	 * Requires a key with `projects:write`, and the key's creator must still
	 * hold permission to delete context sources on that project.
	 *
	 * Resolves with `deleted`, `absent`, or `in-progress` when the deletion
	 * is still running on the server (call again to confirm). If the path
	 * holds another version — someone changed it since — nothing is deleted
	 * and the call rejects with {@link FabricContextConflictError}; to delete
	 * it anyway, call again naming `conflict.current.contentHash`.
	 *
	 * **Safe to retry**: a retry of a delete that landed answers `absent`.
	 */
	async deleteSyncedFile(
		projectId: string,
		input: DeleteSyncedContextFileInput,
		options: UpsertSyncedContextFileOptions = {},
	): Promise<DeletedSyncedContextFileResult> {
		const query = options.org
			? `?org=${encodeURIComponent(options.org)}`
			: "";
		const body: DeleteSyncedContextFileInput = {
			sourcePath: input.sourcePath,
			expectedContentHash: input.expectedContentHash,
		};
		try {
			return await this.http.delete<DeletedSyncedContextFileResult>(
				`/projects/${encodeURIComponent(projectId)}/contexts/synced-files${query}`,
				body,
			);
		} catch (error) {
			throw asConflictError(error);
		}
	}

	/**
	 * Reset the project's Living Memory: delete EVERY file synced into its
	 * Context at once, with their search-index entries queued for removal.
	 *
	 * Requires a key with `projects:write`, and the key's creator must still
	 * hold permission to delete context sources on that project.
	 *
	 * Resolves with `{ deleted }`, 0 when there was nothing to delete. While a
	 * repository sync is connected nothing is deleted and the call rejects
	 * with a `FabricError` (status 409, code `REPOSITORY_SYNC_ACTIVE`):
	 * disconnect the sync first.
	 *
	 * **Safe to retry**: a repeat deletes nothing more. Not retried by the
	 * client, so a reset is never sent twice unasked.
	 */
	resetSyncedFiles(
		projectId: string,
		options: UpsertSyncedContextFileOptions = {},
	): Promise<ResetSyncedContextFilesResult> {
		const query = options.org
			? `?org=${encodeURIComponent(options.org)}`
			: "";
		return this.http.post<ResetSyncedContextFilesResult>(
			`/projects/${encodeURIComponent(projectId)}/contexts/reset${query}`,
			{},
			{ retry: { maxRetries: 0 } },
		);
	}
}

/** A 409 with a conflict payload as the typed error; anything else as it was. */
function asConflictError(error: unknown): unknown {
	if (
		error instanceof FabricError &&
		error.status === 409 &&
		isConflictPayload(error.data)
	) {
		return new FabricContextConflictError(error.message, error.data);
	}
	return error;
}
