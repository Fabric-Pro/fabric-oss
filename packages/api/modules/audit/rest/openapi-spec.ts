/**
 * OpenAPI 3.1 spec for the public audit-log REST API.
 *
 * Hand-authored (rather than generated from Zod) for two reasons:
 *
 *  1. The procedures live on the oRPC router and use Zod schemas, but the
 *     REST surface is a parallel Hono route that does its own query-param
 *     parsing. Auto-generating from the oRPC schemas would describe a
 *     POST/JSON body shape that the REST endpoint doesn't accept.
 *
 *  2. Operators rarely want the full oRPC field firehose for an external
 *     integration. The curated REST spec lists only what an SRE / CLI
 *     consumer actually uses: list filters, cursor, format, error codes.
 *
 * The shape returned by `getAuditLogOpenApiSpec()` is a plain JSON object
 * conforming to OpenAPI 3.1.0; the docs route at `GET /api/v1/docs`
 * feeds it to Scalar's Hono adapter (already a dependency of this
 * package, see `packages/api/index.ts`).
 */

import { getBaseUrl } from "@repo/utils";

/**
 * Build the OpenAPI document for the audit-log REST API. The `servers`
 * entry uses the runtime base URL so the spec works whether the
 * deployment is at `https://fabric.pro`, `https://staging.fabric.pro`, or
 * `http://localhost:3001`.
 */
