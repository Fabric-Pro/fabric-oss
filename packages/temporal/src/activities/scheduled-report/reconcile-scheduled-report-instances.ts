import {
	computeNextRunAt,
	listInstancesNeedingNextRunAt,
	listInstancesNeedingScheduleInheritance,
	normalizeReportSchedule,
	parseStoredReportSchedule,
	setInstanceSchedule,
} from "@repo/database";
import { heartbeat } from "@temporalio/activity";

/**
 * One-time-ish backfill, idempotent and safe to run every tick:
 *
 *  (1) Inherit: active instances with NO schedule whose owner-owned template carries one
 *      get the template's schedule normalized + nextRunAt frozen.
 *  (2) Compute-missing: active instances that carry a schedule but have no nextRunAt yet
 *      (legacy / un-normalized rows) get normalized + nextRunAt frozen.
 *
 * Both paths write a fully-normalized schedule so downstream readers always see a
 * canonical, phase-anchored config. Returns empty once the dataset has settled.
 */
export async function reconcileScheduledReportInstancesActivity(input: {
	batchSize: number;
}): Promise<{ inherited: number; computed: number }> {
	heartbeat("reconcileScheduledReportInstances");
	const now = new Date();
	let inherited = 0;
	let computed = 0;

	for (const r of await listInstancesNeedingScheduleInheritance(
		input.batchSize,
	)) {
		const norm = normalizeReportSchedule(r.templateSchedule, now);
		if (!norm) {
			continue; // malformed template schedule → skip
		}
		// Next FUTURE occurrence — not the frozen anchorAt (which may be in the past for
		// a restored/legacy row), so we never schedule an obsolete, immediately-due run.
		await setInstanceSchedule(r.id, norm, computeNextRunAt(norm, now));
		inherited++;
	}

	for (const r of await listInstancesNeedingNextRunAt(input.batchSize)) {
		// Prefer the stored normalized config (preserves its frozen anchorAt phase); fall
		// back to normalizing a legacy {frequency}-only schedule (freezes a fresh anchor).
		const norm =
			parseStoredReportSchedule(r.schedule) ??
			normalizeReportSchedule(r.schedule, now);
		if (!norm) {
			continue;
		}
		// computeNextRunAt(now) advances past a stale anchorAt (e.g. a restored instance
		// whose anchorAt is in the past) to the next future occurrence — no instant fire.
		await setInstanceSchedule(r.id, norm, computeNextRunAt(norm, now));
		computed++;
	}

	return { inherited, computed };
}
