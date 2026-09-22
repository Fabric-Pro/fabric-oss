/**
 * Project Context — the knowledge sources a project's AI features read from.
 *
 * One call so far: push a text file into the Context keyed by its path, the
 * primitive `fabric context push` is built on. A synced file is identified by
 * the project plus its normalized `sourcePath`, and replacing one is a
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
 * What a push that was not refused did.
 *
 * - `created` — a new path; the source was stored and indexing started.
 * - `updated` — the stored version was the one named in
 *   `expectedContentHash`, and it was replaced.
 * - `unchanged` — the path already holds exactly this content. Nothing was
 *   written. Also what a retried request whose first attempt landed gets.
 * - `duplicate` — the path is new, but identical content is already in the
 *   project under another source, so nothing was created.
 */
export type SyncedContextFileResult =
	| (SyncedContextFileOutcomeBase & {
			status: "created" | "updated" | "unchanged";
	  })
	| (SyncedContextFileOutcomeBase & {
			status: "duplicate";
			duplicateOfContextId: string;
			/** `null` when the other source was not pushed by path. */
			duplicateOfSourcePath: string | null;
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

/** The 409 payload: this push, and the version it lost to. */
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
	 * elsewhere in the project.
	 */
	current: SyncedContextFileCurrentVersion | null;
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
	 * Omitting it never means overwrite.
	 */
	expectedContentHash?: string;
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

export class ContextsResource {
	constructor(private readonly http: FabricHttpClient) {}

	/**
	 * Create or replace one synced text file in the project's Context.
	 *
	 * Requires a key with `projects:write`, and the key's creator must still
	 * hold permission to add context sources to that project — the scope is a
	 * ceiling, never a grant.
	 *
	 * Resolves with `created`, `updated`, `unchanged` or `duplicate`. A
	 * conflict rejects with {@link FabricContextConflictError}, carrying the
	 * stored version's hash and editor.
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
		};
		try {
			return await this.http.put<SyncedContextFileResult>(
				`/projects/${encodeURIComponent(projectId)}/contexts/synced-files${query}`,
				body,
			);
		} catch (error) {
			if (
				error instanceof FabricError &&
				error.status === 409 &&
				isConflictPayload(error.data)
			) {
				throw new FabricContextConflictError(error.message, error.data);
			}
			throw error;
		}
	}
}
