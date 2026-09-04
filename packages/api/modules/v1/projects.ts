/**
 * v1 Projects routes
 * GET  /projects          list projects (tenant-scoped)
 * GET  /projects/:id      get project details
 */
import {
	canEditProject,
	createProject,
	getProjectAccessById,
	getProjectByIdForExternalApi,
	listProjects,
	updateProject,
} from "@repo/database";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	badRequest,
	forbidden,
	notFound,
	ok,
	resolveV1Context,
} from "./helpers";

export function registerProjectRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get("/projects", requireScope("projects:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const org = c.req.query("org");
		const ctx = await resolveV1Context(
			apiCtx,
			org,
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
		const offset = Number(c.req.query("offset") ?? 0);

		if (Number.isNaN(limit) || Number.isNaN(offset)) {
			return c.json(badRequest("limit and offset must be numbers"), 400);
		}

		const search = c.req.query("search");
		const status = c.req.query("status") as
			| "DRAFT"
			| "ACTIVE"
			| "COMPLETED"
			| "ARCHIVED"
			| undefined;

		const result = await listProjects({
			userId: ctx.userId,
			// listProjects uses undefined for personal context (not null)
			organizationId: ctx.organizationId ?? undefined,
			limit,
			offset,
			search,
			status,
		});

		return c.json(
			ok(result.projects, {
				total: result.total,
				hasMore: result.hasMore,
			}),
		);
	});

	app.get("/projects/:id", requireScope("projects:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const org = c.req.query("org");
		const ctx = await resolveV1Context(
			apiCtx,
			org,
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		// The versioned endpoint preserves its historical embedded relation shape.
		const project = await getProjectByIdForExternalApi(
			c.req.param("id")!,
			ctx.userId,
			ctx.organizationId ?? undefined,
		);
		if (!project) {
			return c.json(notFound("Project"), 404);
		}

		return c.json(ok(project));
	});

	/**
	 * POST /projects
	 * Creates a new project in the tenant context.
	 */
	app.post("/projects", requireScope("projects:write"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		let body: {
			name?: string;
			description?: string;
			repositoryUrl?: string;
			color?: string;
			icon?: string;
			status?: string;
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json(badRequest("Invalid JSON body"), 400);
		}

		const name = body.name?.trim();
		if (!name) {
			return c.json(badRequest("name is required"), 400);
		}
		if (name.length > 200) {
			return c.json(
				badRequest("name must be 200 characters or fewer"),
				400,
			);
		}

		const project = await createProject({
			name,
			description: body.description?.trim(),
			repositoryUrl: body.repositoryUrl?.trim(),
			color: body.color?.trim(),
			icon: body.icon?.trim(),
			status:
				body.status === "ACTIVE" || body.status === "DRAFT"
					? body.status
					: "DRAFT",
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
		});

		return c.json(
			ok({
				id: project.id,
				name: project.name,
				description: project.description ?? null,
				status: project.status,
				color: project.color ?? null,
				icon: project.icon ?? null,
				userId: project.userId,
				organizationId: project.organizationId ?? null,
				repositoryUrl: project.repositoryUrl ?? null,
				createdAt: project.createdAt.toISOString(),
				updatedAt: project.updatedAt.toISOString(),
			}),
			201,
		);
	});

	/**
	 * PATCH /projects/:id
	 * Updates a project owned by the tenant.
	 */
	app.patch("/projects/:id", requireScope("projects:write"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const id = c.req.param("id")!;

		// Verify project belongs to tenant
		const existing = await getProjectAccessById(
			id,
			ctx.userId,
			ctx.organizationId ?? undefined,
		);
		if (!existing) {
			return c.json(notFound("Project"), 404);
		}

		// `getProjectAccessById` answers "may this caller see the project",
		// which is what produces the 404 above rather than leaking existence.
		// It is true for a Viewer and a Commenter, so it cannot also stand in
		// for "may they change it". The documents routes on this same surface
		// already make the distinction; these did not.
		if (!(await canEditProject(id, ctx.userId))) {
			return c.json(
				forbidden("No edit permission for this project"),
				403,
			);
		}

		let body: {
			name?: string;
			description?: string;
			repositoryUrl?: string;
			color?: string;
			icon?: string;
			status?: string;
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json(badRequest("Invalid JSON body"), 400);
		}

		if (body.name !== undefined && !body.name.trim()) {
			return c.json(badRequest("name cannot be empty"), 400);
		}

		const project = await updateProject(
			id,
			ctx.userId,
			{
				name: body.name?.trim(),
				description: body.description?.trim(),
				color: body.color?.trim(),
				icon: body.icon?.trim(),
				repositoryUrl: body.repositoryUrl?.trim(),
				status: body.status as
					| "DRAFT"
					| "ACTIVE"
					| "COMPLETED"
					| "ARCHIVED"
					| undefined,
			},
			ctx.organizationId ?? undefined,
		);

		return c.json(
			ok({
				id: project.id,
				name: project.name,
				description: project.description ?? null,
				status: project.status,
				color: project.color ?? null,
				icon: project.icon ?? null,
				userId: project.userId,
				organizationId: project.organizationId ?? null,
				repositoryUrl: project.repositoryUrl ?? null,
				createdAt: project.createdAt.toISOString(),
				updatedAt: project.updatedAt.toISOString(),
			}),
		);
	});
}
