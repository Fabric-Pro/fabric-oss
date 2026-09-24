/**
 * Push a text file into a project's Context by its relative path (Fizzy
 * #2616) — the ONE function behind the `projects.contexts.upsertSyncedFile`
 * procedure, the `fabric_upsert_project_context` MCP tool and the v1 REST route
 * `fabric context push` calls, so the embed trigger, the audit row and the
 * realtime refresh cannot drift between them.
 *
 * A synced file is keyed by `projectId` + normalized `sourcePath`:
 *  - a new path creates a TEXT row and embeds it;
 *  - the same content again is a no-op;
 *  - changed content replaces the stored version ONLY when the caller names
 *    the hash it is replacing (`expectedContentHash`), and is then re-embedded
 *    with the old chunks deleted first — a shrinking file would otherwise
 *    leave orphaned `<contextId>-chunk-N` points answering searches with text
 *    the file no longer has;
 *  - without that hash, or with one that is no longer the stored hash, the
 *    push is a conflict and nothing is written. Omitting it means "create if
 *    absent, otherwise only accept identical content"; it never means
 *    "overwrite";
 *  - with a hash but no row at the path any more (deleted since the caller
 *    saw it), the push is a conflict with `current: null` and nothing is
 *    written: recreating it would silently undo the deletion. Sending again
 *    without the hash recreates it, or answers duplicate instead if that
 *    content already exists elsewhere in the project;
 *  - identical content already in the project under another hashed row is
 *    reported as a duplicate instead of being stored twice;
 *  - with `movedFromSourcePath` (Fizzy #2636), the file was renamed: the row
 *    at the old path is renamed in place when it still holds the version
 *    named in `expectedContentHash` (required with it) and the content sent is
 *    that same version, and is re-embedded, because the index carries the
 *    path and the title. Otherwise the answer is the ordinary one for the new
 *    path, with `moveNotApplied` saying why, and the old row is untouched —
 *    or, when the old path changed since the caller saw it, a conflict about
 *    the OLD row. A move never replaces content in the same call.
 *
 * ## Authorization is the caller's
 *
 * Nothing here checks who may write; each surface does, before calling this,
 * and each refuses a caller who cannot see the project as well as one without
 * the permission:
 *  - the procedure asks `resolveEffectiveProjectPermissions` for CONTEXT_CREATE
 *    and the hosting organization, then `hasProjectAccess` for visibility —
 *    the resolver's org-role fallback alone grants an org member permissions
 *    on projects hidden from them;
 *  - the MCP tool asks `resolveGatewayProjectWriteAccessWithHost`, which
 *    answers not-found for a project the caller cannot see, forbidden without
 *    CONTEXT_CREATE, and otherwise the hosting organization, with the API
 *    key's organization binding applied;
 *  - the v1 route (`modules/v1/contexts.ts`) requires the key's
 *    `projects:write` scope, then makes the procedure's two checks for the
 *    key's creator, with the same organization-key binding.
 * `organizationId` here is that hosting organization, never a caller-supplied
 * value.
 */

import { ORPCError } from "@orpc/client";
import {
	ContextSourcePathError,
	db,
	hasControlOrFormatCharacter,
	hashContextContent,
	normalizeContextSourcePath,
	type SyncedContextMoveNotApplied,
	type SyncedContextRow,
	upsertContextBySourcePath,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { startContextEmbeddingWorkflow } from "@repo/temporal/context-embedding-start";
import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../../lib/audit";
import { emitContextChange } from "../../../lib/realtime";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	buildContextContentAuditEvent,
	type SyncedContextSurface,
} from "./context-content-audit";
import { repositoryManagedError } from "./repository-managed";
import { MAX_SYNCED_CONTEXT_BYTES } from "./synced-context-limits";

/** Upper bound on a caller-supplied title. */
export const MAX_SYNCED_CONTEXT_TITLE_LENGTH = 255;

/** A lower-case sha256 hex digest, as `contentHash` is stored. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;
const HAS_NON_WHITESPACE = /\S/;

export interface UpsertSyncedContextInput {
	projectId: string;
	/** As the caller sent it; normalized here. */
	sourcePath: string;
	content: string;
	/** Defaults to the path's basename. */
	title?: string | null;
	/**
	 * The `contentHash` of the stored version the caller means to replace.
	 * Absent: create if absent, otherwise only accept identical content.
	 * With `movedFromSourcePath`, required: the version at the OLD path the
	 * caller last saw.
	 */
	expectedContentHash?: string | null;
	/**
	 * The path this file had before it was renamed, as the caller sent it;
	 * normalized here, and it must name a different path than `sourcePath`.
	 */
	movedFromSourcePath?: string | null;
	/** The human the request acts as. Never a client-supplied field. */
	userId: string;
	/** The project's hosting organization, resolved server-side. */
	organizationId: string | null;
	via: SyncedContextSurface;
	/**
	 * Context for the audit row. A shape-compatible synthetic context is fine
	 * (`recordAuditFromRequest` documents that and swallows its own
	 * failures); the MCP gateway builds one from its session.
	 */
	request: AuditRequestContext;
}

