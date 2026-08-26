/**
 * Internal Project Context Search Endpoint
 *
 * Called by LangGraph agents to search project knowledge (Qdrant vector search).
 * Searches all embedded project contexts: meeting transcripts, uploaded docs,
 * codebase analysis, integration content, etc.
 *
 * Auth: Uses X-AI-Token JWT. Body-based userId is not accepted to prevent impersonation.
 *
 * Pattern: Same as /api/internal/teams-search
 */

import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import { db, hasProjectAccess } from "@repo/database";
import { formatContextsForPrompt, retrieveProjectContexts } from "@repo/rag";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
	try {
		const body = await req.json();
		const { projectId, query, topK } = body;

		if (!projectId || !query) {
			return NextResponse.json(
				{ error: "Missing required fields: projectId, query" },
				{ status: 400 },
			);
		}

		// Auth: Extract user/org context from AI token
		const aiToken = req.headers.get(AI_TOKEN_HEADER);
		if (!aiToken) {
			return NextResponse.json(
				{
					error: "Authentication required: X-AI-Token header missing",
				},
				{ status: 401 },
			);
		}

		const payload = await verifyAIToken(aiToken);
		if (!payload || !payload.valid) {
			return NextResponse.json(
				{ error: "Invalid AI token" },
				{ status: 401 },
			);
		}

		const userId = payload.claims.sub;
		const organizationId = payload.claims.org;

		// Verify user has access AND tenant context matches (XOR isolation)
		const access = await hasProjectAccess(
			projectId,
			userId,
			organizationId,
		);
		if (!access) {
			return NextResponse.json(
				{ error: "You do not have access to this project" },
				{ status: 403 },
			);
		}

		// Enforce tenant XOR isolation: the project's organizationId must match
		// the token's org context. Prevents org A token from querying org B or
		// personal projects even if the user has membership in both.
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { organizationId: true },
		});
		if (!project) {
			return NextResponse.json(
				{ error: "Project not found" },
				{ status: 404 },
			);
		}
		const projectOrgId = project.organizationId ?? undefined;
		if (projectOrgId !== organizationId) {
			return NextResponse.json(
				{ error: "Tenant context mismatch" },
				{ status: 403 },
			);
		}

		const contexts = await retrieveProjectContexts({
			projectId,
			query,
			userId,
			organizationId,
			topK: typeof topK === "number" ? Math.min(topK, 20) : undefined,
		});

		const formatted =
			contexts.length > 0 ? formatContextsForPrompt(contexts) : "";

		return NextResponse.json({
			contexts: contexts.map((ctx) => ({
				type: ctx.type,
				source: ctx.filename || ctx.sourceTitle || `Context ${ctx.id}`,
				relevance: Math.round(ctx.score * 100) / 100,
				content: ctx.content,
				// Context Source Type Labeling (#1888): present only when the
				// flag is on and the source is annotated.
				...(ctx.sourceType ? { sourceType: ctx.sourceType } : {}),
				...(ctx.aiInstructions
					? { aiInstructions: ctx.aiInstructions }
					: {}),
			})),
			formatted,
			totalCount: contexts.length,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[Internal Project Context Search] Error:", errorMessage);

		return NextResponse.json(
			{ error: errorMessage, contexts: [], formatted: "", totalCount: 0 },
			{ status: 500 },
		);
	}
}
