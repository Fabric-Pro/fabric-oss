/**
 * Audit Log Sealing — database orchestration.
 *
 * Thin, DB-aware layer over the pure crypto in `./audit-log-seal`:
 *  - {@link sealNextAuditWindow} advances the seal chain by one link.
 *  - {@link verifyAllAuditSeals} re-derives and checks the whole chain.
 *
 * Both stream `audit_log` in `createdAt` order so even the genesis seal (which
 * covers all history) runs with flat memory. Kept separate from the pure module
 * so the crypto stays free of any Prisma import and trivially unit-testable.
 */

import { db } from "../client";
import {
	AUDIT_SEAL_GENESIS_START,
	buildSignedSeal,
	ContentHasher,
	type SealableAuditRow,
	type SealFailureReason,
	type StoredSeal,
	verifySealAgainstContent,
} from "./audit-log-seal";

/** Rows read per page when streaming a window. */
const READ_BATCH = 5_000;

/**
 * Default safety lag: only seal rows older than `now - lag`. A window closes in
 * the past so any audit insert still in flight (or committing from a
 * longer-lived request transaction, whose `createdAt` is the transaction start
 * time) has landed before its window is sealed. Overridable per call.
 */
export const DEFAULT_SEAL_LAG_SECONDS = 300;

export interface SealRunResult {
	created: boolean;
	/** Why nothing was sealed, when `created` is false. */
	reason?: "window_not_open";
	sequence?: number;
	rowCount?: number;
	periodStart?: string;
	periodEnd?: string;
	keyId?: string;
}

export interface VerifyReport {
	ok: boolean;
	totalSeals: number;
	rowsCovered: number;
	coverageStart: string | null;
	coverageEnd: string | null;
	/** Populated only on failure. */
	failedSequence?: number;
	reason?: SealFailureReason;
	detail?: string;
}

/** Read one page of a window, resuming after `cursorId` when provided. */
async function readWindowPage(
	periodStart: Date,
	periodEnd: Date,
	cursorId: string | undefined,
): Promise<SealableAuditRow[]> {
	const rows = await db.auditLog.findMany({
		where: { createdAt: { gte: periodStart, lt: periodEnd } },
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: READ_BATCH,
		...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
	});
	return rows as unknown as SealableAuditRow[];
}

/** Async-iterate every row of a window in canonical order, paged by cursor. */
async function* streamWindow(
	periodStart: Date,
	periodEnd: Date,
): AsyncGenerator<SealableAuditRow> {
	let cursorId: string | undefined;
	while (true) {
		const page = await readWindowPage(periodStart, periodEnd, cursorId);
		if (page.length === 0) {
			return;
		}
		for (const row of page) {
			yield row;
		}
		if (page.length < READ_BATCH) {
			return;
		}
		cursorId = page[page.length - 1].id;
	}
}

function toStoredSeal(row: {
	sequence: number;
	periodStart: Date;
	periodEnd: Date;
	rowCount: number;
	contentHash: string;
	prevSealHash: string | null;
	sealHash: string;
	signature: string;
	keyId: string;
	version: string;
}): StoredSeal {
	return {
		sequence: row.sequence,
		periodStart: row.periodStart.toISOString(),
		periodEnd: row.periodEnd.toISOString(),
		rowCount: row.rowCount,
		contentHash: row.contentHash,
		prevSealHash: row.prevSealHash,
		sealHash: row.sealHash,
		signature: row.signature,
		keyId: row.keyId,
		version: row.version,
	};
}

/**
 * Advance the seal chain by one link. Seals `[prev.periodEnd, now - lag)` (or
 * `[epoch, now - lag)` for the genesis seal). No-op when the window has zero
 * width. The `audit_log_seal.sequence` unique constraint makes a racing double
 * insert fail safely — but the schedule's `overlap: SKIP` prevents that anyway.
 */
