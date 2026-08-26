/**
 * `audit.export` — CSV / NDJSON export of audit-log events.
 *
 * Hard cap 50,000 rows per export (D7). Beyond that the procedure
 * rejects with `BAD_REQUEST` telling the user to refine filters; v1
 * does not stream async export jobs. The response carries the full
 * payload as a string in JSON because the project does not have a
 * streaming-response primitive in oRPC yet — the client converts the
 * body to a Blob and triggers the download.
 *
 * Authorization: `protectedProcedure` + `requireAuditLogExportOrDeploymentAdmin`.
 *
 * Emits one `audit.exported` event per successful call (D12). The event
 * is written BEFORE the body is returned so a mid-flight client
 * disconnect still leaves a record of the attempt.
 *
 * Spec: docs/audit-log/README.md §6.2.
 */

import { ORPCError } from "@orpc/server";
import {
	AUDIT_EXPORT_ROW_CAP,
	countAuditLog,
	fetchAuditLogForExport,
} from "@repo/database";
import { recordAuditFromRequest } from "../../../lib/audit";
import { requireAuditLogExportOrDeploymentAdmin } from "../../../orpc/middleware/require-audit-log-read";
import { protectedProcedure } from "../../../orpc/procedures";
import {
	exportContentType,
	exportFilename,
	serializeAuditLogToCsv,
	serializeAuditLogToNdjson,
} from "../lib/export-format";
import {
	auditExportInputSchema,
	auditExportOutputSchema,
} from "../lib/schemas";
import { resolveAuditLogScope } from "../lib/scope";

export const exportAuditLogProcedure = protectedProcedure
	.input(auditExportInputSchema)
	.use(requireAuditLogExportOrDeploymentAdmin())
	.route({
		method: "POST",
		path: "/audit/export",
		tags: ["Audit"],
		summary: "Export audit-log events",
		description:
			"Export filtered audit-log rows as CSV or NDJSON. Capped at 50,000 rows per export.",
	})
	.output(auditExportOutputSchema)
	.handler(async ({ input, context }) => {
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

		// Pre-count to enforce the 50k cap before we materialize anything.
		const count = await countAuditLog({ scope, filter: input.filter });
		if (count > AUDIT_EXPORT_ROW_CAP) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Result set exceeds ${AUDIT_EXPORT_ROW_CAP.toLocaleString()} rows. Refine your filter or contact support for an async export.`,
			});
		}

		const rows = await fetchAuditLogForExport({
			scope,
			filter: input.filter,
		});

		const body =
			input.format === "csv"
				? serializeAuditLogToCsv(rows)
				: serializeAuditLogToNdjson(rows);

		// Emit the meta event BEFORE returning so even a mid-flight
		// client disconnect (or a transport error after this point)
		// leaves an `audit.exported` row in the ledger.
		recordAuditFromRequest(context, {
			action: "audit.exported",
			category: "audit",
			organizationId: scope.organizationId,
			projectId: input.filter.projectId ?? null,
			outcome: "success",
			severity: "info",
			metadata: {
				format: input.format,
				rowCount: rows.length,
				filters: input.filter,
			},
		});

		return {
			format: input.format,
			rowCount: rows.length,
			body,
			filename: exportFilename(input.format),
			contentType: exportContentType(input.format),
		};
	});
