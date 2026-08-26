/**
 * v1 Knowledge route — RAG search over a tenant's project / chat documents.
 *
 *   POST /knowledge/search   { query, scope: { kind, id }, topK?, minSimilarity?, documentIds? }
 *
 * Server-side: resolves the workspace's RAG provider config (so the SDK
 * consumer never carries an embedding API key) and dispatches to the
 * right `@repo/rag` retrieval function based on scope.
 */

import { getRAGProviderConfig } from "@repo/ai";
import { db } from "@repo/database";
import { retrieveContext, retrieveRelevantContextsForSpec } from "@repo/rag";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { badRequest, notFound, ok, resolveV1Context } from "./helpers";

interface KnowledgeChunk {
	id: string;
	content: string;
	similarity: number;
	documentId?: string;
	documentName?: string;
	chunkIndex?: number;
	metadata?: Record<string, unknown>;
}

export function registerKnowledgeRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.post("/knowledge/search", requireScope("knowledge:read"), async (c) => {
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
			query?: string;
			scope?: { kind?: "chat" | "project"; id?: string };
			topK?: number;
			minSimilarity?: number;
			documentIds?: string[];
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json(badRequest("Invalid JSON body"), 400);
		}

		if (!body.query || typeof body.query !== "string") {
			return c.json(badRequest("query is required"), 400);
		}
		if (!body.scope?.kind || !body.scope?.id) {
			return c.json(
				badRequest("scope.kind and scope.id are required"),
				400,
			);
		}
		// Validate/normalize topK — it flows into retrieval slice/quota math,
		// so a non-finite, non-positive, or absurd value must be rejected at
		// the public boundary rather than propagated.
		if (
			body.topK !== undefined &&
			(typeof body.topK !== "number" ||
				!Number.isFinite(body.topK) ||
				body.topK < 1 ||
				body.topK > 50)
		) {
			return c.json(
				badRequest("topK must be a number between 1 and 50"),
				400,
			);
		}
		const requestedTopK =
			body.topK !== undefined ? Math.floor(body.topK) : undefined;

		// Project scope — verify the caller can read the project, then run a
		// project-context retrieval keyed off the tenant's RAG provider.
		if (body.scope.kind === "project") {
			const project = await db.project.findFirst({
				where: {
					id: body.scope.id,
					userId: ctx.userId,
					organizationId: ctx.organizationId,
				},
				select: { id: true },
			});
			if (!project) {
				return c.json(notFound("Project"), 404);
			}
			const contexts = await retrieveRelevantContextsForSpec({
				projectId: project.id,
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
				specMarkdown: body.query,
				baselineDate: new Date(),
				topK: requestedTopK ?? 10,
				minSimilarity: body.minSimilarity ?? 0.3,
			});
			const chunks: KnowledgeChunk[] = contexts.map((ctxRow, idx) => ({
				id: ctxRow.id ?? `${project.id}#${idx}`,
				content: ctxRow.content,
				similarity: ctxRow.score ?? 0,
				documentName: ctxRow.filename ?? ctxRow.sourceTitle,
				metadata: ctxRow.metadata,
			}));
			return c.json(ok(chunks));
		}

		// Chat scope — verify the caller owns the chat, then run an embedding
		// retrieval against its document collection.
		const chat = await db.aiChat.findFirst({
			where: {
				id: body.scope.id,
				userId: ctx.userId,
				organizationId: ctx.organizationId,
			},
			select: { id: true, organizationId: true },
		});
		if (!chat) {
			return c.json(notFound("Chat"), 404);
		}
		const ragConfig = await getRAGProviderConfig({
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
		});
		const results = await retrieveContext({
			chatId: chat.id,
			userId: ctx.userId,
			organizationId: chat.organizationId ?? undefined,
			query: body.query,
			topK: requestedTopK ?? 5,
			minSimilarity: body.minSimilarity ?? 0.3,
			apiKey: ragConfig.apiKey,
			providerConfig: ragConfig,
			documentIds: body.documentIds,
		});
		const chunks: KnowledgeChunk[] = results.map((r) => ({
			id: r.id,
			content: r.content,
			similarity: r.similarity ?? 0,
			documentId: r.documentId,
			documentName: r.filename,
			metadata: r.metadata as Record<string, unknown> | undefined,
		}));
		return c.json(ok(chunks));
	});
}
