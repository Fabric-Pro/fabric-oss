/**
 * The ledger of stored run evidence, and the queries the retention sweep needs.
 *
 * See the `TestRunEvidence` model for why a ledger exists at all: an evidence
 * key names no run, and the only other pointer to it is hard-deleted when a
 * project is purged, so without this table the objects are unreachable and
 * immortal.
 */

import { db } from "../../client";

export interface RecordRunEvidenceInput {
	bucket: string;
	storageKey: string;
	projectId: string;
	runId: string;
	testCaseId: string;
	stepOrder: number;
	organizationId: string | null;
	userId: string | null;
}

/**
 * Register one stored object.
 *
 * Idempotent on `storageKey`, because Temporal retries activities: a case whose
 * upload succeeded and whose acknowledgement was lost is replayed, and a second
 * ledger row for one object would make the sweep try to delete it twice and
 * report a phantom error the second time.
 */
export async function recordRunEvidence(
	input: RecordRunEvidenceInput,
): Promise<void> {
	await db.testRunEvidence.upsert({
		where: { storageKey: input.storageKey },
		create: input,
		// Nothing to change: the object at this key is the object we just wrote.
		// The upsert exists for its conflict behaviour, not its update.
		update: {},
	});
}

export interface ExpiredEvidenceRow {
	id: string;
	bucket: string;
	storageKey: string;
	projectId: string;
}

/**
 * One page of evidence whose project has a retention window it has outlived.
 *
 * Deliberately NOT a single query. Each project sets its own window, and `0`
 * means keep indefinitely, so "expired" is per-project arithmetic rather than
 * one cutoff. Projects that have never saved their QA settings have no row at
 * all and take the default, which is why the caller resolves windows rather than
 * joining: a join would silently skip every project still on defaults, i.e. most
 * of them.
 *
 * Keyset pagination on `id`, matching `attachment-retention-purge`: rows whose
 * object delete failed are left behind on purpose, so an offset or a Prisma
 * cursor would either stall or point at a row that no longer exists. Comparing
 * values terminates even when a whole page errors.
 */
export async function listEvidencePage(input: {
	afterId: string | null;
	limit: number;
}): Promise<
	Array<
		ExpiredEvidenceRow & { capturedAt: Date; organizationId: string | null }
	>
> {
	return db.testRunEvidence.findMany({
		where: input.afterId ? { id: { gt: input.afterId } } : {},
		orderBy: { id: "asc" },
		take: input.limit,
		select: {
			id: true,
			bucket: true,
			storageKey: true,
			projectId: true,
			capturedAt: true,
			organizationId: true,
		},
	});
}

/** Retention window per project, for the projects a page actually touched. */
export async function resolveRetentionDays(
	projectIds: string[],
): Promise<Map<string, number>> {
	const rows = await db.projectQaSettings.findMany({
		where: { projectId: { in: projectIds } },
		select: { projectId: true, evidenceRetentionDays: true },
	});
	return new Map(rows.map((r) => [r.projectId, r.evidenceRetentionDays]));
}

/** Drop ledger rows whose objects were confirmed deleted. */
export async function deleteEvidenceRows(ids: string[]): Promise<number> {
	if (ids.length === 0) {
		return 0;
	}
	const { count } = await db.testRunEvidence.deleteMany({
		where: { id: { in: ids } },
	});
	return count;
}

/** Total ledger size, for the sweep's own reporting. */
export async function countRunEvidence(): Promise<number> {
	return db.testRunEvidence.count();
}
