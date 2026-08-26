/**
 * Audit-log export serializers.
 *
 * Two formats per D7:
 *  - CSV: 17 columns flattened (no `metadata`), ISO-8601 UTC timestamps.
 *  - NDJSON: one JSON object per line, full row INCLUDING `metadata`.
 *
 * Spec: docs/audit-log/README.md §6.2.
 */

import type { AuditLogRow } from "@repo/database";

/**
 * CSV header per spec §6.2. Order is load-bearing — analysts may script
 * against the column order.
 */
const AUDIT_EXPORT_CSV_HEADER = [
	"timestamp",
	"actor_email",
	"actor_name",
	"actor_type",
	"action",
	"category",
	"severity",
	"outcome",
	"resource_type",
	"resource_id",
	"resource_name",
	"project_id",
	"ip_address",
	"user_agent",
	"request_id",
	"session_id",
	"impersonated_by_id",
] as const;

/**
 * Escape a single field for CSV. Fields that contain `,`, `"`, `\r`, or
 * `\n` are wrapped in double-quotes; inner double-quotes are doubled per
 * RFC 4180. `null`/`undefined` become empty cells.
 */
function csvEscape(value: string | null | undefined): string {
	if (value === null || typeof value === "undefined") {
		return "";
	}
	const str = String(value);
	if (/[",\r\n]/.test(str)) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

function rowToCsv(row: AuditLogRow): string {
	return [
		row.createdAt.toISOString(),
		row.actorEmailSnapshot,
		row.actorNameSnapshot,
		row.actorType,
		row.action,
		row.category,
		row.severity,
		row.outcome,
		row.resourceType,
		row.resourceId,
		row.resourceName,
		row.projectId,
		row.ipAddress,
		row.userAgent,
		row.requestId,
		row.sessionId,
		row.impersonatedById,
	]
		.map(csvEscape)
		.join(",");
}

/**
 * Serialize an array of rows to a CSV string. Empty input still emits
 * the header row so an analyst gets a valid file rather than an error.
 */
export function serializeAuditLogToCsv(rows: AuditLogRow[]): string {
	const headerLine = AUDIT_EXPORT_CSV_HEADER.join(",");
	if (rows.length === 0) {
		return `${headerLine}\n`;
	}
	const body = rows.map(rowToCsv).join("\n");
	return `${headerLine}\n${body}\n`;
}

/**
 * Serialize an array of rows to NDJSON. One JSON object per line, full
 * row including `metadata`. Timestamps emitted as ISO-8601 UTC strings.
 */
export function serializeAuditLogToNdjson(rows: AuditLogRow[]): string {
	if (rows.length === 0) {
		return "";
	}
	return rows
		.map((row) =>
			JSON.stringify({
				...row,
				createdAt: row.createdAt.toISOString(),
			}),
		)
		.join("\n")
		.concat("\n");
}

export function exportContentType(format: "csv" | "ndjson"): string {
	return format === "csv" ? "text/csv" : "application/x-ndjson";
}

export function exportFilename(format: "csv" | "ndjson"): string {
	const stamp = new Date().toISOString().replace(/[:]/g, "-");
	const ext = format === "csv" ? "csv" : "ndjson";
	return `audit-log-${stamp}.${ext}`;
}
