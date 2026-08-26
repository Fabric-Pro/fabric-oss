/**
 * Daily Brief — Teams Backlog Proposals Collector Activity
 *
 * Reads PendingBacklogProposal rows for the given project that were created
 * inside the time window. The proposal's owning Teams channel (when the
 * source is TEAMS_CHANNEL) is resolved by joining through the
 * ProjectLinkedTeamsChannelSeenMessage dedup table.
 *
 * DB-local: no LLM, no external HTTP.
 */

import { db, type TeamsProposalItem } from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

// =============================================================================
// Types
// =============================================================================

export interface CollectTeamsProposalsInput {
	projectId: string;
	organizationId: string | null;
	timeWindowStart: Date | string;
	timeWindowEnd: Date | string;
}

export type CollectTeamsProposalsOutput = TeamsProposalItem[];

const MAX_SUMMARY_CHARS = 800;

// PendingBacklogProposalStatus includes SUPERSEDED and BACKLOG in the DB; the
// shared brief schema narrows to the user-visible set below. Anything else is
// dropped — notably BACKLOG: a deferred proposal is intentionally excluded from
// the daily brief (parity with how it is hidden from the active review queue
// and every needs-attention count). Do NOT add BACKLOG here to "surface" it.
type BriefStatus = TeamsProposalItem["status"];
const BRIEF_STATUSES: ReadonlyArray<BriefStatus> = [
	"PENDING",
	"APPROVED",
	"APPLIED",
	"REJECTED",
	"FAILED",
];
function toBriefStatus(status: string): BriefStatus | null {
	return (BRIEF_STATUSES as readonly string[]).includes(status)
		? (status as BriefStatus)
		: null;
}

// =============================================================================
// Activity
// =============================================================================

/**
 * Collect pending backlog proposals (Teams channel source) for the Daily Brief.
 *
 * For channel name resolution we look at the first seen-message associated
 * with the proposal — PendingBacklogProposal has no direct channel FK, but
 * every Teams-sourced proposal is linked to one or more
 * ProjectLinkedTeamsChannelSeenMessage rows that reference the originating
 * ProjectLinkedTeamsChannel.
 */
export async function collectTeamsProposals(
	input: CollectTeamsProposalsInput,
): Promise<CollectTeamsProposalsOutput> {
	const { projectId, organizationId } = input;
	const timeWindowStart = new Date(input.timeWindowStart);
	const timeWindowEnd = new Date(input.timeWindowEnd);

	heartbeat("collectTeamsProposals: starting");

	logger.info("[DailyBrief/collectTeamsProposals] Starting", {
		projectId,
		organizationId,
		timeWindowStart: timeWindowStart.toISOString(),
		timeWindowEnd: timeWindowEnd.toISOString(),
	});

	const proposals = await db.pendingBacklogProposal.findMany({
		where: {
			projectId,
			project: { organizationId },
			createdAt: { gte: timeWindowStart, lte: timeWindowEnd },
		},
		select: {
			id: true,
			status: true,
			summary: true,
			changeCount: true,
			createdAt: true,
			seenMessages: {
				select: {
					linkedChannel: {
						select: { channelName: true },
					},
				},
				take: 1,
			},
		},
		orderBy: { createdAt: "desc" },
	});

	const items: TeamsProposalItem[] = [];
	for (const p of proposals) {
		const briefStatus = toBriefStatus(p.status);
		if (!briefStatus) {
			// SUPERSEDED (or any future enum addition) — skip from the brief.
			continue;
		}

		const channelName =
			p.seenMessages[0]?.linkedChannel?.channelName ?? undefined;

		const summary = p.summary
			? p.summary.length > MAX_SUMMARY_CHARS
				? `${p.summary.slice(0, MAX_SUMMARY_CHARS)}…`
				: p.summary
			: undefined;

		// Derive a human title: channel name + count, falling back to summary.
		const title = channelName
			? `Backlog proposal from #${channelName} (${p.changeCount} change${p.changeCount === 1 ? "" : "s"})`
			: `Backlog proposal (${p.changeCount} change${p.changeCount === 1 ? "" : "s"})`;

		items.push({
			occurredAt: p.createdAt,
			title,
			proposalCuid: p.id,
			status: briefStatus,
			changeCount: p.changeCount,
			summary,
			channelName,
		});
	}

	logger.info("[DailyBrief/collectTeamsProposals] Complete", {
		projectId,
		proposalCount: items.length,
	});

	return items;
}
