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
	startJudgeStageDeadline,
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
	error?: string;
};

/**
 * Possible duplicates for the unresolved create items of every PENDING
 * Proposal Inbox proposal of a project, in one call: roadmap tickets and the
 * other unreviewed inbox items (see `proposal-duplicate-scoring.ts`).
 * Tickets come from the routing shortlist `stories.checkDuplicate` uses; a
 * ticket under the duplicate bar is shown only when that check's routing
 * judge confirms it.
 *
 * Cost bound: one embedding pass for the whole inbox (at most
 * `MAX_INBOX_ITEMS_SCANNED` items) and at most `MAX_VERIFIED_INBOX_ITEMS`
 * (8) judge calls per call. The procedure is AI rate-limited, and the
 * client caches the result per project rather than asking again for each
 * proposal it opens.
 *
 * The judge stage stops at its own, shorter deadline and the flags found
 * without it are returned, with no `error`. Advisory only: it changes no
 * data, and any other failure or the request deadline returns `error` with
 * no flags instead of throwing. Only an access failure throws.
 */
export const proposalDuplicateFlagsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	// Spends provider money on embeddings: capped like `checkDuplicate`.
	.use(async ({ context, next, path }) => {
		await enforceAiRateLimit(context.user.id, path, RATE_LIMIT_PRESETS.ai);
		return await next();
	})
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/proposals/duplicate-flags",
		tags: ["Projects", "Backlog"],
		summary: "Find possible duplicates across the Proposal Inbox",
		description:
			"Compares each unresolved new item of the project's pending Proposal Inbox proposals with the project's roadmap tickets and with the other unreviewed inbox items. Advisory: never changes data, and a failure returns `error` with no flags.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(
		async ({ input, context }): Promise<ProposalDuplicateFlagsResult> => {
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
			const judgeStage = startJudgeStageDeadline(deadline);
			const timeoutResult = deadline.expired.then(
				(): ProposalDuplicateFlagsResult => {
					logger.warn(`${LOG_PREFIX} request deadline exceeded`, {
						projectId: input.projectId,
						deadlineMs: deadline.ms,
					});
					return { flags: [], error: UNAVAILABLE_MESSAGE };
				},
			);
			const run = detectInboxDuplicates({
				projectId: input.projectId,
				userId: user.id,
				organizationId: projectTenant?.organizationId ?? undefined,
				maxStaleEmbeds: MAX_INLINE_EMBEDS,
				logPrefix: LOG_PREFIX,
				abortSignal: deadline.signal,
				judgeSignal: judgeStage.signal,
			}).then(
				(flags): ProposalDuplicateFlagsResult => ({ flags }),
				(error: unknown): ProposalDuplicateFlagsResult => {
					logger.warn(`${LOG_PREFIX} check failed`, {
						projectId: input.projectId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					});
					return { flags: [], error: UNAVAILABLE_MESSAGE };
				},
			);

			const result = await Promise.race([run, timeoutResult]);
			deadline.clear();
			judgeStage.clear();
			return result;
		},
	);