/** The version a conflicting push lost to. Never its content. */
export interface SyncedContextConflict {
	contextId: string;
	contentHash: string | null;
	contentUpdatedAt: Date | null;
	contentUpdatedBy: { id: string; name: string | null } | null;
}

interface SyncedContextOutcomeBase {
	/** The row the outcome is about. */
	contextId: string;
	/** The normalized path the push was keyed on. */
	sourcePath: string;
	/** The hash of the content the caller sent. */
	contentHash: string;
}

/**
 * On every answer to a move that was not applied as a rename: which old path,
 * and why (see `SyncedContextMoveNotAppliedReason` in `@repo/database`). Only
 * `source-missing` means the old path has no row on the server any more.
 */
interface MoveNotAppliedField {
	moveNotApplied?: SyncedContextMoveNotApplied;
}

export type UpsertSyncedContextResult =
	| (SyncedContextOutcomeBase & {
			status: "created" | "updated" | "unchanged";
	  } & MoveNotAppliedField)
	| (SyncedContextOutcomeBase & {
			status: "duplicate";
			duplicateOfContextId: string;
			duplicateOfSourcePath: string | null;
	  } & MoveNotAppliedField)
	| (SyncedContextOutcomeBase & {
			/** The row at `movedFromSourcePath` now lives at `sourcePath`. */
			status: "moved";
			movedFromSourcePath: string;
	  })
	| (Omit<SyncedContextOutcomeBase, "contextId"> & {
			status: "conflict";
			/** The row the push lost to; `null` when the path has none. */
			contextId: string | null;
			/**
			 * The stored version, or `null` when the caller named a hash and
			 * the path no longer holds a row: it was deleted since. With
			 * `moveNotApplied.reason === "source-changed"`, the version at
			 * the OLD path.
			 */
			current: SyncedContextConflict | null;
	  } & MoveNotAppliedField);

function badRequest(message: string): ORPCError<"BAD_REQUEST", unknown> {
	return new ORPCError("BAD_REQUEST", { message });
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function validate(input: UpsertSyncedContextInput): {
	sourcePath: string;
	title: string;
	expectedContentHash: string | undefined;
	movedFromSourcePath: string | undefined;
	bytes: number;
} {
	let sourcePath: string;
	try {
		sourcePath = normalizeContextSourcePath(input.sourcePath);
	} catch (error) {
		if (error instanceof ContextSourcePathError) {
			throw badRequest(error.message);
		}
		throw error;
	}

	// The same rules as the path itself, compared once both are normalized:
	// `docs//a.md` and `docs/a.md` are one path, and a move to itself is not
	// a move.
	let movedFromSourcePath: string | undefined;
	if (input.movedFromSourcePath) {
		try {
			movedFromSourcePath = normalizeContextSourcePath(
				input.movedFromSourcePath,
			);
		} catch (error) {
			if (error instanceof ContextSourcePathError) {
				throw badRequest(`movedFromSourcePath: ${error.message}`);
			}
			throw error;
		}
		if (movedFromSourcePath === sourcePath) {
			throw badRequest(
				"movedFromSourcePath names the same path as sourcePath; send the file without it",
			);
		}
		if (!input.expectedContentHash) {
			throw badRequest(
				"movedFromSourcePath requires expectedContentHash: the contentHash of the version at the old path you last saw",
			);
		}
	}

	// The length test first: it is free, and a UTF-8 encoding is never
	// shorter than the string's UTF-16 length, so it can only refuse content
	// the byte count would refuse too.
	if (
		input.content.length > MAX_SYNCED_CONTEXT_BYTES ||
		Buffer.byteLength(input.content, "utf8") > MAX_SYNCED_CONTEXT_BYTES
	) {
		throw badRequest(
			`content is larger than ${MAX_SYNCED_CONTEXT_BYTES} bytes of UTF-8`,
		);
	}
	if (!HAS_NON_WHITESPACE.test(input.content)) {
		throw badRequest("content is empty");
	}
	// Postgres `text` cannot hold U+0000, so the write would fail as a 500
	// (and the MCP tool would tell the agent a retry might help). It is never
	// part of a text file worth indexing; refuse it here, as the caller's
	// mistake.
	if (input.content.includes("\u0000")) {
		throw badRequest(
			"content contains a NUL (U+0000) character, which cannot be stored; send the file as text",
		);
	}

	const title = input.title?.trim() || basename(sourcePath);
	if (title.length > MAX_SYNCED_CONTEXT_TITLE_LENGTH) {
		throw badRequest(
			`title is longer than ${MAX_SYNCED_CONTEXT_TITLE_LENGTH} characters`,
		);
	}
	// The same rule as the path: the title is shown on the Context tab and
	// becomes the audit `resourceName`, where an invisible character (a bidi
	// override, a zero-width space) would make it read as something it is
	// not. NUL is a control character, so this refuses it too.
	if (hasControlOrFormatCharacter(title)) {
		throw badRequest(
			"title contains a control character or an invisible format character (zero-width, bidi override, byte-order mark)",
		);
	}

	let expectedContentHash: string | undefined;
	if (input.expectedContentHash) {
		expectedContentHash = input.expectedContentHash.toLowerCase();
		if (!SHA256_HEX.test(expectedContentHash)) {
			throw badRequest(
				"expectedContentHash must be the 64-character sha256 hex 'contentHash' of the stored version",
			);
		}
	}

	return {
		sourcePath,
		title,
		expectedContentHash,
		movedFromSourcePath,
		bytes: Buffer.byteLength(input.content, "utf8"),
	};
}

/**
 * The title a stored row is shown under: `metadata.title`, else its file name.
 * `activities/synced-context-deletion.ts` in `@repo/temporal`, which cannot
 * import this package, applies the same rule; change the two together.
 */
function storedSyncedContextTitle(
	context: SyncedContextRow,
	sourcePath: string,
): string {
	const metadata = context.metadata;
	const title =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as { title?: unknown }).title
			: undefined;
	return typeof title === "string" && title.trim()
		? title
		: basename(sourcePath);
}

