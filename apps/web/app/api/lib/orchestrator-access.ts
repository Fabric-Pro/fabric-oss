/**
 * Ownership gate for orchestrator live rooms.
 *
 * An orchestrator run has no Prisma row — the Temporal workflow memo
 * ({ userId, organizationId }) is the only record of who started it, so that is
 * what both /api/orchestrator/token and /api/orchestrator/verify check against.
 * One implementation keeps the mint-time and connect-time gates from drifting.
 *
 * Kept out of ./live-tokens so the task-agent routes, which never touch
 * Temporal, do not pull `@repo/temporal` into their module graph.
 */

import { getOrganizationMembership } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";

export type OrchestratorAccessResult =
	| { ok: true; organizationId: string | null }
	| { ok: false; response: Response };

function forbidden(message?: string): Response {
	return Response.json(
		message ? { error: "Forbidden", message } : { error: "Forbidden" },
		{ status: 403 },
	);
}

/**
 * Resolves whether `userId` may watch `executionId`, returning the run's
 * organization (null for personal runs) on success and the exact Response to
 * send on refusal.
 *
 * `forbiddenMessages` adds the explanatory `message` field to the 403s. The
 * token route answers a browser and explains itself; the verify route answers
 * an unauthenticated worker and says nothing beyond the status.
 */
export async function resolveOrchestratorAccess(
	executionId: string,
	userId: string,
	forbiddenMessages?: { notOwner: string; notOrgMember: string },
): Promise<OrchestratorAccessResult> {
	// A describe failure is reported as "not found" (the same conflation the
	// cancel route makes) — the client treats it as terminal for this execution.
	const temporalClient = await getTemporalClient();
	let memo: Record<string, unknown> | undefined;
	try {
		const description = await temporalClient.workflow
			.getHandle(executionId)
			.describe();
		memo = description.memo as Record<string, unknown> | undefined;
	} catch {
		return {
			ok: false,
			response: Response.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			),
		};
	}

	const workflowUserId = memo?.userId;
	// Stricter than the cancel route on purpose: an absent memo owner means we
	// cannot attribute the run, so we refuse rather than authorize it.
	if (
		typeof workflowUserId !== "string" ||
		workflowUserId.length === 0 ||
		workflowUserId !== userId
	) {
		return { ok: false, response: forbidden(forbiddenMessages?.notOwner) };
	}

	const workflowOrgId = memo?.organizationId;
	const organizationId =
		typeof workflowOrgId === "string" && workflowOrgId.length > 0
			? workflowOrgId
			: null;

	if (organizationId) {
		const membership = await getOrganizationMembership(
			organizationId,
			userId,
		);
		if (!membership) {
			return {
				ok: false,
				response: forbidden(forbiddenMessages?.notOrgMember),
			};
		}
	}

	return { ok: true, organizationId };
}
