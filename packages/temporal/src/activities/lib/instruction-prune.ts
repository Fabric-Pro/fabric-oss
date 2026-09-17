/**
 * Storage and retention helpers shared by the Coding Instructions validation
 * activities and the scheduled reaper.
 *
 * They live under `activities/lib/` rather than in
 * `activities/project-instructions.ts` for one hard reason: `activities/index.ts`
 * re-exports that module with `export *`, and `worker.ts` registers everything
 * the barrel exports as a schedulable Temporal activity. Exporting a helper
 * from there to share it would publish it as an activity any workflow —
 * and anything that can start one — could schedule directly. `activities/lib/`
 * is not barrel-exported, so a helper here stays a helper.
 */

import { config } from "@repo/config";
import {
	deleteInstructionSnapshot,
	listPrunableInstructionSnapshots,
} from "@repo/database";
import { exportKeyPrefix } from "@repo/instructions";
import type {
	DeleteObjectsResult,
	StorageProviderInterface,
} from "@repo/storage";
import { safeHeartbeat } from "./activity-liveness";

export const INSTRUCTIONS_BUCKET = config.storage.bucketNames.skills;

/** READY snapshots beyond this many, per project, are prunable (spec §6.3.6). */
export const SNAPSHOT_RETENTION = 5;

/**
 * REJECTED/FAILED snapshots beyond this many are prunable. Deliberately much
 * shorter than the READY window: a refused upload is a diagnostic to read
 * once, not history to roll back to, and counting it against the READY
 * window let a run of bad uploads evict every kept version.
 */
export const FAILED_SNAPSHOT_RETENTION = 2;

/**
 * `deleteObjects` is best-effort: it NEVER throws on a delete failure and
 * reports per-key failures in `errors` (`packages/storage/types.ts`). Every
 * call site in this feature discarded that result, so a snapshot could become
 * terminally REJECTED while the secret-bearing staging object it was rejected
 * for was still in the bucket, and a pruned snapshot could lose its rows while
 * its objects stayed. Failing here makes Temporal retry the activity, which is
 * the behaviour the cleanup always assumed it had.
 *
 * The message carries the COUNT only. A key names a project, a snapshot and a
 * file id, and this string reaches Temporal history and the worker log.
 */
export function assertAllDeleted(
	result: DeleteObjectsResult,
	phase: string,
): void {
	if (result.errors.length > 0) {
		throw new Error(
			`Storage delete failed for ${result.errors.length} object(s) during ${phase}`,
		);
	}
}

/**
 * The most list/delete pages ONE prefix sweep will walk.
 *
 * The row-level budgets bound how many snapshots a run selects, but not how
 * much storage work one selected snapshot can be. An export prefix is the
 * case that matters: it deliberately collects every zip ever built from that
 * snapshot, including the legacy wall-clock-stamped ones, and nothing
 * anywhere bounds how many of those exist. Paginating such a prefix to
 * exhaustion is how a single row could spend an entire activity attempt.
 *
 * So the sweep stops after this many pages and says so. Whatever is left
 * under the prefix is NOT retried here — the rows that named those objects
 * are already gone, so the next run cannot rediscover them — it is left to
 * the bucket-lifecycle rule tracked as the follow-up to this work, which is
 * the same place the other unreferenced-object residue goes. The caller
 * reports the truncation so it is visible rather than silent.
 */
export const MAX_PREFIX_PAGES = 20;

/**
 * A run's remaining allowance of storage object deletions, shared by
 * reference across every sweep in that run.
 *
 * `MAX_PREFIX_PAGES` bounds ONE prefix; nothing bounded the product of the
 * per-phase row budgets and it. A run could nominally reach hundreds of
 * prefixes each worth twenty pages, which is orders of magnitude past what
 * fits inside the activity's `startToCloseTimeout` — and a run that times out
 * in an early phase is retried from the top, so the later phases never get to
 * run at all.
 *
 * Mutable and passed by reference on purpose: the allowance has to be spent
 * across separately-called helpers (per-snapshot key deletes, per-prefix
 * sweeps, several projects) and the caller has to be able to read what is
 * left in order to stop the phase. `remaining` only ever decreases within a
 * run.
 */
export type StorageBudget = { remaining: number };

/**
 * Deletes objects under a prefix, up to `MAX_PREFIX_PAGES` pages and (when
 * given) the run's remaining object allowance, and reports how many keys it
 * removed and whether it stopped early. Heartbeats per page so a wide prefix
 * cannot outlast the declared heartbeatTimeout. Already-deleted keys are
 * tolerated, so this is safe on an empty prefix and on a retry; a key that
 * genuinely could not be deleted throws.
 *
 * `truncated` does not say WHICH bound stopped it. The caller knows: a
 * truncation with budget left is the page budget, whose residue is the
 * bucket-lifecycle follow-up's work, and one with the budget at zero is the
 * run budget, which the next run resumes.
 */