/**
 * Who last changed a conflicting version, by id and display name. Shared with
 * `delete-synced-context.ts`.
 */
export async function resolveSyncedContextEditor(
	userId: string | null,
): Promise<SyncedContextConflict["contentUpdatedBy"]> {
	if (!userId) {
		return null;
	}
	const user = await db.user.findUnique({
		where: { id: userId },
		select: { id: true, name: true },
	});
	return { id: userId, name: user?.name ?? null };
}

/**
 * Start the embedding for a row this call just created or replaced. Fire and
 * forget, exactly as `create-context.ts` does: a Temporal outage must never
 * turn into a lost write, so the failure is logged and the row stays with
 * `embeddedAt` null, where `projects.contexts.embed` (which picks up
 * unembedded rows) finds it. Re-pushing the same content will not: it is
 * `unchanged` and starts nothing.
 *
 * The body is NOT passed: up to 2 MiB would exceed Temporal's payload limit,
 * and the activity reads it back from the row. Reading at run time is not
 * enough on its own to index the latest version: two replaces in quick
 * succession start two workflows, and the one that read the older version
 * can finish last. So a re-embed reads the row's `contentHash` with its
 * content, re-reads the hash once the embed is done, and embeds again (delete
 * first) while it has moved, a bounded number of times before failing for
 * Temporal to retry; it marks `embeddedAt` only for the version it embedded.
 * See `embedSingleContextActivity` in `@repo/temporal`.
 *
 * `syncedContextDeletionWorkflow` starts the same workflow, with the same
 * input shape, for a row whose points it removed before losing the delete to
 * a concurrent change; change the two together. The start itself is
 * `startContextEmbeddingWorkflow` (`@repo/temporal/context-embedding-start`),
 * which the Living Memory repository sync's index step shares.
 */
function startSyncedContextEmbedding(params: {
	context: SyncedContextRow;
	projectId: string;
	userId: string;
	organizationId: string;
	sourcePath: string;
	title: string;
	reembed: boolean;
}): void {
	const { context, projectId, userId, organizationId, sourcePath, title } =
		params;
	(async () => {
		try {
			const client = await getTemporalClient();
			// The id scheme, queue and input live in `@repo/temporal`, shared
			// with the Living Memory repository sync's index step.
			const { workflowId } = await startContextEmbeddingWorkflow(
				client,
				{
					contextId: context.id,
					projectId,
					userId,
					organizationId,
					sourcePath,
					title,
					reembed: params.reembed,
				},
				{ decorateStartOptions: withCorrelationMemo },
			);

			logger.info(
				`[UpsertSyncedContext] Started context embedding workflow ${workflowId}`,
			);
		} catch (error) {
			logger.error(
				`[UpsertSyncedContext] Failed to start context embedding workflow for ${context.id}: ${error}`,
			);
		}
	})();
}

