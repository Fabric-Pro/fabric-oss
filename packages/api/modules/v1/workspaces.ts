/**
 * v1 Workspaces routes
 *   GET  /workspaces             list workspaces
 *   GET  /workspaces/:id         get workspace details
 *   POST /workspaces/:id/query   semantic (RAG) search over workspace docs
 */
import { embed, getAIEmbeddingModel } from "@repo/ai";
import { db, getWorkspaceAccessContext, listWorkspaces } from "@repo/database";
import { generateSparseVector, searchWorkspaceChunks } from "@repo/rag";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { badRequest, notFound, ok, resolveV1Context } from "./helpers";

export function registerWorkspaceRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get("/workspaces", requireScope("workspaces:read"), async (c) => {
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
		const status = c.req.query("status") as
			| "ACTIVE"
			| "ARCHIVED"
			| undefined;

		const result = await listWorkspaces({
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
			limit,
			offset,
			search,
			status,
		});

		const workspaces = result.workspaces.map((w) => ({
			id: w.id,
			name: w.name,
			description: w.description ?? null,
			status: w.status,
			type: w.type,
			userId: w.userId,
			organizationId: w.organizationId ?? null,
			documentCount: w._count?.documents ?? 0,
			createdAt: w.createdAt.toISOString(),
			updatedAt: w.updatedAt.toISOString(),
		}));

		return c.json(ok(workspaces, { total: result.total }));
	});

	app.get("/workspaces/:id", requireScope("workspaces:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const id = c.req.param("id");
		const ws = await db.workspace.findFirst({
			where: {
				id,
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? null,
			},
			include: {
				_count: {
					select: {
						documents: true,
						conversations: true,
					},
				},
			},
		});

		if (!ws) {
			return c.json(notFound("Workspace"), 404);
		}

		return c.json(
			ok({
				id: ws.id,
				name: ws.name,
				description: ws.description ?? null,
				status: ws.status,
				type: ws.type,
				userId: ws.userId,
				organizationId: ws.organizationId ?? null,
				documentCount: ws._count?.documents ?? 0,
				conversationCount: ws._count?.conversations ?? 0,
				createdAt: ws.createdAt.toISOString(),
				updatedAt: ws.updatedAt.toISOString(),
			}),
		);
	});

	/**
	 * POST /workspaces/:id/query
	 * Hybrid semantic + sparse RAG search over the workspace's document
	 * chunks. Returns pointer hits (documentId, filename, chunkIndex,
	 * page, headings, score) — not chunk content. Consumers fetch the
	 * referenced document for the actual text.
	 *
	 * Server-side resolves the workspace's RAG provider config so the
	 * SDK consumer never carries an embedding API key. Mirrors the
	 * fabric_query_workspace MCP tool.
	 */
	app.post(
		"/workspaces/:id/query",
		requireScope("workspaces:read"),
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

			const workspaceId = c.req.param("id");
			if (!workspaceId) {
				return c.json(badRequest("workspace id is required"), 400);
			}

			let body: {
				query?: string;
				limit?: number;
				documentIds?: string[];
			};
			try {
				body = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}

			const query = body.query?.trim();
			if (!query) {
				return c.json(badRequest("query is required"), 400);
			}
			if (query.length > 10_000) {
				return c.json(
					badRequest("query must be under 10,000 characters"),
					400,
				);
			}

			// Two questions, both answered before anything is embedded or
			// searched. Can this user open the workspace at all — and is it in
			// the organization this request resolved to? Workspace access answers
			// only the first (it takes no organization), so the second is the
			// explicit comparison below: the same exclusive, null-aware binding
			// `GET /workspaces/:id` applies with its `organizationId` filter, and
			// the v1 rule that an ORGANIZATION key stays bound to its own
			// organization. A workspace outside it is NOT FOUND, never
			// forbidden: a caller must not learn from this that a workspace id
			// exists in someone else's tenant. A personal workspace resolves
			// `organizationId: null`, which no resolved organization can equal.
			const access = await getWorkspaceAccessContext(
				workspaceId,
				ctx.userId,
			);
			if (
				!access ||
				access.organizationId !== (ctx.organizationId ?? null)
			) {
				return c.json(notFound("Workspace"), 404);
			}

			const requestedLimit = body.limit ?? 10;
			const topK = Math.min(Math.max(1, requestedLimit), 50);

			let queryEmbedding: number[];
			try {
				const embeddingModel = await getAIEmbeddingModel({
					userId: ctx.userId,
					organizationId: ctx.organizationId ?? undefined,
				});
				const result = await embed({
					model: embeddingModel,
					value: query,
				});
				queryEmbedding = result.embedding;
			} catch (err) {
				return c.json(
					{
						error: {
							message:
								err instanceof Error
									? err.message
									: "Failed to embed query",
							code: "EMBEDDING_FAILED",
						},
					},
					502,
				);
			}

			const results = await searchWorkspaceChunks({
				workspaceId,
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
				queryEmbedding,
				querySparseVector: generateSparseVector(query),
				topK,
				minSimilarity: 0.4,
				documentIds: body.documentIds,
			});

			return c.json(
				ok(
					results.map((r) => ({
						chunkId: r.chunkId,
						documentId: r.documentId,
						filename: r.filename ?? null,
						score: r.score,
						chunkIndex: r.chunkIndex,
						pageNumber: r.pageNumber ?? null,
						headings: r.headings ?? [],
					})),
					{ total: results.length },
				),
			);
		},
	);
}
