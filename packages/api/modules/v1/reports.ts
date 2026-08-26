/**
 * v1 Reports routes
 * GET /reports/templates          list report templates
 * GET /reports/templates/:id      get template details
 * GET /reports/executions         list report executions
 */
import {
	getReportTemplate,
	listReportExecutions,
	listReportTemplates,
} from "@repo/database";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { notFound, ok, resolveV1Context } from "./helpers";

export function registerReportRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	/**
	 * GET /reports/templates
	 */
	app.get("/reports/templates", requireScope("reports:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
		const offset = Number(c.req.query("offset") ?? 0);
		const search = c.req.query("search");
		const category = c.req.query("category");

		const result = await listReportTemplates({
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
			search,
			category,
			limit,
			offset,
		});

		const templates = result.templates.map((t) => ({
			id: t.id,
			name: t.name,
			description: t.description ?? null,
			scope: t.scope,
			templateType: t.templateType,
			category: t.category ?? null,
			tags: t.tags,
			isPublic: t.isPublic,
			usageCount: t.useCount,
			createdAt: t.createdAt.toISOString(),
			updatedAt: t.updatedAt.toISOString(),
		}));

		return c.json(ok(templates, { total: result.total }));
	});

	/**
	 * GET /reports/templates/:id
	 */
	app.get(
		"/reports/templates/:id",
		requireScope("reports:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const template = await getReportTemplate({
				id: c.req.param("id")!,
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
			});

			if (!template) {
				return c.json(notFound("Report template"), 404);
			}

			return c.json(
				ok({
					id: template.id,
					name: template.name,
					description: template.description ?? null,
					scope: template.scope,
					templateType: template.templateType,
					category: template.category ?? null,
					tags: template.tags,
					isPublic: template.isPublic,
					usageCount: template.useCount,
					createdAt: template.createdAt.toISOString(),
					updatedAt: template.updatedAt.toISOString(),
				}),
			);
		},
	);

	/**
	 * GET /reports/executions
	 */
	app.get("/reports/executions", requireScope("reports:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
		const offset = Number(c.req.query("offset") ?? 0);

		const result = await listReportExecutions({
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
			limit,
			offset,
		});

		const executions = result.executions.map((e) => ({
			id: e.id,
			templateId: e.templateId ?? null,
			status: e.status,
			userId: e.userId,
			organizationId: e.organizationId ?? null,
			startedAt: e.startedAt?.toISOString() ?? null,
			completedAt: e.completedAt?.toISOString() ?? null,
			error: e.error ?? null,
			createdAt: e.createdAt.toISOString(),
		}));

		return c.json(ok(executions, { total: result.total }));
	});
}