export async function upsertSyncedContext(
	input: UpsertSyncedContextInput,
): Promise<UpsertSyncedContextResult> {
	const {
		sourcePath,
		title,
		expectedContentHash,
		movedFromSourcePath,
		bytes,
	} = validate(input);

	// ADR-018: an organization is the only tenant context. A project with no
	// hosting organization means something upstream failed to resolve one;
	// a new feature does not write into the fail-closed personal arm.
	const organizationId = input.organizationId;
	if (!organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Synced context files require an organization project",
		});
	}

	const contentHash = hashContextContent(input.content);
	const result = await upsertContextBySourcePath({
		projectId: input.projectId,
		sourcePath,
		content: input.content,
		title,
		expectedContentHash,
		...(movedFromSourcePath ? { movedFromSourcePath } : {}),
		userId: input.userId,
		organizationId,
	});

	// Why a requested move was not applied, passed on with every answer
	// that carries it, so a client knows whether the old path still has a
	// row (only `source-missing` says it does not).
	const moveNotApplied =
		result.status !== "moved" &&
		result.status !== "updated" &&
		result.moveNotApplied
			? { moveNotApplied: result.moveNotApplied }
			: {};

	if (result.status === "repository-managed") {
		// A Living Memory repository sync authored the row at this path (or
		// at the move's source): nothing was written, and the repository is
		// where it changes (design 2026-09-23 §6).
		throw repositoryManagedError(
			result.context.sourcePath ?? sourcePath,
			result.sync,
		);
	}

	if (result.status === "duplicate") {
		return {
			status: "duplicate",
			contextId: result.existing.id,
			sourcePath,
			contentHash,
			duplicateOfContextId: result.existing.id,
			duplicateOfSourcePath: result.existing.sourcePath,
			...moveNotApplied,
		};
	}

	if (result.status === "conflict") {
		const { current } = result;
		if (current === null) {
			return {
				status: "conflict",
				contextId: null,
				sourcePath,
				contentHash,
				current: null,
				...moveNotApplied,
			};
		}
		return {
			status: "conflict",
			contextId: current.contextId,
			sourcePath,
			contentHash,
			current: {
				contextId: current.contextId,
				contentHash: current.contentHash,
				contentUpdatedAt: current.contentUpdatedAt,
				contentUpdatedBy: await resolveSyncedContextEditor(
					current.contentUpdatedByUserId,
				),
			},
			...moveNotApplied,
		};
	}

	const { context } = result;
	if (result.status === "unchanged") {
		return {
			status: "unchanged",
			contextId: context.id,
			sourcePath,
			contentHash,
			...moveNotApplied,
		};
	}

	// A rename keeps the title the row already had (the database took the
	// new file name as its title if its title was the old file name); the
	// index and the ledger are told that one, not this call's default.
	const writtenTitle =
		result.status === "moved"
			? storedSyncedContextTitle(context, sourcePath)
			: title;

	// created, updated or moved: a write happened, and only now do the side
	// effects. A move re-embeds as a replace does: the points carry the path
	// (as `filename`, which chunking and enrichment also read) and the title
	// (`sourceTitle`) — `storeProjectContext` in `@repo/rag` — so leaving them
	// would answer searches under the old name.
	startSyncedContextEmbedding({
		context,
		projectId: input.projectId,
		userId: input.userId,
		organizationId,
		sourcePath,
		title: writtenTitle,
		// Every synced write, a create included, takes the hash-guarded
		// re-embed pass. A create's workflow reads the row when it runs, so a
		// replace that lands first would otherwise be overwritten in the
		// index by the older version and the row still marked as embedded;
		// the guarded pass re-reads the hash after embedding and repeats.
		// On a new row the strict delete finds nothing and costs one call.
		reembed: true,
	});

	recordAuditFromRequest(
		input.request,
		buildContextContentAuditEvent({
			organizationId,
			projectId: input.projectId,
			contextId: context.id,
			title: writtenTitle,
			outcome: result.status,
			sourcePath,
			contentHash,
			bytes,
			previousContentHash:
				result.status === "updated" ? result.previousHash : undefined,
			previousSourcePath:
				result.status === "moved"
					? result.movedFromSourcePath
					: undefined,
			via: input.via,
		}),
	);

	// Refreshes an open Context tab. `emitContextChange` swallows its own
	// delivery failures.
	await emitContextChange({
		projectId: input.projectId,
		contextId: context.id,
		action: result.status === "created" ? "added" : "updated",
		userId: input.userId,
		userName: input.request.user?.name || "Anonymous",
		contextType: context.type,
		contextName: writtenTitle,
	});

	if (result.status === "moved") {
		return {
			status: "moved",
			contextId: context.id,
			sourcePath,
			contentHash,
			movedFromSourcePath: result.movedFromSourcePath,
		};
	}
	return {
		status: result.status,
		contextId: context.id,
		sourcePath,
		contentHash,
		...moveNotApplied,
	};
}
