/**
 * `audit.list` — paginated audit-log read.
 *
 * Cursor pagination by `(createdAt DESC, id DESC)`, default limit 50,
 * server-side cap 200. Tenant isolation per AGENTS.md XOR pattern.
 *
 * Authorization: `protectedProcedure` + `requireAuditLogReadOrDeploymentAdmin`.
 * The middleware enforces:
 *   - personal context pass-through (the procedure scopes to userId)
 *   - org admin / owner role permission via `ORG_AUDIT_LOG_READ`
 *   - env-list deployment admin bypass for SRE escape hatch
 *
 * Emits one `audit.viewed` event per successful call (D12). The meta
 * event is fire-and-forget — a failure to record it must never fail the
 * read for the user.
 *
 * Spec: docs/audit-log/README.md §6.1.
 */

import { ORPCError } from "@orpc/server";
import { listAuditLog } from "@repo/database";
import { recordAuditFromRequest } from "../../../lib/audit";
import { requireAuditLogReadOrDeploymentAdmin } from "../../../orpc/middleware/require-audit-log-read";
import { protectedProcedure } from "../../../orpc/procedures";
import { auditListInputSchema, auditListOutputSchema } from "../lib/schemas";
import { resolveAuditLogScope } from "../lib/scope";

/**
 * Truncate the JSON serialization of an arbitrary value to a UTF-8 byte
 * cap. The 4 KB cap (D12) protects against runaway filter payloads
 * flooding the meta-event metadata column.
 */
function truncateForMeta(value: unknown, maxBytes = 4096): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value ?? {});
	} catch {
		serialized = "{}";
	}
	if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
		return serialized;
	}
	// Drop bytes from the end and re-append an ellipsis marker. We
	// truncate by characters (not bytes) to stay safe with multi-byte
	// glyphs; the resulting string may be a few bytes shorter than the
	// cap which is fine.
	let truncated = serialized.slice(0, maxBytes);
	while (Buffer.byteLength(`${truncated}…`, "utf8") > maxBytes) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}…`;
}

export const listAuditLogProcedure = protectedProcedure
	.input(auditListInputSchema)
	.use(requireAuditLogReadOrDeploymentAdmin())
	.route({
		method: "POST",
		path: "/audit/list",
		tags: ["Audit"],
		summary: "List audit-log events",
		description:
			"List audit-log events with filtering, cursor pagination, and tenant isolation.",
	})
	.output(auditListOutputSchema)
	.handler(async ({ input, context }) => {
		// dateFrom > dateTo is a 400 — fail fast before hitting the DB.
		if (
			input.filter.dateFrom &&
			input.filter.dateTo &&
			input.filter.dateFrom > input.filter.dateTo
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "dateFrom must be less than or equal to dateTo",
			});
		}

		const scope = resolveAuditLogScope(context, input.organizationId);

		let result: Awaited<ReturnType<typeof listAuditLog>>;
		try {
			result = await listAuditLog({
				scope,
				filter: input.filter,
				cursor: input.cursor ?? null,
				limit: input.limit,
				sort: input.sort,
			});
		} catch (err) {
			if (err instanceof Error && err.message === "Invalid cursor") {
				throw new ORPCError("BAD_REQUEST", {
					message: "Invalid cursor",
				});
			}
			throw err;
		}

		// Emit the meta-event AFTER a successful read. Per D12 — once
		// per request, not once per row. Fire-and-forget so a failure
		// in the meta-write never breaks the read.
		recordAuditFromRequest(context, {
			action: "audit.viewed",
			category: "audit",
			organizationId: scope.organizationId,
			projectId: input.filter.projectId ?? null,
			outcome: "success",
			severity: "info",
			metadata: {
				filters: truncateForMeta(input.filter),
				resultCount: result.items.length,
			},
		});

		return result;
	});
