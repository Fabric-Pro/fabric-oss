import { ORPCError } from "@orpc/client";
import { getProjectTenantId, hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { RATE_LIMIT_PRESETS } from "../../../../lib/rate-limit";
import {
	enforceAiRateLimit,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	MAX_INLINE_EMBEDS,
	startRequestDeadline,
} from "../../lib/duplicate-check-limits";
import { detectInboxDuplicates } from "../../lib/proposal-duplicate-matching";
import type { ProposalDuplicateFlag } from "../../lib/proposal-duplicate-scoring";

const LOG_PREFIX = "[Proposal Duplicates]";

const UNAVAILABLE_MESSAGE =
	"Could not check the Proposal Inbox for possible duplicates right now.";

export type ProposalDuplicateFlagsResult = {
	/** Only items with at least one match; empty means nothing to flag. */
	flags: ProposalDuplicateFlag[];
	/** Items not compared yet; ask again while it is above zero. */
	stillChecking: number;
	/** Items whose candidates wait for the background verifier. */
	verifying: number;
	/** Every item without a final answer yet. */
	checking: { proposalId: string; changeIndex: number }[];
	error?: string;
};

/** The answer when the check could not run: no flags, nothing to wait for. */
const UNAVAILABLE: ProposalDuplicateFlagsResult = {
	flags: [],
	stillChecking: 0,
	verifying: 0,
	checking: [],
	error: UNAVAILABLE_MESSAGE,
};

/**
 * Possible duplicates for the unresolved create items of every PENDING
 * Proposal Inbox proposal of a project: roadmap tickets and the other
 * unreviewed inbox items (see `proposal-duplicate-scoring.ts`). A match is
 * shown only when the roadmap duplicate scan's candidate rule selects it and
 * the scan's verifier has confirmed it on both current texts. Candidates
 * with no such verdict are verified in the background; `verifying` counts
 * their items, and `checking` lists every item without a final answer.
 *
 * Cost bound: one embedding pass per call, with at most
 * `MAX_NEW_INBOX_EMBEDS` inbox items not already in the item vector cache.
 * A larger inbox is covered over several calls: `stillChecking` says how many
 * items wait, and the client asks again, less often each time, until it is
 * zero. Only a call that embeds counts against the AI rate limit: one
 * answered from the cache is free. The client reuses a finished result per
 * project rather than asking again for each proposal it opens.
 *
 * Advisory only: it changes no proposal or ticket (the verifier stores only
 * its verdicts), and any failure, or the request deadline passing, returns
 * `error` with no flags instead of throwing. Only an access failure or a
 * refusal of the AI rate limit throws.
 */
export const proposalDuplicateFlagsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/proposals/duplicate-flags",
		tags: ["Projects", "Backlog"],
		summary: "Find possible duplicates across the Proposal Inbox",
		description:
			"Compares each unresolved new item of the project's pending Proposal Inbox proposals with the project's roadmap tickets and with the other unreviewed inbox items, by the roadmap duplicate scan's rule, and shows a match once the scan's verifier has confirmed it. Advisory: never changes a proposal or ticket, and a failure returns `error` with no flags.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(
		async ({
			input,
			context,
			path,
		}): Promise<ProposalDuplicateFlagsResult> => {
			const user = context.user;
			const projectTenant = await getProjectTenantId(input.projectId);
			const canAccess =
				projectTenant !== null &&
				(await hasProjectAccess(input.projectId, user.id));
			if (!canAccess) {
				throw new ORPCError("FORBIDDEN", {
					message: "You don't have access to this project",
				});
			}

			const deadline = startRequestDeadline();
			const timeoutResult = deadline.expired.then(
				(): ProposalDuplicateFlagsResult => {
					logger.warn(`${LOG_PREFIX} request deadline exceeded`, {
						projectId: input.projectId,
						deadlineMs: deadline.ms,
					});
					return UNAVAILABLE;
				},
			);
			const run = detectInboxDuplicates({
				projectId: input.projectId,
				userId: user.id,
				organizationId: projectTenant?.organizationId ?? undefined,
				maxStaleEmbeds: MAX_INLINE_EMBEDS,
				logPrefix: LOG_PREFIX,
				abortSignal: deadline.signal,
				// Spends provider money on embeddings: capped like
				// `checkDuplicate`, but only when the call embeds.
				beforeEmbed: () =>
					enforceAiRateLimit(user.id, path, RATE_LIMIT_PRESETS.ai),
			}).then(
				(check): ProposalDuplicateFlagsResult => check,
				(error: unknown): ProposalDuplicateFlagsResult => {
					if (isRateLimitRefusal(error)) {
						throw error;
					}
					logger.warn(`${LOG_PREFIX} check failed`, {
						projectId: input.projectId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					});
					return UNAVAILABLE;
				},
			);

			try {
				return await Promise.race([run, timeoutResult]);
			} finally {
				deadline.clear();
			}
		},
	);

function isRateLimitRefusal(error: unknown): boolean {
	return error instanceof ORPCError && error.code === "TOO_MANY_REQUESTS";
}