export function getAuditLogOpenApiSpec(
	/**
	 * Origin the spec should advertise as its server, normally the origin of the
	 * request being served.
	 *
	 * Passing it in matters for self-hosted deployments: `getBaseUrl()` falls
	 * through to `http://localhost:${PORT ?? 3000}` when neither
	 * NEXT_PUBLIC_SITE_URL nor APP_URL is set and the deploy is not on Vercel, so
	 * the docs page would hand visitors curl examples pointed at their own laptop
	 * on a port this app does not even use by default.
	 */
	requestOrigin?: string,
): Record<string, unknown> {
	const baseUrl = requestOrigin ?? getBaseUrl();
	return {
		openapi: "3.1.0",
		info: {
			title: "Fabric Audit Log API",
			version: "1.0.0",
			description: [
				"Public REST API for reading and exporting Fabric audit-log",
				"events. Authenticated via API keys created from the audit-",
				"log settings page in the Fabric app.",
				"",
				"### Authentication",
				"All endpoints require `Authorization: Bearer <api_key>`.",
				"Keys start with `fab_` (personal) or `org_` (organization).",
				"",
				"### Tenant resolution",
				"The audit rows returned are scoped to the key's owning",
				"tenant — personal keys read the key owner's personal trail,",
				"org keys read the org-wide trail. Cross-tenant access is",
				"not possible.",
				"",
				"### Rate limit",
				"600 requests per minute per API key (`auditExternal`",
				"preset). Limit headers (`X-RateLimit-Limit`,",
				"`X-RateLimit-Remaining`, `X-RateLimit-Reset`) are returned",
				"on every response.",
				"",
				"### Scopes",
				"- `audit_log:read` — required for `GET /api/v1/audit-log`.",
				"- `audit_log:export` — required for `GET /api/v1/audit-log/export`.",
				"- `system_health:read` — required for `GET /api/v1/system-health`.",
				"- `status_updates:read` — required for `GET /api/v1/status-updates`.",
				"- `*` (org-key wildcard) grants all of them implicitly.",
			].join("\n"),
		},
		servers: [{ url: baseUrl, description: "Current deployment" }],
		components: {
			securitySchemes: {
				ApiKeyAuth: {
					type: "http",
					scheme: "bearer",
					description:
						"API key issued from the audit-log settings page. Format: `fab_<8hex>_<secret>` (personal) or `org_<8hex>_<secret>` (org).",
				},
			},
			schemas: {
				AuditLogItem: {
					type: "object",
					required: [
						"id",
						"actorType",
						"action",
						"category",
						"severity",
						"outcome",
						"createdAt",
					],
					properties: {
						id: { type: "string" },
						organizationId: { type: ["string", "null"] },
						userId: { type: ["string", "null"] },
						actorType: {
							type: "string",
							enum: ["user", "system", "api_key", "agent"],
						},
						actorEmailSnapshot: { type: ["string", "null"] },
						actorNameSnapshot: { type: ["string", "null"] },
						impersonatedById: { type: ["string", "null"] },
						action: { type: "string" },
						category: { type: "string" },
						severity: {
							type: "string",
							enum: ["info", "warning", "error", "critical"],
						},
						outcome: {
							type: "string",
							enum: ["success", "failure"],
						},
						resourceType: { type: ["string", "null"] },
						resourceId: { type: ["string", "null"] },
						resourceName: { type: ["string", "null"] },
						projectId: { type: ["string", "null"] },
						ipAddress: { type: ["string", "null"] },
						userAgent: { type: ["string", "null"] },
						requestId: { type: ["string", "null"] },
						sessionId: { type: ["string", "null"] },
						metadata: {
							description:
								"Redacted JSON payload (see audit-log redactor).",
						},
						durationMs: {
							type: ["integer", "null"],
							minimum: 0,
							description:
								"Procedure latency in milliseconds. Null for non-request emissions.",
						},
						createdAt: { type: "string", format: "date-time" },
					},
				},
				AuditLogListResponse: {
					type: "object",
					required: ["items", "nextCursor"],
					properties: {
						items: {
							type: "array",
							items: {
								$ref: "#/components/schemas/AuditLogItem",
							},
						},
						nextCursor: {
							type: ["string", "null"],
							description:
								"Opaque base64 cursor for the next page. Null when no more rows.",
						},
						totalCount: {
							type: "integer",
							minimum: 0,
							description: "Total rows matching the filter.",
						},
					},
				},
				ErrorResponse: {
					type: "object",
					required: ["error"],
					properties: {
						error: {
							type: "object",
							required: ["code", "message"],
							properties: {
								code: {
									type: "string",
									description:
										"Stable machine-readable error code. Use this to drive retry / fallback logic.",
									enum: [
										"MISSING_AUTHORIZATION",
										"INVALID_API_KEY_FORMAT",
										"INVALID_API_KEY",
										"API_KEY_REVOKED",
										"API_KEY_EXPIRED",
										"INSUFFICIENT_SCOPE",
										"BAD_REQUEST",
										"TOO_MANY_REQUESTS",
										"SERVICE_UNAVAILABLE",
									],
								},
								message: {
									type: "string",
									description:
										"Human-readable explanation. Safe to log; never contains secret material.",
								},
							},
						},
					},
				},
			},
		},
		security: [{ ApiKeyAuth: [] }],
		paths: {
			"/api/v1/audit-log": {
				get: {
					tags: ["Audit Log"],
					summary: "List audit-log events",
					description: [
						"Paginated read with cursor + filter. Requires `audit_log:read`.",
						"",
						"### Example",
						"```bash",
						"curl -H 'Authorization: Bearer org_abc12345_secret' \\\\",
						"     'https://fabric.pro/api/v1/audit-log?limit=50&severities=error,critical'",
						"```",
						"",
						"### Pagination",
						"The response always includes `nextCursor`. Pass it back as the `cursor`",
						"query parameter to fetch the next page. Cursor is opaque base64 — never",
						"construct one client-side. When `nextCursor` is `null` you have reached",
						"the end of the result set.",
						"",
						"### Tenant isolation",
						"Audit rows visible to the key are limited to the tenant that owns the key.",
						"There is no `organizationId` query parameter — passing one is ignored.",
						"",
						"### Scope restrictions",
						"The `audit_log:read` and `audit_log:export` scopes are exclusive to this",
						"REST surface. Keys carrying ONLY these scopes (i.e. without `mcp:*` or",
						"`agents:*`) cannot call any other endpoint. Conversely, an `mcp:read`",
						"key cannot call this endpoint without `audit_log:read` or `*`.",
					].join("\n"),
					parameters: [
						{
							in: "query",
							name: "limit",
							schema: {
								type: "integer",
								minimum: 1,
								maximum: 200,
							},
							description:
								"Rows per page. Default 50, hard cap 200.",
						},
						{
							in: "query",
							name: "cursor",
							schema: { type: "string" },
							description:
								"Opaque cursor from `nextCursor` of a previous response.",
						},
						{
							in: "query",
							name: "sort",
							schema: {
								type: "string",
								enum: ["newest", "oldest", "severity_desc"],
							},
						},
						{
							in: "query",
							name: "actions",
							schema: { type: "string" },
							description:
								"Comma-separated list of action keys (e.g. `auth.login.success,org.member.invited`).",
						},
						{
							in: "query",
							name: "categories",
							schema: { type: "string" },
							description:
								"Comma-separated category names: `auth,org,account,project,story,audit,error,incident`.",
						},
						{
							in: "query",
							name: "severities",
							schema: { type: "string" },
							description:
								"Comma-separated severities: `info,warning,error,critical`.",
						},
						{
							in: "query",
							name: "outcomes",
							schema: { type: "string" },
							description: "Comma-separated: `success,failure`.",
						},
						{
							in: "query",
							name: "actorIds",
							schema: { type: "string" },
							description: "Comma-separated user IDs.",
						},
						{
							in: "query",
							name: "actorTypes",
							schema: { type: "string" },
							description:
								"Comma-separated actor types: user, api_key, system, agent.",
						},
						{
							in: "query",
							name: "projectId",
							schema: { type: "string" },
						},
						{
							in: "query",
							name: "correlationId",
							schema: { type: "string", maxLength: 256 },
							description:
								"Exact-match filter on `metadata.correlationId`.",
						},
						{
							in: "query",
							name: "ipAddressContains",
							schema: { type: "string", maxLength: 256 },
						},
						{
							in: "query",
							name: "dateFrom",
							schema: { type: "string", format: "date-time" },
						},
						{
							in: "query",
							name: "dateTo",
							schema: { type: "string", format: "date-time" },
						},
					],
					responses: {
						"200": {
							description: "Paginated audit-log rows",
							content: {
								"application/json": {
									schema: {
										$ref: "#/components/schemas/AuditLogListResponse",
									},
								},
							},
						},
						"400": {
							description:
								"Bad request (invalid filter, cursor, or date range)",
							content: {
								"application/json": {
									schema: {
										$ref: "#/components/schemas/ErrorResponse",
									},
								},
							},
						},
						"401": {
							description: "Missing or invalid API key",
							content: {
								"application/json": {
									schema: {
										$ref: "#/components/schemas/ErrorResponse",
									},
								},
							},
						},
						"403": {
							description:
								"API key missing the `audit_log:read` scope",
							content: {
								"application/json": {
									schema: {
										$ref: "#/components/schemas/ErrorResponse",
									},
								},
							},
						},
						"429": {
							description:
								"Per-key rate limit exceeded (600 req/min)",
							content: {
								"application/json": {
									schema: {
										$ref: "#/components/schemas/ErrorResponse",
									},
								},
							},
						},
					},
				},
			},
			"/api/v1/audit-log/export": {
				get: {
					tags: ["Audit Log"],
					summary: "Export audit-log events",
					description: [
						"CSV or NDJSON export, capped at 50,000 rows. Requires `audit_log:export`.",
						"",
						"### Example",
						"```bash",
						"curl -H 'Authorization: Bearer org_abc12345_secret' \\\\",
						"     'https://fabric.pro/api/v1/audit-log/export?format=ndjson&severities=error,critical' \\\\",
						"     -o audit.ndjson",
						"```",
						"",
						"### CSV format",
						"Comma-separated, one header row, fields quoted only when they contain",
						"a comma, quote, or newline. UTF-8 with no BOM.",
						"",
						"### NDJSON format",
						"One JSON object per line, terminated with `\\n`. Each object matches the",
						"`AuditLogItem` schema.",
						"",
						"### Row cap",
						"50,000 rows per call (hard). If your filter matches more, refine it",
						"(date range / actions / severity) or page through `/api/v1/audit-log`",
						"with cursor pagination instead.",
					].join("\n"),
					parameters: [
						{
							in: "query",
							name: "format",
							required: true,
							schema: { type: "string", enum: ["csv", "ndjson"] },
						},
						{
							in: "query",
							name: "actions",
							schema: { type: "string" },
						},
						{
							in: "query",
							name: "categories",
							schema: { type: "string" },
						},
						{
							in: "query",
							name: "severities",
							schema: { type: "string" },
						},
						{
							in: "query",
							name: "outcomes",
							schema: { type: "string" },
						},
						{
							in: "query",
							name: "actorIds",
							schema: { type: "string" },
						},
						{
							in: "query",
							name: "projectId",
							schema: { type: "string" },
						},
						{
							in: "query",
							name: "correlationId",
							schema: { type: "string", maxLength: 256 },
						},
						{
							in: "query",
							name: "dateFrom",
							schema: { type: "string", format: "date-time" },
						},
						{
							in: "query",
							name: "dateTo",
							schema: { type: "string", format: "date-time" },
						},
					],
					responses: {
						"200": {
							description: "Export body",
							content: {
								"text/csv": { schema: { type: "string" } },
								"application/x-ndjson": {
									schema: { type: "string" },
								},
							},
						},
						"400": {
							description: "Result set too large (> 50,000 rows)",
							content: {
								"application/json": {
									schema: {
										$ref: "#/components/schemas/ErrorResponse",
									},
								},
							},
						},
						"401": {
							description: "Missing or invalid API key",
							content: {
								"application/json": {
									schema: {
										$ref: "#/components/schemas/ErrorResponse",
									},
								},
							},
						},
						"403": {
							description:
								"API key missing the `audit_log:export` scope",
							content: {
								"application/json": {
									schema: {
										$ref: "#/components/schemas/ErrorResponse",
									},
								},
							},
						},
					},
				},
			},
		},
	};
}

/**
 * Env flag controlling whether `GET /api/v1/docs` serves Scalar's
 * Swagger-style UI.
 *
 * - Cloud staging: set to `"true"`. SREs use the docs UI to experiment.
 * - Cloud prod: unset. The REST endpoints themselves still work; only
 *   the documentation UI is gated off so the prod surface advertises
 *   less.
 * - Self-hosted: operators choose. Default off.
 */
const PUBLIC_API_DOCS_ENABLED_ENV = "FABRIC_PUBLIC_API_DOCS_ENABLED";

export function publicApiDocsEnabled(): boolean {
	const raw = process.env[PUBLIC_API_DOCS_ENABLED_ENV];
	if (!raw) {
		return false;
	}
	const v = raw.trim().toLowerCase();
	return v === "true" || v === "1" || v === "yes";
}
