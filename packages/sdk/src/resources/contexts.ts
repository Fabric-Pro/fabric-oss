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

export class ContextsResource {
	constructor(private readonly http: FabricHttpClient) {}

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
