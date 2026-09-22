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
 * Pure: no I/O, no Prisma. The caller sends the result through
 * `recordAuditFromRequest`, whose `recordAudit` runs the shared sensitive-key
 * redactor over `metadata` unconditionally before insert.
 */

import type { RecordAuditFromRequestInput } from "../../../lib/audit";

export const CONTEXT_CONTENT_AUDIT_ACTION =
	"project.context_source.content_upserted" as const;

/**
 * Where the push came from: the app's own oRPC procedure, the MCP gateway
 * tool, or the public v1 REST route an API key reaches (`fabric context
 * push`).
 */
export type SyncedContextSurface = "web" | "mcp-gateway" | "v1-api";

/**
 * Build the audit input for one synced-file write that happened. Call it ONLY
 * for `created` and `updated`: an unchanged push, a duplicate and a conflict
 * wrote nothing and record nothing.
 *
 * The metadata identifies the write — the path, the hash now stored, the
 * size, and on a replace the hash it replaced — and never carries the content:
 * the ledger is append-only and outlives any later deletion of the source, and
 * the file is user research material. The hashes are enough to prove which
 * version replaced which.
 */
export function buildContextContentAuditEvent(params: {
	organizationId: string | null | undefined;
	projectId: string;
	contextId: string;
	title: string;
	outcome: "created" | "updated";
	sourcePath: string;
	contentHash: string;
	bytes: number;
	/** The hash the write replaced. Required for, and only for, `updated`. */
	previousContentHash?: string;
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
			contentHash,
			bytes,
			...(outcome === "updated" && previousContentHash
				? { previousContentHash }
				: {}),
			via,
		},
	};
}
