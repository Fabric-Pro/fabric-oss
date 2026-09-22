/**
 * The audit row for a context source's metadata edit — its type label and AI
 * instructions (Fizzy #1888).
 *
 * Two surfaces make that edit: the Context tab's source-details dialog, through
 * `projects.contexts.updateMetadata`, and the `fabric_update_project_context`
 * MCP tool. Both record the SAME row, built here, so an operator reading the
 * ledger cannot tell them apart except by `metadata.via`. Two hand-written
 * copies would drift on exactly the fields a reviewer compares.
 *
 * Pure: no I/O, no Prisma — the types below are erased at compile time — so the
 * MCP gateway can import it statically without pulling the database client into
 * its module scope. The caller sends the result through
 * `recordAuditFromRequest`, whose `recordAudit` runs the shared sensitive-key
 * redactor over `metadata` unconditionally before insert.
 */

import type {
	ContextMetadataField,
	ContextMetadataValues,
} from "@repo/database";
import type { RecordAuditFromRequestInput } from "../../../lib/audit";

export const CONTEXT_METADATA_AUDIT_ACTION =
	"project.context_source.metadata_updated" as const;

/** Where the edit came from. */
export type ContextMetadataEditSurface = "web" | "mcp-gateway";

/** The title fields of a context row — never its body. */
export interface ContextAuditNameFields {
	type: string;
	sourceTitle?: string | null;
	originalFilename?: string | null;
	metadata?: unknown;
}

/**
 * The context's human-readable label for `resourceName`. Built from title
 * columns and title-shaped metadata keys only: the row's `content` is user
 * research material and never belongs in the ledger, which is append-only and
 * outlives any later deletion of the source.
 */
export function contextAuditResourceName(ctx: ContextAuditNameFields): string {
	if (ctx.sourceTitle) {
		return ctx.sourceTitle;
	}
	const meta =
		ctx.metadata &&
		typeof ctx.metadata === "object" &&
		!Array.isArray(ctx.metadata)
			? (ctx.metadata as Record<string, unknown>)
			: {};
	for (const key of ["title", "chatTopic", "sourceTitle"]) {
		const value = meta[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return ctx.originalFilename || `${ctx.type} context`;
}

/**
 * Build the audit input for one successful metadata write. Call it ONLY when
 * the write happened — a stale compare-and-swap or a no-op save changed
 * nothing and records nothing.
 *
 * `before` and `after` carry both fields in full. They are short, bounded
 * user text (an 80-character label, 500 characters of instructions), and a
 * before/after pair is what answers "who changed what the AI is told about
 * this source" — the question this row exists for.
 */
export function buildContextMetadataAuditEvent(params: {
	organizationId: string | null | undefined;
	projectId: string;
	context: ContextAuditNameFields & { id: string };
	before: ContextMetadataValues;
	after: ContextMetadataValues;
	changed: ContextMetadataField[];
	via: ContextMetadataEditSurface;
}): RecordAuditFromRequestInput {
	const { organizationId, projectId, context, before, after, changed, via } =
		params;
	return {
		action: CONTEXT_METADATA_AUDIT_ACTION,
		category: "project",
		organizationId: organizationId ?? null,
		projectId,
		resource: {
			type: "project_context",
			id: context.id,
			name: contextAuditResourceName(context),
		},
		metadata: {
			changed,
			before: {
				sourceType: before.sourceType,
				aiInstructions: before.aiInstructions,
			},
			after: {
				sourceType: after.sourceType,
				aiInstructions: after.aiInstructions,
			},
			via,
		},
	};
}
