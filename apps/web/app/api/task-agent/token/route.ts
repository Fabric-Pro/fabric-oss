/**
 * Task Agent Live Token API Endpoint
 *
 * Issues a short-lived, room-scoped JWT that authorizes a browser to subscribe
 * to the task-agent PartyKit room for one plan. Mirrors the document
 * collaboration pair (/api/collab/token + /api/collab/verify).
 *
 * Authorization is project-scoped (`hasProjectAccess`), matching how the rest of
 * the task-agent surface treats this data — teammates with project access may
 * watch a run they did not start.
 *
 * @security
 * - Session-based authentication
 * - Rate limiting (60 token requests per minute per user; reconnects re-fetch)
 * - Project access check against the plan's project
 */

import { db, hasProjectAccess } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { z } from "zod";
import {
	checkLiveRateLimit,
	getLiveTokenSecretKey,
	mintLiveToken,
	TASK_AGENT_TOKEN_AUDIENCE,
} from "../../lib/live-tokens";

const TokenRequestSchema = z.object({
	planId: z.string().min(1),
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
			`task-agent:token:${userId}`,
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

		const { planId } = validation.data;

		const secretKey = getLiveTokenSecretKey();
		if (!secretKey) {
			console.error("[TaskAgent Token] COLLAB_JWT_SECRET not configured");
			return Response.json(
				{ error: "Server configuration error" },
				{ status: 500 },
			);
		}

		// The plan row is written by a Temporal activity after start-agent
		// returns the planId, so a miss here can be a startup race — the client
		// retries a 404 within its bounded schedule.
		const plan = await db.taskWorkflowPlan.findUnique({
			where: { id: planId },
			select: { id: true, projectId: true, organizationId: true },
		});

		if (!plan) {
			return Response.json({ error: "Plan not found" }, { status: 404 });
		}

		const hasAccess = await hasProjectAccess(plan.projectId, userId);
		if (!hasAccess) {
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		return await mintLiveToken(
			{
				userId,
				planId,
				projectId: plan.projectId,
				// Audit-only: authorization is re-derived from the plan's project
				// on every verify call.
				organizationId: plan.organizationId ?? null,
			},
			{ audience: TASK_AGENT_TOKEN_AUDIENCE, secretKey },
		);
	} catch (error: unknown) {
		console.error("[TaskAgent Token] Error:", error);
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
