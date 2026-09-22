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
 *    reported as a duplicate instead of being stored twice.
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
	type SyncedContextRow,
	upsertContextBySourcePath,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
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
import { MAX_SYNCED_CONTEXT_BYTES } from "./synced-context-limits";

/** Upper bound on a caller-supplied title. */
export const MAX_SYNCED_CONTEXT_TITLE_LENGTH = 255;

const SHA256_HEX = /^[0-9a-f]{64}$/;
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
	 */
	expectedContentHash?: string | null;
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
interface SyncedContextConflict {
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

export type UpsertSyncedContextResult =
	| (SyncedContextOutcomeBase & {
			status: "created" | "updated" | "unchanged";
	  })
	| (SyncedContextOutcomeBase & {
			status: "duplicate";
			duplicateOfContextId: string;
			duplicateOfSourcePath: string | null;
	  })
	| (Omit<SyncedContextOutcomeBase, "contextId"> & {
			status: "conflict";
			/** The row the push lost to; `null` when the path has none. */
			contextId: string | null;
			/**
			 * The stored version, or `null` when the caller named a hash and
			 * the path no longer holds a row: it was deleted since.
			 */
			current: SyncedContextConflict | null;
	  });

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
		bytes: Buffer.byteLength(input.content, "utf8"),
	};
}

async function resolveEditor(
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
 */
function startEmbedding(params: {
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
			const workflowId = `context-embedding-${context.id}-${Date.now()}`;

			await client.workflow.start(
				"contextEmbeddingWorkflow",
				withCorrelationMemo({
					taskQueue: "project-documents",
					workflowId,
					args: [
						{
							contextId: context.id,
							projectId,
							userId,
							organizationId,
							type: "TEXT",
							metadata: {
								// The path as the filename, so chunking sees the
								// extension (markdown, an OpenAPI document, code).
								filename: sourcePath,
								sourceTitle: title,
								sourcePath,
							},
							// The hash-guarded pass: delete the row's old chunks,
							// embed, then re-read the hash and repeat if a later
							// push moved it (see `reembedStoredVersion`).
							...(params.reembed ? { reembed: true } : {}),
						},
					],
				}),
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
	const { sourcePath, title, expectedContentHash, bytes } = validate(input);

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
		userId: input.userId,
		organizationId,
	});

	if (result.status === "duplicate") {
		return {
			status: "duplicate",
			contextId: result.existing.id,
			sourcePath,
			contentHash,
			duplicateOfContextId: result.existing.id,
			duplicateOfSourcePath: result.existing.sourcePath,
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
				contentUpdatedBy: await resolveEditor(
					current.contentUpdatedByUserId,
				),
			},
		};
	}

	const { context } = result;
	if (result.status === "unchanged") {
		return {
			status: "unchanged",
			contextId: context.id,
			sourcePath,
			contentHash,
		};
	}

	// created or updated: a write happened, and only now do the side effects.
	startEmbedding({
		context,
		projectId: input.projectId,
		userId: input.userId,
		organizationId,
		sourcePath,
		title,
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
			title,
			outcome: result.status,
			sourcePath,
			contentHash,
			bytes,
			previousContentHash:
				result.status === "updated" ? result.previousHash : undefined,
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
		contextName: title,
	});

	return {
		status: result.status,
		contextId: context.id,
		sourcePath,
		contentHash,
	};
}
