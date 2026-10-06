/**
 * Who may act on an orchestrator run.
 *
 * A run is attributable only through its Temporal memo ({ userId,
 * organizationId }, written by every chat starter) and, for an Advisor chat
 * turn, its `ConversationTurn` row. Every route that acts on a run — attach,
 * cancel, approve, clarify, follow-up, status — asks the same question here,
 * and the answer fails closed: a memo with no owner is refused rather than
 * waved through (the old `if (owner && owner !== userId)` shape passed it),
 * and a run with a turn row also requires the caller to be that turn's user
 * in that turn's organization. Organization membership itself stays with
 * each route, which already checks it against the memo.
 *
 * Same rule as the direct-chat cancel route
 * (`../stream/cancel/route.ts`), which already failed closed.
 */

import { db, getConversationTurnOwnerForExecution } from "@repo/database";

/**
 * The organization check every paired orchestrator route applies — start
 * (stream and non-stream), reattach, cancel, approve, clarify, follow-up:
 * a MEMBERSHIP row. One helper so the routes cannot disagree; a project
 * guest (an organization tie without membership) is refused by all of them
 * rather than allowed to start a run it then could not answer. (The status
 * GET keeps its organization-tie read for a guest's own run.)
 */
export async function isOrchestratorOrganizationMember(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	if (!userId || !organizationId) {
		return false;
	}
	const member = await db.member.findFirst({
		where: { userId, organizationId },
	});
	return member !== null;
}

function forbidden(message: string): Response {
	return new Response(JSON.stringify({ error: "Forbidden", message }), {
		status: 403,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Null when `userId` may act on the run; otherwise the 403 to return.
 * `notOwnerMessage` is the route's own wording for a run that is someone
 * else's.
 */
export async function refuseUnlessRunOwner(args: {
	executionId: string;
	userId: string;
	memo: Record<string, unknown> | undefined | null;
	notOwnerMessage: string;
}): Promise<Response | null> {
	const memoUserId = args.memo?.userId;
	if (typeof memoUserId !== "string" || memoUserId.length === 0) {
		return forbidden(
			"This workflow is missing tenant context and cannot be accessed by this route",
		);
	}
	if (memoUserId !== args.userId) {
		return forbidden(args.notOwnerMessage);
	}
	const turnOwner = await getConversationTurnOwnerForExecution(
		args.executionId,
	);
	if (turnOwner) {
		const memoOrganizationId = args.memo?.organizationId;
		if (
			turnOwner.userId !== args.userId ||
			(typeof memoOrganizationId === "string" &&
				memoOrganizationId.length > 0 &&
				turnOwner.organizationId !== memoOrganizationId)
		) {
			return forbidden(args.notOwnerMessage);
		}
	}
	return null;
}
