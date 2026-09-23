/**
 * The audit row of a synced knowledge file's deletion by path (Fizzy #2636):
 * the durable receipt of `fabric context push --prune`'s compare-and-set
 * delete.
 *
 * `deleteClaimedSyncedContextRow` (`contexts.ts`) inserts it with
 * `recordAuditTx` in the SAME transaction as the row delete, so the row is
 * never gone without it, and a repeat of the delete recognises its own
 * committed attempt by `metadata.operationId`. It is built here, in the
 * database package, because the delete runs in a Temporal activity, which
 * cannot import `@repo/api`; the upsert's row
 * (`packages/api/modules/projects/lib/context-content-audit.ts`) is built by
 * the API, which writes it request-side. Keep the two metadata shapes alike:
 * the path, the hash, the surface — never the content.
 *
 * Pure: no I/O.
 */

import type { RecordAuditInput } from "../audit-log";

/**
 * Where a synced-file write came from: the app's own oRPC procedure, the MCP
 * gateway tool, or the public v1 REST route an API key reaches (`fabric
 * context push`). Recorded as the audit row's `metadata.via`.
 */
export type SyncedContextSurface = "web" | "mcp-gateway" | "v1-api";

/**
 * A synced file's deletion by path. Its own action rather than an outcome of
 * `project.context_source.content_upserted`: a filter for "who removed text
 * the AI could read" must not have to know that one outcome of an upsert is a
 * delete.
 */
export const SYNCED_CONTEXT_DELETE_AUDIT_ACTION =
	"project.context_source.synced_file_deleted" as const;

/**
 * The request a deletion came from, as its audit row records it: what
 * `recordAuditFromRequest` (`packages/api/lib/audit.ts`) derives from a
 * request, reduced to plain values. It rides in the deletion workflow's
 * input, which Temporal persists in history, so it never carries headers,
 * cookies or tokens. `sessionId` is the session row's id, not its token.
 */
export interface SyncedContextDeletionAuditContext {
	via: SyncedContextSurface;
	impersonatedById: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	requestId: string | null;
	sessionId: string | null;
	correlationId: string | null;
}

/**
 * Build the audit input for a synced file deleted by its path — only ever the
 * version the caller named, whose hash is recorded with the path, and the
 * operation that deleted it. Never the content. Call it ONLY for a delete
 * that happened: `absent` and `conflict` deleted nothing and record nothing.
 *
 * The actor is the human the request acted as. `actor.userId` is null only
 * when that user's row no longer exists by the time the delete commits (an
 * audit row cannot reference a missing user, and refusing the delete for it
 * would fail every retry); `emailSnapshot` and `nameSnapshot` are read from
 * the user row at write time.
 */
export function buildSyncedContextDeleteAuditEvent(params: {
	organizationId: string | null | undefined;
	projectId: string;
	contextId: string;
	title: string;
	sourcePath: string;
	contentHash: string;
	/** The delete's operation id (its workflow id): the receipt's key. */
	operationId: string;
	actor: {
		userId: string | null;
		emailSnapshot: string | null;
		nameSnapshot: string | null;
	};
	audit: SyncedContextDeletionAuditContext;
}): RecordAuditInput {
	const { audit } = params;
	return {
		action: SYNCED_CONTEXT_DELETE_AUDIT_ACTION,
		category: "project",
		organizationId: params.organizationId ?? null,
		projectId: params.projectId,
		actor: {
			type: "user",
			userId: params.actor.userId,
			emailSnapshot: params.actor.emailSnapshot,
			nameSnapshot: params.actor.nameSnapshot,
			impersonatedById: audit.impersonatedById,
		},
		resource: {
			type: "project_context",
			id: params.contextId,
			name: params.title,
		},
		metadata: {
			sourcePath: params.sourcePath,
			contentHash: params.contentHash,
			via: audit.via,
			operationId: params.operationId,
		},
		ipAddress: audit.ipAddress,
		userAgent: audit.userAgent,
		requestId: audit.requestId,
		sessionId: audit.sessionId,
		correlationId: audit.correlationId,
	};
}