export async function deleteObjectsUnderPrefix(
	storage: StorageProviderInterface,
	prefix: string,
	budget?: StorageBudget,
): Promise<{ deleted: number; truncated: boolean }> {
	let deleted = 0;
	let pages = 0;
	let continuationToken: string | undefined;
	do {
		safeHeartbeat({ phase: "delete-prefix", prefix });
		const page = await storage.listObjects({
			bucket: INSTRUCTIONS_BUCKET,
			prefix,
			continuationToken,
		});
		let keys = page.objects.map((o) => o.key);
		// A page wider than what is left of the run: delete the part the
		// budget covers and stop. Partial is the right answer — every key
		// removed is one fewer for the next run, and the rows that named them
		// are still there to rediscover the rest.
		let overBudget = false;
		if (budget !== undefined && keys.length > budget.remaining) {
			keys = keys.slice(0, Math.max(0, budget.remaining));
			overBudget = true;
		}
		if (keys.length > 0) {
			assertAllDeleted(
				await storage.deleteObjects(keys, {
					bucket: INSTRUCTIONS_BUCKET,
				}),
				"prefix sweep",
			);
			deleted += keys.length;
			if (budget !== undefined) {
				budget.remaining -= keys.length;
			}
		}
		if (overBudget) {
			return { deleted, truncated: true };
		}
		pages++;
		continuationToken = page.nextContinuationToken;
		if (continuationToken !== undefined && pages >= MAX_PREFIX_PAGES) {
			return { deleted, truncated: true };
		}
		if (
			continuationToken !== undefined &&
			budget !== undefined &&
			budget.remaining <= 0
		) {
			return { deleted, truncated: true };
		}
	} while (continuationToken);
	return { deleted, truncated: false };
}

/**
 * Prunes one project's instruction snapshots past their retention windows:
 * rows first, then the objects those rows named.
 *
 * Extracted from the `pruneInstructionSnapshots` activity so the scheduled
 * reaper can run exactly the same pass. That activity only ever runs at the
 * END of a SUCCESSFUL validation workflow, so a project whose uploads keep
 * failing accumulated REJECTED/FAILED rows — and their staged copies — with
 * nothing bounding them.
 *
 * The caller is responsible for establishing that `projectId` and
 * `organizationId` belong together: the activity does it with its
 * `loadVerifiedSnapshot` gate, the reaper with a candidate query that returns
 * both columns off the same row.
 *
 * `budget` is the scheduled reaper's per-RUN object allowance. Without it one
 * project could spend an entire activity attempt: the two retention windows
 * take at most fifty rows each, but a single snapshot can carry thousands of
 * file keys and its export prefix another twenty pages. The budget stops the
 * pass between snapshots, inside a key list, and inside a prefix sweep, and
 * reports `storageTruncated` so the caller knows it stopped early. The
 * workflow's own end-of-run prune passes none: it handles one project whose
 * size its own snapshot already bounded.
 */
export async function pruneProjectInstructionSnapshots(
	storage: StorageProviderInterface,
	projectId: string,
	organizationId: string,
	budget?: StorageBudget,
): Promise<{ deleted: number; storageTruncated: boolean }> {
	const prunable = await listPrunableInstructionSnapshots(
		projectId,
		organizationId,
		{ ready: SNAPSHOT_RETENTION, rejected: FAILED_SNAPSHOT_RETENTION },
	);
	let deleted = 0;
	// True when any export prefix hit `MAX_PREFIX_PAGES`, or when the run's
	// object budget stopped the pass. `deleted` stays a count of ROWS, which
	// is what every caller reports as snapshots pruned; the objects left
	// behind are the bucket-lifecycle follow-up's work, or — for the budget
	// case — the next run's.
	let storageTruncated = false;
	for (const s of prunable) {
		// Checked BETWEEN snapshots, never mid-row: the row is deleted first
		// and its objects second, so stopping inside one would be the one
		// ordering this feature does not allow.
		if (budget !== undefined && budget.remaining <= 0) {
			storageTruncated = true;
			break;
		}
		safeHeartbeat({ snapshotId: s.id, phase: "row-delete" });
		// Rows FIRST, then the objects they name. The old order deleted the
		// objects and only then the rows, so a publish that landed on a
		// candidate between its selection and its deletion left the project
		// pointing at a snapshot whose bytes were already gone.
		//
		// `listPrunableInstructionSnapshots` already excludes the published
		// pointer, so this is the race, not the ordinary case: the
		// `onDelete: Restrict` foreign key refuses the delete and the
		// candidate is skipped with its objects untouched. It will be a
		// candidate again the next time it is no longer published.
		const removal = await deleteInstructionSnapshot(
			s.id,
			projectId,
			organizationId,
		);
		if (!removal.deleted) {
			continue;
		}
		deleted++;
		// The row is gone, so these keys are unreferenced whatever happens
		// next. Deleting the part the budget covers and leaving the rest to
		// the lifecycle rule is strictly better than skipping them all.
		let keys = s.storageKeys;
		if (budget !== undefined && keys.length > budget.remaining) {
			keys = keys.slice(0, Math.max(0, budget.remaining));
			storageTruncated = true;
		}
		if (keys.length > 0) {
			assertAllDeleted(
				await storage.deleteObjects(keys, {
					bucket: INSTRUCTIONS_BUCKET,
				}),
				"prune",
			);
			if (budget !== undefined) {
				budget.remaining -= keys.length;
			}
		}
		// The export zips built from this snapshot. Nothing records which
		// ones exist — the file rows only know their own keys — so they are
		// found by prefix, which also collects objects an earlier
		// wall-clock-stamped build wrote.
		const sweep = await deleteObjectsUnderPrefix(
			storage,
			exportKeyPrefix(projectId, s.id),
			budget,
		);
		storageTruncated ||= sweep.truncated;
	}
	return { deleted, storageTruncated };
}
