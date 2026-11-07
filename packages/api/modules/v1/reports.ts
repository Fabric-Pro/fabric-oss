import { ORPCError } from "@orpc/server";
/**
 * v1 Reports routes
 * GET /reports/templates          list report templates
 * GET /reports/templates/:id      get template details
 * GET /reports/executions         list report executions
 */
import {
	ArtifactBrandingError,
	applyReportInstanceBranding,
	canReadOrganizationReports,
	getArtifactBrandingChoices,
	getReportInstanceBranding,
	getReportTemplate,
	listReportExecutions,
	listReportTemplates,
	ReportBrandingCommandError,
	reportInstanceBrandingUpdateSchema,
} from "@repo/database";
import type { Hono } from "hono";
import { z } from "zod";
import { readBrandBody } from "../branding/lib/brand-body";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { registerReportLifecycleRoutes } from "../reports/rest/routes";
import { notFound, ok, resolveV1Context } from "./helpers";

export function registerReportRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	registerReportLifecycleRoutes(app);
	for (const method of ["get", "put"] as const) {
		app[method](
			"/reports/instances/:id/branding",
			requireScope(method === "put" ? "reports:write" : "reports:read"),
			async (c) => {
				const key = c.get("externalApiContext");
				const ctx = await resolveV1Context(
					key,
					c.req.query("org"),
					false,
					key.boundProjectId,
				);
				if ("error" in ctx) {
					return c.json(
						{ error: { message: ctx.error } },
						ctx.status,
					);
				}
				if (!ctx.organizationId) {
					return c.json(notFound("Report"), 404);
				}
				const id = c.req.param("id");
				if (!id) {
					return c.json(notFound("Report"), 404);
				}
				const actor = {
					organizationId: ctx.organizationId,
					userId: ctx.userId,
					boundProjectId: key.boundProjectId,
				};
				try {
					return c.json(
						ok(
							method === "get"
								? await getReportInstanceBranding(actor, id)
								: await applyReportInstanceBranding(
										actor,
										id,
										reportInstanceBrandingUpdateSchema.parse(
											await readBrandBody(c.req.raw),
										),
									),
						),
					);
				} catch (error) {
					if (error instanceof ReportBrandingCommandError) {
						return c.json(
							{
								error: {
									message: error.message,
									code: error.code,
								},
							},
							error.code === "NOT_FOUND"
								? 404
								: error.code === "FORBIDDEN"
									? 403
									: error.code === "CONFLICT"
										? 409
										: 400,
						);
					}
					if (error instanceof z.ZodError) {
						return c.json(
							{
								error: {
									message:
										"Provide a reviewed report revision and branding selection.",
								},
							},
							400,
						);
					}
					if (error instanceof ORPCError) {
						return c.json(
							{ error: { message: error.message } },
							error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400,
						);
					}
					throw error;
				}
			},
		);
	}
	app.get("/reports/branding", requireScope("reports:read"), async (c) => {
		const ctx = await resolveV1Context(
			c.get("externalApiContext"),
			c.req.query("org"),
			false,
			c.req.query("projectId"),
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}
		if (
			!ctx.organizationId ||
			!(await canReadOrganizationReports(ctx.userId, ctx.organizationId))
		) {
			return c.json(
				{
					error: {
						message: "No permission to read report branding.",
					},
				},
				403,
			);
		}
		try {
			return c.json(
				ok(
					await getArtifactBrandingChoices({
						userId: ctx.userId,
						organizationId: ctx.organizationId,
						projectId: c.req.query("projectId"),
					}),
				),
			);
		} catch (error) {
			if (error instanceof ArtifactBrandingError) {
				return c.json(notFound("Branding"), 404);
			}
			throw error;
		}
	});
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

		if (
			!ctx.organizationId ||
			!(await canReadOrganizationReports(ctx.userId, ctx.organizationId))
		) {
			return c.json(
				{ error: { message: "Your current role cannot read reports" } },
				403,
			);
		}
		const pagination = z
			.object({
				limit: z.coerce
					.number()
					.int()
					.min(1)
					.transform((value) => Math.min(value, 100))
					.default(20),
				offset: z.coerce.number().int().min(0).default(0),
			})
			.safeParse({
				limit: c.req.query("limit"),
				offset: c.req.query("offset"),
			});
		if (!pagination.success) {
			return c.json(
				{
					error: {
						message:
							"Provide a valid limit (1–100) and non-negative offset",
					},
				},
				400,
			);
		}
		if (
			c.req.query("cursor") !== undefined ||
			c.req.query("instanceId") !== undefined
		) {
			return c.json(
				{
					error: {
						message:
							"Use /reports/instances/:id/executions for native cursor history",
					},
				},
				400,
			);
		}
		// Legacy clients may add unrelated query keys; retain their historical behavior.

		const filters = z
			.object({
				status: z
					.enum([
						"PENDING",
						"RUNNING",
						"COMPLETED",
						"FAILED",
						"CANCELLED",
					])
					.optional(),
				templateId: z.string().min(1).optional(),
			})
			.safeParse({
				status: c.req.query("status"),
				templateId: c.req.query("templateId"),
			});
		if (!filters.success) {
			return c.json(
				{
					error: {
						message: "Invalid legacy report execution filter",
					},
				},
				400,
			);
		}
		const { limit, offset } = pagination.data;
		c.header("Deprecation", "true");

		const result = await listReportExecutions({
			...filters.data,
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
