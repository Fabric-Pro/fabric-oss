import { ORPCError } from "@orpc/server";
import type { Context, Hono } from "hono";
import { requireScope } from "../../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../../external-api/types";
import { ok, resolveV1Context } from "../../v1/helpers";
import { type ReportOperation, runReportCommand } from "../lib/report-commands";

const BODY_LIMIT = 128 * 1024;
async function readBody(request: Request) {
	if (!request.body) {
		return {};
	}
	const reader = request.body.getReader();
	let size = 0;
	const parts: Uint8Array[] = [];
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				break;
			}
			size += next.value.byteLength;
			if (size > BODY_LIMIT) {
				await reader.cancel();
				throw new ORPCError("PAYLOAD_TOO_LARGE");
			}
			parts.push(next.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const part of parts) {
			bytes.set(part, offset);
			offset += part.length;
		}
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		if (error instanceof ORPCError) {
			throw error;
		}
		throw new ORPCError("BAD_REQUEST", {
			message: "Provide valid JSON report settings",
		});
	} finally {
		reader.releaseLock();
	}
}
type Variables = { Variables: ExternalApiVariables };
function route(
	operation: ReportOperation,
	input: (c: Context<Variables>) => Promise<unknown> | unknown,
) {
	return async (c: Context<Variables>) => {
		const key = c.get("externalApiContext");
		const tenant = await resolveV1Context(
			key,
			c.req.query("org"),
			false,
			key.boundProjectId,
		);
		if ("error" in tenant) {
			return c.json({ error: { message: tenant.error } }, tenant.status);
		}
		if (!tenant.organizationId) {
			return c.json({ error: { message: "Report not found" } }, 404);
		}
		try {
			return c.json(
				ok(
					await runReportCommand(
						{
							userId: tenant.userId,
							organizationId: tenant.organizationId,
							scopes: key.scopes,
							boundProjectId: key.boundProjectId,
						},
						operation,
						await input(c),
					),
				),
			);
		} catch (error) {
			if (!(error instanceof ORPCError)) {
				throw error;
			}
			const status =
				error.code === "NOT_FOUND"
					? 404
					: error.code === "FORBIDDEN"
						? 403
						: error.code === "UNAUTHORIZED"
							? 401
							: error.code === "CONFLICT"
								? 409
								: error.code === "PAYLOAD_TOO_LARGE"
									? 413
									: error.code === "INTERNAL_SERVER_ERROR"
										? 500
										: 400;
			return c.json(
				{
					error: {
						code: error.code,
						message: error.message,
						...(error.data ? { details: error.data } : {}),
					},
				},
				status,
			);
		}
	};
}
function nativeHistoryQuery(
	c: Context<Variables>,
	filter: "status" | "artifactType",
) {
	const query = c.req.query();
	const allowed = new Set(["org", "limit", "cursor", filter]);
	if (Object.keys(query).some((key) => !allowed.has(key))) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Native report history uses cursor pagination. Remove unsupported filters such as offset.",
		});
	}
	return {
		limit: Number(query.limit ?? (filter === "status" ? 10 : 20)),
		cursor: query.cursor,
		[filter]: query[filter],
	};
}

export function registerReportLifecycleRoutes(app: Hono<Variables>) {
	app.get(
		"/reports/instances",
		requireScope("reports:read"),
		route("list", (c) => ({
			projectId: c.req.query("projectId"),
			templateId: c.req.query("templateId"),
			search: c.req.query("search"),
			limit: Number(c.req.query("limit") ?? 20),
			offset: Number(c.req.query("offset") ?? 0),
		})),
	);
	app.post(
		"/reports/instances",
		requireScope("reports:write"),
		route("create", (c) => readBody(c.req.raw)),
	);
	app.get(
		"/reports/instances/:id",
		requireScope("reports:read"),
		route("get", (c) => ({ id: c.req.param("id") })),
	);
	app.patch(
		"/reports/instances/:id",
		requireScope("reports:write"),
		route("update", async (c) => ({
			...(await readBody(c.req.raw)),
			id: c.req.param("id"),
		})),
	);
	app.get(
		"/reports/instances/:id/executions",
		requireScope("reports:read"),
		route("executions", (c) => ({
			instanceId: c.req.param("id"),
			...nativeHistoryQuery(c, "status"),
		})),
	);
	app.get(
		"/reports/executions/:id/artifacts",
		requireScope("reports:read"),
		route("artifacts", (c) => ({
			executionId: c.req.param("id"),
			...nativeHistoryQuery(c, "artifactType"),
		})),
	);

	app.post(
		"/reports/instances/:id/executions",
		requireScope("reports:write"),
		route("execute", async (c) => ({
			...(await readBody(c.req.raw)),
			instanceId: c.req.param("id"),
		})),
	);
	app.get(
		"/reports/executions/:id",
		requireScope("reports:read"),
		route("status", (c) => ({ executionId: c.req.param("id") })),
	);
	app.post(
		"/reports/executions/:id/cancel",
		requireScope("reports:write"),
		route("cancel", (c) => ({ executionId: c.req.param("id") })),
	);
	app.get(
		"/reports/artifacts/:id/download",
		requireScope("reports:read"),
		route("download", (c) => ({ id: c.req.param("id") })),
	);
	app.get(
		"/reports/artifacts/:id/deliveries",
		requireScope("reports:read"),
		route("deliveries", (c) => ({
			artifactId: c.req.param("id"),
			limit: Number(c.req.query("limit") ?? 25),
			offset: Number(c.req.query("offset") ?? 0),
		})),
	);
	app.post(
		"/reports/artifacts/:id/distribute",
		requireScope("reports:write"),
		route("distribute", async (c) => ({
			...(await readBody(c.req.raw)),
			artifactId: c.req.param("id"),
		})),
	);
}
