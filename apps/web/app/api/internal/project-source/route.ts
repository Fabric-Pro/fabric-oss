import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import {
	getContextById,
	getProjectAccessContext,
	readProjectContextBodyPage,
} from "@repo/database";
import {
	resolveContextTitle,
	resolveContextUnavailableReason,
} from "@repo/database/src/project-context-presentation";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
	try {
		const body = await req.json();
		const { projectId, sourceId, offset, maxChars } = body;
		if (
			typeof projectId !== "string" ||
			!projectId ||
			typeof sourceId !== "string" ||
			!sourceId
		) {
			return NextResponse.json(
				{ error: "Missing required fields: projectId, sourceId" },
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

		// Verify user has access AND tenant context matches (XOR isolation).
		// One query resolves both the access decision and the project's
		// organizationId, instead of a second round trip for the same row.
		const accessContext = await getProjectAccessContext(projectId, userId);
		if (!accessContext) {
			return NextResponse.json(
				{ error: "You do not have access to this project" },
				{ status: 403 },
			);
		}

		// Enforce tenant XOR isolation: the project's organizationId must match
		// the token's org context. Prevents org A token from querying org B or
		// personal projects even if the user has membership in both.
		const projectOrgId = accessContext.organizationId ?? undefined;
		if (projectOrgId !== organizationId) {
			return NextResponse.json(
				{ error: "Tenant context mismatch" },
				{ status: 403 },
			);
		}

		const ctx = await getContextById(sourceId);
		if (!ctx || ctx.projectId !== projectId) {
			return NextResponse.json(
				{ error: "Source not found in this project" },
				{ status: 404 },
			);
		}
		const integer = (value: unknown, fallback: number) =>
			typeof value === "number" && Number.isFinite(value)
				? Math.trunc(value)
				: fallback;
		const page = await readProjectContextBodyPage(
			ctx,
			{ userId, organizationId: accessContext.organizationId },
			{
				offset: Math.min(
					2_147_483_646,
					Math.max(0, integer(offset, 0)),
				),
				maxLength: Math.min(
					40_000,
					Math.max(1, integer(maxChars, 24_000)),
				),
			},
		);
		return NextResponse.json({
			id: ctx.id,
			title: resolveContextTitle(ctx),
			type: ctx.type,
			contentAvailable: page.hasReadableText,
			...(!page.hasReadableText
				? {
						unavailableReason: resolveContextUnavailableReason(
							ctx,
							"the original can be opened from the project's Context tab.",
						),
					}
				: {}),
			content: page.content,
			contentLength: page.contentLength,
			offset: page.offset,
			returnedLength: page.returnedLength,
			truncated: page.truncated,
			...(page.nextOffset !== undefined
				? { nextOffset: page.nextOffset }
				: {}),
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[Internal Project Source] Error:", errorMessage);
		return NextResponse.json(
			{ error: "Unable to read project source" },
			{ status: 500 },
		);
	}
}
