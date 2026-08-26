/**
 * Backfill `channel_thread_mapping` + `channel_event_receipt` from the
 * legacy slack-specific tables (Slice 5b.2).
 *
 * After Slice 5b.1, /api/webhooks/slack/events delegates to the unified
 * channel handler which writes to channel_* tables. Existing in-flight
 * Slack threads stored in slack_thread_mapping won't match the unified
 * lookup (channel + channelId + threadId) until their rows are copied.
 *
 * Mappings:
 *   slack_thread_mapping → channel_thread_mapping with:
 *     channel = "slack"
 *     channelId = `${slackTeamId}/${slackChannelId}` (matches SlackChannelAdapter)
 *     threadId = slackThreadTs ?? ""
 *     workflowId, status, userId, organizationId, agentId, triggerId carried over
 *   slack_event_receipt → channel_event_receipt with:
 *     channel = "slack"
 *     externalEventId = slackEventId
 *
 * Idempotent — re-running is a no-op (skips rows already present in the
 * channel_* tables based on the unique indexes).
 *
 * The legacy slack_thread_mapping / slack_event_receipt tables are NOT
 * dropped here. They remain as a safety net so the in-flight
 * slackMentionHandlerWorkflow runs can drain and so historical event-
 * dedup records survive. A separate housekeeping PR can drop them after
 * a deprecation window once `channel_*` reads have been verified in
 * production.
 *
 * Run with:
 *   pnpm --filter @repo/database tsx scripts/backfill-channel-tables-from-slack.ts
 */

import { db } from "../prisma/client";

async function backfillEventReceipts(): Promise<{
	scanned: number;
	inserted: number;
	skipped: number;
}> {
	const rows = await db.slackEventReceipt.findMany({
		select: { slackEventId: true },
	});
	let inserted = 0;
	let skipped = 0;
	for (const row of rows) {
		try {
			await db.channelEventReceipt.create({
				data: {
					channel: "slack",
					externalEventId: row.slackEventId,
				},
			});
			inserted += 1;
		} catch {
			// Unique constraint violation = already present. Idempotent skip.
			skipped += 1;
		}
	}
	return { scanned: rows.length, inserted, skipped };
}

async function backfillThreadMappings(): Promise<{
	scanned: number;
	inserted: number;
	skipped: number;
	errored: number;
}> {
	const rows = await db.slackThreadMapping.findMany();
	let inserted = 0;
	let skipped = 0;
	let errored = 0;
	for (const row of rows) {
		const channelId = `${row.slackTeamId}/${row.slackChannelId}`;
		const threadId = row.slackThreadTs ?? "";
		const userId = row.userId ?? "system";
		try {
			const existing = await db.channelThreadMapping.findUnique({
				where: {
					channel_channelId_threadId: {
						channel: "slack",
						channelId,
						threadId,
					},
				},
				select: { id: true },
			});
			if (existing) {
				skipped += 1;
				continue;
			}
			await db.channelThreadMapping.create({
				data: {
					channel: "slack",
					channelId,
					threadId,
					status: row.status ?? "active",
					workflowId: row.workflowId,
					agentId: row.deploymentId,
					triggerId: row.triggerId,
					userId,
					organizationId: row.organizationId,
					lastMessageAt: row.lastMessageTs
						? new Date(Number.parseFloat(row.lastMessageTs) * 1000)
						: row.updatedAt,
					timeoutAt: row.timeoutAt,
					createdAt: row.createdAt,
					updatedAt: row.updatedAt,
				},
			});
			inserted += 1;
		} catch (err) {
			errored += 1;
			console.error(
				`[backfill] thread mapping ${row.id} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
	return { scanned: rows.length, inserted, skipped, errored };
}

async function main(): Promise<void> {
	console.log("[backfill] starting channel_* backfill from slack_*");
	const events = await backfillEventReceipts();
	console.log(
		`[backfill] event receipts — scanned: ${events.scanned}, inserted: ${events.inserted}, skipped: ${events.skipped}`,
	);
	const threads = await backfillThreadMappings();
	console.log(
		`[backfill] thread mappings — scanned: ${threads.scanned}, inserted: ${threads.inserted}, skipped: ${threads.skipped}, errored: ${threads.errored}`,
	);
	console.log("[backfill] done");
	if (threads.errored > 0) {
		process.exit(1);
	}
}

main()
	.catch((err) => {
		console.error("[backfill] fatal:", err);
		process.exit(1);
	})
	.finally(async () => {
		await db.$disconnect();
	});
