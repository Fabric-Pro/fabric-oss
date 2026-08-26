/**
 * Conversation / Agent-History Retention Activity
 *
 * Purges `ai_chat` and `agent_conversation` rows untouched for longer than
 * `FABRIC_CONVERSATION_RETENTION_DAYS`, in 5,000-row batches. Driven by the
 * daily `conversationRetentionWorkflow` (Temporal Schedule).
 *
 * SOC 2 C1.2 names this data explicitly: "including Fabric conversation/agent
 * history per the agreed retention schedule". Until now these two stores had no
 * time-based retention at all — they were destroyed only when their parent
 * project or account was deleted, so an active tenant retained chat and agent
 * history indefinitely.
 *
 * OPT-IN, like audit-log retention and unlike request-span retention. The
 * retention period for conversation history is a business commitment, not an
 * engineering default: shipping a number here would silently start destroying
 * customer data on a schedule nobody agreed to. So with no configuration this
 * activity does nothing, and enabling it is a deliberate act.
 *
 * Behaviour:
 *  - Requires BOTH `FABRIC_CONVERSATION_RETENTION_ENABLED === "true"` and a
 *    positive `FABRIC_CONVERSATION_RETENTION_DAYS`. Either missing = no-op.
 *  - Purges on `updatedAt`, not `createdAt`: this is an inactivity window, so a
 *    long-running thread is kept alive by use. Neither table has a `deletedAt`.
 *  - **Never purges a pinned row.** `pinned` is an explicit user signal to keep
 *    a conversation; age must not override it.
 *  - Computes `cutoffAt` ONCE up front so a long run's window cannot drift.
 *  - Batched raw DELETE with a `LIMIT` subquery; loops until a batch returns 0
 *    or the 1,000-batch safety cap (5M rows) fires.
 *  - Child rows (`ai_chat_mcp_config`, `chat_document`, `document_chunk`;
 *    `workspace_conversation`, `project_conversation`, the document-assistant
 *    join) are removed by DB-level `ON DELETE CASCADE`. Verified: the schema
 *    uses the default `foreignKeys` relation mode on PostgreSQL and the
 *    baseline migration emits real `ON DELETE CASCADE` constraints, so the raw
 *    DELETE below cascades in the database rather than relying on Prisma.
 *  - Logs counts and cutoffs only — never message content.
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";

/** Batch size per DELETE statement. */
const BATCH_SIZE = 5_000;
/** Maximum batches per table per invocation. 1,000 × 5,000 = 5M rows hard cap. */
const MAX_BATCHES = 1_000;
/** Clamp so an absurd value can't overflow the representable Date range. */
const MAX_RETENTION_DAYS = 36_500; // 100 years.

export interface ConversationPurgeTableResult {
	table: string;
	deletedCount: number;
	hitSafetyCap: boolean;
}

export interface PurgeExpiredConversationsResult {
	deletedCount: number;
	cutoffAt: string;
	retentionDays: number;
	enabled: boolean;
	tables: ConversationPurgeTableResult[];
	hitSafetyCap: boolean;
}

/**
 * Read `FABRIC_CONVERSATION_RETENTION_DAYS`. There is no default: unset, empty,
 * non-finite or <= 0 all mean retain forever, because the period is a business
 * decision this code must not make on anyone's behalf.
 */
function readRetentionDays(): number {
	const raw = process.env.FABRIC_CONVERSATION_RETENTION_DAYS;
	if (raw === undefined || raw === "") {
		return 0;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return 0;
	}
	return Math.min(MAX_RETENTION_DAYS, Math.floor(parsed));
}

function isEnabled(): boolean {
	return process.env.FABRIC_CONVERSATION_RETENTION_ENABLED === "true";
}

/**
 * Delete rows from one conversation table in batches.
 *
 * `table` is a literal from TABLES below, never caller input — it is
 * interpolated with `$executeRawUnsafe` because a table name cannot be a bound
 * parameter. `cutoffAt` IS bound.
 */
async function purgeTable(
	table: string,
	cutoffAt: Date,
): Promise<ConversationPurgeTableResult> {
	let deletedCount = 0;
	let batches = 0;

	while (batches < MAX_BATCHES) {
		const affected = await db.$executeRawUnsafe(
			`DELETE FROM "${table}"
			 WHERE "id" IN (
			   SELECT "id" FROM "${table}"
			   WHERE "updatedAt" < $1 AND "pinned" = false
			   ORDER BY "updatedAt" ASC
			   LIMIT ${BATCH_SIZE}
			 )`,
			cutoffAt,
		);
		if (affected === 0) {
			break;
		}
		deletedCount += affected;
		batches += 1;
	}

	const hitSafetyCap = batches >= MAX_BATCHES;
	if (hitSafetyCap) {
		logger.warn(
			{
				event: "conversation.retention.safety_cap_hit",
				table,
				maxBatches: MAX_BATCHES,
				batchSize: BATCH_SIZE,
				deletedCount,
				cutoffAt: cutoffAt.toISOString(),
			},
			`[ConversationRetention] Safety cap hit on ${table} after ${MAX_BATCHES} batches (${deletedCount} rows). Remaining rows purge on the next run.`,
		);
	}

	return { table, deletedCount, hitSafetyCap };
}

/** Tables whose rows are conversation/agent history. Literals, never input. */
const TABLES = ["ai_chat", "agent_conversation"] as const;

export async function purgeExpiredConversationsActivity(): Promise<PurgeExpiredConversationsResult> {
	const enabled = isEnabled();
	const retentionDays = readRetentionDays();
	const now = new Date();

	if (!enabled || retentionDays <= 0) {
		logger.info(
			{
				event: "conversation.retention.skipped",
				reason: !enabled ? "not_enabled" : "retention_days_unset",
			},
			"[ConversationRetention] Disabled or no retention period configured — retaining conversation history, skipping purge",
		);
		return {
			deletedCount: 0,
			cutoffAt: now.toISOString(),
			retentionDays,
			enabled,
			tables: [],
			hitSafetyCap: false,
		};
	}

	const cutoffAt = new Date(
		now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
	);

	logger.info(
		{
			event: "conversation.retention.started",
			retentionDays,
			cutoffAt: cutoffAt.toISOString(),
			tables: TABLES,
		},
		"[ConversationRetention] Starting purge run",
	);

	const tables: ConversationPurgeTableResult[] = [];
	for (const table of TABLES) {
		tables.push(await purgeTable(table, cutoffAt));
	}

	const deletedCount = tables.reduce((sum, t) => sum + t.deletedCount, 0);
	const hitSafetyCap = tables.some((t) => t.hitSafetyCap);

	logger.info(
		{
			event: "conversation.retention.completed",
			deletedCount,
			retentionDays,
			cutoffAt: cutoffAt.toISOString(),
			tables,
			hitSafetyCap,
		},
		`[ConversationRetention] Purged ${deletedCount} conversation rows last updated before ${cutoffAt.toISOString()}`,
	);

	return {
		deletedCount,
		cutoffAt: cutoffAt.toISOString(),
		retentionDays,
		enabled,
		tables,
		hitSafetyCap,
	};
}
