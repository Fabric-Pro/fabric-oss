/**
 * The audit row for a synced knowledge file's content write (Fizzy #2616).
 *
 * Three surfaces push a file into a project's Context by its path: the oRPC
 * procedure `projects.contexts.upsertSyncedFile`, the
 * `fabric_upsert_project_context` MCP tool, and the v1 REST route
 * `PUT /api/v1/projects/:projectId/contexts/synced-files`. All go through
 * `upsertSyncedContext`, which records this row, built here, so they cannot
 * drift on what the ledger says — the sibling of `context-metadata-audit.ts`
 * for the content half of a context row.
 *
 * A synced file's deletion by path (Fizzy #2636) is recorded by the deletion
 * workflow, in the row delete's own transaction, so its row is built in the
 * database package: `buildSyncedContextDeleteAuditEvent` in
 * `packages/database/prisma/queries/projects/synced-context-delete-audit.ts`.
 * Keep the two metadata shapes alike — the path, the hash, `via`, never the
 * content — and change them together.
 *
 * Pure: no I/O, no Prisma. The caller sends the result through
 * `recordAuditFromRequest`, whose `recordAudit` runs the shared sensitive-key
 * redactor over `metadata` unconditionally before insert.
 */

import type { SyncedContextSurface } from "@repo/database";
import type { RecordAuditFromRequestInput } from "../../../lib/audit";

/**
 * Where the push came from: the app's own oRPC procedure, the MCP gateway
 * tool, or the public v1 REST route an API key reaches (`fabric context
 * push`). Defined with the delete's audit row in `@repo/database`, which
 * records it too.
 */
export type { SyncedContextSurface };

export const CONTEXT_CONTENT_AUDIT_ACTION =
	"project.context_source.content_upserted" as const;

/**
 * Build the audit input for one synced-file write that happened. Call it ONLY
 * for `created`, `updated` and `moved`: an unchanged push, a duplicate and a
 * conflict wrote nothing and record nothing.
 *
 * The metadata identifies the write — the path, the hash now stored, the
 * size, on a replace the hash it replaced, and on a move (Fizzy #2636) the
 * path it moved from — and never carries the content: the ledger is
 * append-only and outlives any later deletion of the source, and the file is
 * user research material. The hashes are enough to prove which version
 * replaced which.
 */
export function buildContextContentAuditEvent(params: {
	organizationId: string | null | undefined;
	projectId: string;
	contextId: string;
	title: string;
	outcome: "created" | "updated" | "moved";
	sourcePath: string;
	contentHash: string;
	bytes: number;
	/** The hash the write replaced. Required for, and only for, `updated`. */
	previousContentHash?: string;
	/** The path the file moved from. Required for, and only for, `moved`. */
	previousSourcePath?: string;
	via: SyncedContextSurface;
}): RecordAuditFromRequestInput {
	const {
		organizationId,
		projectId,
		contextId,
		title,
		outcome,
		sourcePath,
		contentHash,
		bytes,
		previousContentHash,
		previousSourcePath,
		via,
	} = params;
	return {
		action: CONTEXT_CONTENT_AUDIT_ACTION,
		category: "project",
		organizationId: organizationId ?? null,
		projectId,
		resource: {
			type: "project_context",
			id: contextId,
			name: title,
		},
		metadata: {
			outcome,
			sourcePath,
			...(outcome === "moved" && previousSourcePath
				? { previousSourcePath }
				: {}),
			contentHash,
			bytes,
			...(outcome === "updated" && previousContentHash
				? { previousContentHash }
				: {}),
			via,
		},
	};
}
