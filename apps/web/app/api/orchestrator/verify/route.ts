/**
 * Orchestrator Live Verification API Endpoint
 *
 * Verifies the scoped JWT presented by an orchestrator PartyKit subscriber.
 * Called server-to-server by the Cloudflare worker (party-cf/src/orchestrator.ts)
 * and by the self-hosted legacy party server (party/orchestrator.ts), which both
 * POST `{ executionId }` with an `Authorization: Bearer <jwt>` header and expect
 * a 2xx JSON `{ valid, userId }` — that response shape is a contract.
 *
 * There is no session here: the bearer token is the credential, so it is
 * verified before the request body is read and before any database or Temporal
 * work happens.
 */

import { z } from "zod";
import {
	checkLiveRateLimit,
	ORCHESTRATOR_TOKEN_AUDIENCE,
	verifyLiveBearerToken,
} from "../../lib/live-tokens";
import { resolveOrchestratorAccess } from "../../lib/orchestrator-access";

const VerifySchema = z.object({
	executionId: z.string().min(1),
});

export async function POST(req: Request) {
	try {
		const verified = await verifyLiveBearerToken(req, {
			audience: ORCHESTRATOR_TOKEN_AUDIENCE,
			resourceClaim: "executionId",
			logPrefix: "[Orchestrator Verify]",
		});
		if (!verified.ok) {
			return verified.response;
		}

		const { userId, resourceId: claimedExecutionId } = verified;

		// Keyed per execution rather than per caller: a single room cannot be
		// used to hammer the Temporal describe path, even with a valid token.
		const rateLimited = await checkLiveRateLimit(
			`orchestrator:verify:${claimedExecutionId}`,
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

		const { executionId } = validation.data;

		// The token authorizes exactly one room.
		if (claimedExecutionId !== executionId) {
			return Response.json(
				{ error: "Token execution mismatch" },
				{ status: 403 },
			);
		}

		// Defense in depth: re-derive authorization from the workflow memo
		// rather than trusting the claims, so a token minted before an
		// org-membership change cannot outlive it.
		const access = await resolveOrchestratorAccess(executionId, userId);
		if (!access.ok) {
			return access.response;
		}

		return Response.json({
			valid: true,
			userId,
			executionId,
		});
	} catch (error: unknown) {
		// The caller is an unauthenticated worker: log the detail, return none.
		console.error("[Orchestrator Verify] Error:", error);
		return Response.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

export const runtime = "nodejs";
