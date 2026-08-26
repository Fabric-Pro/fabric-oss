/**
 * v1 Prompts routes
 * GET /prompts        list prompts visible to caller
 * GET /prompts/:id    get prompt with latest version content
 */
import { createPrompt, db, listPrompts, updatePrompt } from "@repo/database";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { badRequest, notFound, ok, resolveV1Context } from "./helpers";

export function registerPromptRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get("/prompts", requireScope("prompts:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
		const offset = Number(c.req.query("offset") ?? 0);

		// listPrompts handles XOR isolation: pass userId for personal context,
		// organizationId for org context (with SYSTEM prompts always included)
		const result = await listPrompts({
			userId: ctx.organizationId ? undefined : ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
			search: c.req.query("search"),
			category: c.req.query("category"),
			limit,
			offset,
		});

		return c.json(ok(result.prompts, { total: result.total }));
	});

	app.get("/prompts/:id", requireScope("prompts:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const prompt = await db.prompt.findUnique({
			where: { id: c.req.param("id")! },
			include: {
				versions: {
					orderBy: { version: "desc" },
					take: 1,
					select: {
						id: true,
						version: true,
						content: true,
						variables: true,
					},
				},
			},
		});

		if (!prompt) {
			return c.json(notFound("Prompt"), 404);
		}

		// Verify access: SYSTEM prompts are public, USER/ORG require matching context
		if (prompt.scope === "USER" && prompt.userId !== ctx.userId) {
			return c.json(notFound("Prompt"), 404);
		}
		if (
			prompt.scope === "ORG" &&
			prompt.organizationId !== ctx.organizationId
		) {
			return c.json(notFound("Prompt"), 404);
		}

		return c.json(ok(prompt));
	});

	/**
	 * POST /prompts
	 * Creates a new prompt in the tenant context.
	 */
	app.post("/prompts", requireScope("prompts:write"), async (c) => {
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
			key?: string;
			name?: string;
			description?: string;
			content?: string;
			category?: string;
			tags?: string[];
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json(badRequest("Invalid JSON body"), 400);
		}

		const key = body.key?.trim();
		const name = body.name?.trim();
		if (!key) {
			return c.json(badRequest("key is required"), 400);
		}
		if (!name) {
			return c.json(badRequest("name is required"), 400);
		}

		const scope = ctx.organizationId ? "ORG" : "USER";

		const prompt = await createPrompt({
			key,
			name,
			description: body.description?.trim(),
			scope,
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
			category: body.category?.trim(),
			tags: body.tags ?? [],
			createdBy: ctx.userId,
			initialContent: body.content?.trim(),
		});

		return c.json(
			ok({
				id: prompt.id,
				key: prompt.key,
				name: prompt.name,
				description: prompt.description ?? null,
				scope: prompt.scope,
				category: prompt.category ?? null,
				tags: prompt.tags,
				format: prompt.format,
				usageCount: prompt.usageCount,
				createdAt: prompt.createdAt.toISOString(),
				updatedAt: prompt.updatedAt.toISOString(),
			}),
			201,
		);
	});

	/**
	 * PATCH /prompts/:id
	 * Updates a prompt owned by the tenant.
	 */
	app.patch("/prompts/:id", requireScope("prompts:write"), async (c) => {
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
			description?: string | null;
			category?: string | null;
			tags?: string[];
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json(badRequest("Invalid JSON body"), 400);
		}

		// Verify access with tenant isolation
		const existing = await db.prompt.findFirst({
			where: {
				id: c.req.param("id")!,
				...(ctx.organizationId
					? { organizationId: ctx.organizationId }
					: { userId: ctx.userId, organizationId: null }),
			},
		});
		if (!existing) {
			return c.json(notFound("Prompt"), 404);
		}

		const updated = await updatePrompt({
			id: c.req.param("id")!,
			name: body.name?.trim(),
			description: body.description ?? undefined,
			category: body.category ?? undefined,
			tags: body.tags,
			updatedBy: ctx.userId,
		});

		return c.json(
			ok({
				id: updated.id,
				key: updated.key,
				name: updated.name,
				description: updated.description ?? null,
				scope: updated.scope,
				category: updated.category ?? null,
				tags: updated.tags,
				format: updated.format,
				usageCount: updated.usageCount,
				createdAt: updated.createdAt.toISOString(),
				updatedAt: updated.updatedAt.toISOString(),
			}),
		);
	});
}
