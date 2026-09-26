/**
 * v1 Prompts routes
 * GET /prompts        list prompts visible to caller
 * GET /prompts/:id    get prompt with latest version content
 */
import { createPrompt, db, listPrompts, updatePrompt } from "@repo/database";
import {
	PROMPT_CONTENT_MAX_LENGTH,
	promptContentTooLongMessage,
} from "@repo/utils/prompt-content";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { verifyOrganizationMembership } from "../organizations/lib/membership";
import {
	badRequest,
	forbidden,
	notFound,
	ok,
	resolveV1Context,
} from "./helpers";

/**
 * In the app only an organization's admins and owners may create or change its
 * prompts (`prompts.create`, `prompts.update`). A key's `prompts:write` scope is
 * a ceiling, not that permission, so the key owner's live role is re-read on
 * every write — a wildcard key included. Without it any member holding a
 * `prompts:write` key could publish or rewrite organization prompts the app
 * would refuse them; the same class as the v1 write-permission fix (#2380).
 */
async function isOrganizationPromptAdmin(
	organizationId: string,
	userId: string,
): Promise<boolean> {
	const membership = await verifyOrganizationMembership(
		organizationId,
		userId,
	);
	return membership?.role === "admin" || membership?.role === "owner";
}

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

		const initialContent = body.content?.trim();
		if (
			initialContent &&
			initialContent.length > PROMPT_CONTENT_MAX_LENGTH
		) {
			return c.json(
				badRequest(promptContentTooLongMessage(initialContent.length)),
				400,
			);
		}

		const scope = ctx.organizationId ? "ORG" : "USER";

		if (
			ctx.organizationId &&
			!(await isOrganizationPromptAdmin(ctx.organizationId, ctx.userId))
		) {
			return c.json(
				forbidden(
					"Only organization admins can create organization prompts",
				),
				403,
			);
		}

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
			initialContent,
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

		if (
			existing.scope === "ORG" &&
			existing.organizationId &&
			!(await isOrganizationPromptAdmin(
				existing.organizationId,
				ctx.userId,
			))
		) {
			return c.json(
				forbidden(
					"Only organization admins can update organization prompts",
				),
				403,
			);
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
