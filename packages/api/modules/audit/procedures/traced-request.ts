/**
 * `audit.tracedRequest` — interleaved view of audit rows + low-level
 * spans for a single correlation ID.
 *
 * v2 item 4: exposes the `RequestSpan` rows captured on failure
 * alongside the matching `AuditLog` rows so the trace viewer can show
 * everything that happened during a single request flow.
 *
 * Authorization: same `audit_log:read` gate as `audit.list`. Scope is
 * resolved with the existing helper so personal vs org callers see only
 * their own rows.
 *
 * Performance:
 *   - Both queries are indexed (audit_log has multiple createdAt
 *     indexes; request_span has a `(correlationId, startedAt)` index).
 *   - We cap at 200 audit rows + 1000 spans to keep the payload small.
 *     If a request emits more, we surface the truncation through a
 *     metadata flag (`truncated: true`).
 *
 * Spec: docs/audit-log/README.md
 * §8.7 (request-span trace capture — added in v2).
 */

import { db, listAuditLog } from "@repo/database";
import { z } from "zod";
import { requireAuditLogReadOrDeploymentAdmin } from "../../../orpc/middleware/require-audit-log-read";
import { protectedProcedure } from "../../../orpc/procedures";
import { auditLogItemSchema } from "../lib/schemas";
import { resolveAuditLogScope } from "../lib/scope";

const SPAN_LIMIT = 1_000;
const AUDIT_LIMIT = 200;

const auditTracedRequestInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	correlationId: z.string().min(1).max(256),
});

const traceSpanSchema = z.object({
	id: z.string(),
	correlationId: z.string(),
	organizationId: z.string().nullable(),
	userId: z.string().nullable(),
	kind: z.enum([
		"db",
		"temporal_workflow",
		"temporal_activity",
		"http_outbound",
		"other",
	]),
	name: z.string(),
	startedAt: z.coerce.date(),
	durationMs: z.number().int().nullable(),
	status: z.string(),
	errorMessage: z.string().nullable(),
	attributes: z.unknown().nullable(),
	createdAt: z.coerce.date(),
});

const auditTracedRequestOutputSchema = z.object({
	items: z.array(auditLogItemSchema),
	spans: z.array(traceSpanSchema),
	truncated: z.boolean(),
});

export const getAuditTracedRequestProcedure = protectedProcedure
	.input(auditTracedRequestInputSchema)
	.use(requireAuditLogReadOrDeploymentAdmin())
	.route({
		method: "POST",
		path: "/audit/traced-request",
		tags: ["Audit"],
		summary: "Audit rows + low-level spans for a single correlation ID",
		description:
			"Returns the audit-log rows AND any low-level spans (db / temporal / http) captured for a single request flow. Spans are only persisted on failure (tail-sampled).",
	})
	.output(auditTracedRequestOutputSchema)
	.handler(async ({ input, context }) => {
		const scope = resolveAuditLogScope(context, input.organizationId);

		// Pull audit rows + spans in parallel.
		const [auditResult, spanRows] = await Promise.all([
			listAuditLog({
				scope,
				filter: { correlationId: input.correlationId },
				cursor: null,
				limit: AUDIT_LIMIT,
				sort: "oldest",
			}),
			db.requestSpan.findMany({
				where: {
					correlationId: input.correlationId,
					// Tenant-scope the span read the same way the audit
					// list helper does. The XOR is enforced explicitly so
					// a cross-tenant correlationId (e.g. forwarded
					// request) cannot leak spans across orgs.
					...(scope.organizationId
						? { organizationId: scope.organizationId }
						: { organizationId: null, userId: scope.userId }),
				},
				orderBy: [{ startedAt: "asc" }, { id: "asc" }],
				take: SPAN_LIMIT,
			}),
		]);

		const truncated =
			auditResult.items.length >= AUDIT_LIMIT ||
			spanRows.length >= SPAN_LIMIT;

		return {
			items: auditResult.items,
			spans: spanRows.map((r) => ({
				id: r.id,
				correlationId: r.correlationId,
				organizationId: r.organizationId,
				userId: r.userId,
				// We declare the enum in zod so a row with an unexpected
				// `kind` (e.g. an older instrumentor) falls back to "other"
				// rather than failing validation.
				kind: (
					[
						"db",
						"temporal_workflow",
						"temporal_activity",
						"http_outbound",
						"other",
					] as const
				).includes(r.kind as never)
					? (r.kind as
							| "db"
							| "temporal_workflow"
							| "temporal_activity"
							| "http_outbound"
							| "other")
					: ("other" as const),
				name: r.name,
				startedAt: r.startedAt,
				durationMs: r.durationMs,
				status: r.status,
				errorMessage: r.errorMessage,
				attributes: r.attributes,
				createdAt: r.createdAt,
			})),
			truncated,
		};
	});