export async function sealNextAuditWindow(
	options: { lagSeconds?: number } = {},
): Promise<SealRunResult> {
	const lagSeconds = options.lagSeconds ?? DEFAULT_SEAL_LAG_SECONDS;
	const cutoff = new Date(Date.now() - lagSeconds * 1000);

	const prev = await db.auditLogSeal.findFirst({
		orderBy: { sequence: "desc" },
	});
	const periodStart = prev ? prev.periodEnd : AUDIT_SEAL_GENESIS_START;

	if (cutoff.getTime() <= periodStart.getTime()) {
		return { created: false, reason: "window_not_open" };
	}

	const hasher = new ContentHasher();
	for await (const row of streamWindow(periodStart, cutoff)) {
		hasher.update(row);
	}
	const { contentHash, rowCount } = hasher.digest();

	const sequence = prev ? prev.sequence + 1 : 1;
	const prevSealHash = prev ? prev.sealHash : null;
	const signed = buildSignedSeal({
		sequence,
		periodStart: periodStart.toISOString(),
		periodEnd: cutoff.toISOString(),
		rowCount,
		contentHash,
		prevSealHash,
	});

	await db.auditLogSeal.create({
		data: {
			sequence,
			periodStart,
			periodEnd: cutoff,
			rowCount,
			contentHash,
			prevSealHash,
			sealHash: signed.sealHash,
			signature: signed.signature,
			keyId: signed.keyId,
			version: signed.version,
		},
	});

	return {
		created: true,
		sequence,
		rowCount,
		periodStart: periodStart.toISOString(),
		periodEnd: cutoff.toISOString(),
		keyId: signed.keyId,
	};
}

/**
 * Re-derive and verify the entire seal chain against the current `audit_log`
 * contents. Streams each window so memory stays flat. Returns the first
 * failure (chain break, tampered content, forged seal, unavailable key) or a
 * clean report covering every seal.
 */
export async function verifyAllAuditSeals(): Promise<VerifyReport> {
	const sealRows = await db.auditLogSeal.findMany({
		orderBy: { sequence: "asc" },
	});

	let prev: StoredSeal | null = null;
	let rowsCovered = 0;
	let coverageStart: string | null = null;
	let coverageEnd: string | null = null;

	for (const sealRow of sealRows) {
		const seal = toStoredSeal(sealRow);

		const hasher = new ContentHasher();
		for await (const row of streamWindow(
			sealRow.periodStart,
			sealRow.periodEnd,
		)) {
			hasher.update(row);
		}
		const computed = hasher.digest();

		const verdict = verifySealAgainstContent(seal, computed, prev);
		if (!verdict.ok) {
			return {
				ok: false,
				totalSeals: sealRows.length,
				rowsCovered,
				coverageStart,
				coverageEnd,
				failedSequence: seal.sequence,
				reason: verdict.reason,
				detail: verdict.detail,
			};
		}

		rowsCovered += computed.rowCount;
		if (coverageStart === null) {
			coverageStart = seal.periodStart;
		}
		coverageEnd = seal.periodEnd;
		prev = seal;
	}

	return {
		ok: true,
		totalSeals: sealRows.length,
		rowsCovered,
		coverageStart,
		coverageEnd,
	};
}

/**
 * The moment through which `audit_log` is covered by a seal — the newest seal's
 * `periodEnd`, or `null` when nothing has been sealed yet.
 *
 * Exists so the retention purge can avoid deleting rows a seal already covers.
 * A seal's `contentHash` is a fold over the rows in its window, and
 * `verifySealAgainstContent` reports a content mismatch for "modified / inserted
 * / DELETED rows" alike — so purging inside a sealed window makes that seal fail
 * verification and read as tampering. Worse than noisy: it makes genuine
 * tampering indistinguishable from routine retention, which destroys the very
 * property the seal chain exists to provide.
 */
export async function getSealedThroughAt(): Promise<Date | null> {
	const newest = await db.auditLogSeal.findFirst({
		orderBy: { sequence: "desc" },
		select: { periodEnd: true },
	});
	return newest?.periodEnd ?? null;
}
