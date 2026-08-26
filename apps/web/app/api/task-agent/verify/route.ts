/**
 * Task Agent Live Verification API Endpoint
 *
 * Verifies the scoped JWT presented by a task-agent PartyKit subscriber.
 * Called server-to-server by the Cloudflare worker (party-cf/src/taskAgent.ts)
 * and by the self-hosted legacy party server (party/taskAgent.ts), which both
 * POST `{ planId }` with an `Authorization: Bearer <jwt>` header and expect a
 * 2xx JSON `{ valid, userId }` — that response shape is a contract.
 *
 * There is no session here: the bearer token is the credential, so it is
 * verified before the request body is read and before any database work
 * happens.
 */

import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	checkLiveRateLimit,
	TASK_AGENT_TOKEN_AUDIENCE,
	verifyLiveBearerToken,
} from "../../lib/live-tokens";

const VerifySchema = z.object({
	planId: z.string().min(1),
});

export async function POST(req: Request) {
	try {
		const verified = await verifyLiveBearerToken(req, {
			audience: TASK_AGENT_TOKEN_AUDIENCE,
			resourceClaim: "planId",
			logPrefix: "[TaskAgent Verify]",
		});
		if (!verified.ok) {
			return verified.response;
		}

		const { userId, resourceId: claimedPlanId } = verified;

		// Keyed per plan rather than per caller: a single room cannot be used to
		// hammer the project-access lookups, even with a valid token.
		const rateLimited = await checkLiveRateLimit(
			`task-agent:verify:${claimedPlanId}`,
			"verification",
		);
		if (rateLimited) {
			return rateLimited;
		}

		const body = await req.json();
		const validation = VerifySchema.safeParse(body);

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

		// The token authorizes exactly one room.
		if (claimedPlanId !== planId) {
			return Response.json(
				{ error: "Token plan mismatch" },
				{ status: 403 },
			);
		}

		// Defense in depth: re-load the plan and re-check project access rather
		// than trusting the claims, so a token minted before access was revoked
		// cannot outlive it.
		const plan = await db.taskWorkflowPlan.findUnique({
			where: { id: planId },
			select: { id: true, projectId: true },
		});

		if (!plan) {
			return Response.json({ error: "Plan not found" }, { status: 404 });
		}

		const hasAccess = await hasProjectAccess(plan.projectId, userId);
		if (!hasAccess) {
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		return Response.json({
			valid: true,
			userId,
			planId,
			projectId: plan.projectId,
		});
	} catch (error: unknown) {
		// The caller is an unauthenticated worker: log the detail, return none.
		console.error("[TaskAgent Verify] Error:", error);
		return Response.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

export const runtime = "nodejs";
