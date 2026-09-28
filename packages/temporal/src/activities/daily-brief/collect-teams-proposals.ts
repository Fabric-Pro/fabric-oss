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

/** Row cap — bounds what crosses the Temporal activity boundary (#1997).
 *  Ordered newest-first, so the cap keeps the most recent proposals. */
const MAX_PROPOSAL_ROWS = 100;
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
	"APPLYING",
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
 * with the proposal — PendingBacklogProposal has no direct channel FK, and a
 * first-analysis Teams proposal is linked to the thread's
 * ProjectLinkedTeamsChannelSeenMessage row, which references the originating
 * ProjectLinkedTeamsChannel.
 *
 * A proposal from a revisited thread (late replies analyzed after the thread's
 * first pass) may have no seen row pointing at it: the thread's one row keeps
 * the link to its earlier proposal. For those, the linked channel is resolved
 * through `sourceMetadata.linkedChannelId`, which every Teams channel proposal
 * records — see `resolveUnlinkedTeamsChannelNames`.
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
		take: MAX_PROPOSAL_ROWS,
	});

	const fallbackChannelNames = await resolveUnlinkedTeamsChannelNames(
		projectId,
		proposals.filter((p) => p.seenMessages.length === 0).map((p) => p.id),
	);

	const items: TeamsProposalItem[] = [];
	for (const p of proposals) {
		const briefStatus = toBriefStatus(p.status);
		if (!briefStatus) {
			// SUPERSEDED (or any future enum addition) — skip from the brief.
			continue;
		}

		const channelName =
			p.seenMessages[0]?.linkedChannel?.channelName ??
			fallbackChannelNames.get(p.id) ??
			undefined;

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

/**
 * Channel names for Teams channel proposals that no seen-message row points
 * at, keyed by proposal id — resolved through the `linkedChannelId` the
 * analyzer records in every Teams channel proposal's `sourceMetadata`, so the
 * name matches the seen-row join above (the linked channel's current
 * `channelName`). Proposals from other sources, and links since removed,
 * resolve to nothing.
 *
 * Both reads are bounded by `proposalIds`, which comes from the capped query
 * in `collectTeamsProposals`.
 */
async function resolveUnlinkedTeamsChannelNames(
	projectId: string,
	proposalIds: string[],
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	if (proposalIds.length === 0) {
		return names;
	}
	const rows = await db.pendingBacklogProposal.findMany({
		where: { id: { in: proposalIds }, projectId, source: "TEAMS_CHANNEL" },
		select: { id: true, sourceMetadata: true },
	});
	const linkedChannelIdByProposal = new Map<string, string>();
	for (const row of rows) {
		const metadata = row.sourceMetadata;
		if (
			metadata &&
			typeof metadata === "object" &&
			!Array.isArray(metadata) &&
			typeof metadata.linkedChannelId === "string"
		) {
			linkedChannelIdByProposal.set(row.id, metadata.linkedChannelId);
		}
	}
	if (linkedChannelIdByProposal.size === 0) {
		return names;
	}
	const channels = await db.projectLinkedTeamsChannel.findMany({
		where: {
			id: { in: [...new Set(linkedChannelIdByProposal.values())] },
			projectId,
		},
		select: { id: true, channelName: true },
	});
	const channelNameById = new Map(
		channels.map((channel) => [channel.id, channel.channelName]),
	);
	for (const [proposalId, linkedChannelId] of linkedChannelIdByProposal) {
		const channelName = channelNameById.get(linkedChannelId);
		if (channelName) {
			names.set(proposalId, channelName);
		}
	}
	return names;
}
