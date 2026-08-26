/**
 * Orchestrator Live Token API Endpoint
 *
 * Issues a short-lived, room-scoped JWT that authorizes a browser to subscribe
 * to the orchestrator PartyKit room for one execution. Mirrors the document
 * collaboration pair (/api/collab/token + /api/collab/verify).
 *
 * An orchestrator run has no Prisma row — the Temporal workflow memo
 * ({ userId, organizationId }) is the only record of who started it, so that is
 * what ownership is checked against here (see ../../lib/orchestrator-access).
 *
 * @security
 * - Session-based authentication
 * - Rate limiting (60 token requests per minute per user; reconnects re-fetch)
 * - Execution ID format validation
 * - Fails closed when the workflow memo carries no owner
 */

import { getSession } from "@saas/auth/lib/server";
import { z } from "zod";
import {
	checkLiveRateLimit,
	EXECUTION_ID_PATTERN,
	getLiveTokenSecretKey,
	mintLiveToken,
	ORCHESTRATOR_TOKEN_AUDIENCE,
} from "../../lib/live-tokens";
import { resolveOrchestratorAccess } from "../../lib/orchestrator-access";

const TokenRequestSchema = z.object({
	executionId: z
		.string()
		.min(1)
		.regex(EXECUTION_ID_PATTERN, "Invalid executionId format"),
});

export async function POST(req: Request) {
	try {
		// `disableCookieCache` — a stale cached session must not mint a fresh
		// credential, so this reads through to the session store.
		const session = await getSession();

		if (!session?.user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const userId = session.user.id;

		const rateLimited = await checkLiveRateLimit(
			`orchestrator:token:${userId}`,
			"token",
		);
		if (rateLimited) {
			return rateLimited;
		}

		const body = await req.json();
		const validation = TokenRequestSchema.safeParse(body);

		if (!validation.success) {
			return Response.json(
				{
					error: "Invalid request",
					details: validation.error.issues,
				},
				{ status: 400 },
			);
		}

		const { executionId } = validation.data;

		const secretKey = getLiveTokenSecretKey();
		if (!secretKey) {
			console.error(
				"[Orchestrator Token] COLLAB_JWT_SECRET not configured",
			);
			return Response.json(
				{ error: "Server configuration error" },
				{ status: 500 },
			);
		}

		const access = await resolveOrchestratorAccess(executionId, userId, {
			notOwner: "You are not authorized to watch this execution",
			notOrgMember: "You are not a member of this organization",
		});
		if (!access.ok) {
			return access.response;
		}

		return await mintLiveToken(
			{
				userId,
				executionId,
				// Audit-only: authorization is re-derived from the workflow memo
				// on every verify call.
				organizationId: access.organizationId,
			},
			{ audience: ORCHESTRATOR_TOKEN_AUDIENCE, secretKey },
		);
	} catch (error: unknown) {
		console.error("[Orchestrator Token] Error:", error);
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Internal server error",
			},
			{ status: 500 },
		);
	}
}

export const runtime = "nodejs";
