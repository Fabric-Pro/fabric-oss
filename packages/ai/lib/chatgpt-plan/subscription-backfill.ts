import type { ChatGptPlanTier } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { logger } from "@repo/logs";
import { decryptApiKey } from "@repo/utils";
import {
	type PlanSourceRef,
	planSourceKey,
	planSourceLogFields,
} from "./sources";
import {
	type ChatGptPlanSubscription,
	logChatGptPlanIdTokenShape,
	readChatGptPlanSubscription,
} from "./subscription-claims";

/**
 * Fills a tier or paid-until date the row does not know yet from the ID token
 * stored at sign-in (Fizzy #2770 G7): a refresh need not bring a new ID token,
 * and rows connected before the claims were read never had them parsed.
 */

interface SubscriptionFields {
	tier: ChatGptPlanTier;
	subscriptionActiveUntil: Date | null;
}

interface BackfillableRow extends SubscriptionFields {
	/** Bumped by every write, a token rotation included. */
	updatedAt: Date;
}

/** What `read` adds to `row` without overwriting anything it already knows. */
export function missingSubscriptionFields(
	row: SubscriptionFields,
	read: ChatGptPlanSubscription,
): ChatGptPlanSubscription {
	return {
		...(row.tier === "UNKNOWN" && read.tier && { tier: read.tier }),
		...(row.subscriptionActiveUntil === null &&
			read.subscriptionActiveUntil && {
				subscriptionActiveUntil: read.subscriptionActiveUntil,
			}),
	};
}

// One attempt per row version per process, checked before any query: a row
// that stays incomplete (a Free plan has no paid-until date) would otherwise
// cost a read on every request. Any write to the row, a rotated token
// included, bumps updatedAt and so allows a new attempt. A failed attempt is
// retried only after a pause, so an outage does not turn every read into a
// retry and a warning.
const attempted = new Map<string, number>();
const MAX_ATTEMPTED = 10_000;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const BACKFILL_CONCURRENCY = 5;

function attemptKey(ref: PlanSourceRef, row: BackfillableRow): string {
	return `${planSourceKey(ref)}:${row.updatedAt.getTime()}`;
}

function attemptedRecently(key: string): boolean {
	const until = attempted.get(key);
	return until !== undefined && Date.now() < until;
}

function rememberAttempt(key: string, until: number): void {
	if (attempted.size >= MAX_ATTEMPTED) {
		attempted.clear();
	}
	attempted.set(key, until);
}

export function resetChatGptPlanSubscriptionBackfill(): void {
	attempted.clear();
}

async function readStoredIdToken(ref: PlanSourceRef): Promise<string | null> {
	const row =
		ref.kind === "user"
			? await db.chatGptPlanCredential.findUnique({
					where: { userId: ref.userId },
					select: { encryptedIdToken: true },
				})
			: await db.chatGptPlanOrgAccount.findFirst({
					where: {
						id: ref.accountId,
						organizationId: ref.organizationId,
					},
					select: { encryptedIdToken: true },
				});
	return row?.encryptedIdToken ?? null;
}

/**
 * Writes one field only while the row still lacks it, so an admin's tier or a
 * concurrent refresh's value always wins.
 */
async function writeIfStillMissing(
	ref: PlanSourceRef,
	guard: { tier: "UNKNOWN" } | { subscriptionActiveUntil: null },
	data: ChatGptPlanSubscription,
): Promise<boolean> {
	const { count } =
		ref.kind === "user"
			? await db.chatGptPlanCredential.updateMany({
					where: { userId: ref.userId, ...guard },
					data,
				})
			: await db.chatGptPlanOrgAccount.updateMany({
					where: {
						id: ref.accountId,
						organizationId: ref.organizationId,
						...guard,
					},
					data,
				});
	return count > 0;
}

async function persist(
	ref: PlanSourceRef,
	filled: ChatGptPlanSubscription,
): Promise<ChatGptPlanSubscription> {
	const written: ChatGptPlanSubscription = {};
	if (
		filled.tier &&
		(await writeIfStillMissing(
			ref,
			{ tier: "UNKNOWN" },
			{ tier: filled.tier },
		))
	) {
		written.tier = filled.tier;
	}
	if (
		filled.subscriptionActiveUntil &&
		(await writeIfStillMissing(
			ref,
			{ subscriptionActiveUntil: null },
			{ subscriptionActiveUntil: filled.subscriptionActiveUntil },
		))
	) {
		written.subscriptionActiveUntil = filled.subscriptionActiveUntil;
	}
	return written;
}

/**
 * The row with whatever its stored ID token adds, persisted. Never throws: a
 * failure leaves the row as it was read.
 */
export async function backfillChatGptPlanSubscription<
	T extends BackfillableRow,
>(ref: PlanSourceRef, row: T): Promise<T> {
	if (row.tier !== "UNKNOWN" && row.subscriptionActiveUntil !== null) {
		return row;
	}
	const key = attemptKey(ref, row);
	if (attemptedRecently(key)) {
		return row;
	}
	try {
		const encrypted = await readStoredIdToken(ref);
		if (!encrypted) {
			rememberAttempt(key, Number.POSITIVE_INFINITY);
			return row;
		}
		const idToken = decryptApiKey(encrypted);
		logChatGptPlanIdTokenShape("backfill", ref, idToken);
		const filled = missingSubscriptionFields(
			row,
			readChatGptPlanSubscription(idToken),
		);
		const written =
			Object.keys(filled).length > 0 ? await persist(ref, filled) : {};
		rememberAttempt(key, Number.POSITIVE_INFINITY);
		return Object.keys(written).length > 0 ? { ...row, ...written } : row;
	} catch {
		rememberAttempt(key, Date.now() + RETRY_AFTER_FAILURE_MS);
		logger.warn(
			"[chatgpt-plan] Reading the subscription from the stored ID token failed",
			planSourceLogFields(ref),
		);
		return row;
	}
}

/** Every row backfilled, at most a few at a time, in the order given. */
export async function backfillChatGptPlanSubscriptions<
	T extends BackfillableRow,
>(rows: T[], refOf: (row: T) => PlanSourceRef): Promise<T[]> {
	const result = [...rows];
	let next = 0;
	const worker = async () => {
		while (next < rows.length) {
			const index = next++;
			const row = rows[index] as T;
			result[index] = await backfillChatGptPlanSubscription(
				refOf(row),
				row,
			);
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(BACKFILL_CONCURRENCY, rows.length) },
			worker,
		),
	);
	return result;
}
