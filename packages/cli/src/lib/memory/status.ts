/**
 * `fabric memory status`: how the mirror and the server stand.
 *
 * Settles the outbox, drops what no longer says anything, and reports what is
 * still waiting: writes in flight, pull requests open, problems the person has
 * to resolve, and the local changes a push would send. Reads the tree; changes
 * only the lock.
 */
import type { MirrorContext } from "./context.js";
import { readLocalFile, scanFolder } from "./local.js";
import {
	emptyMemoryLock,
	type OutboxRecord,
	readMemoryLock,
	writeMemoryLock,
} from "./lock.js";
import {
	resolveOutbox,
	type SettledWrite,
	settleOutbox,
	summarise,
} from "./outbox.js";
import { type PushChange, type PushSkipReason, planPush } from "./plan.js";
import { loadTargets } from "./targets.js";

export interface StatusResult {
	settled: SettledWrite[];
	problems: OutboxRecord[];
	pullRequests: OutboxRecord[];
	pending: number;
	/** Local changes a push would send. */
	changes: PushChange[];
	skipped: Array<{ path: string; reason: PushSkipReason }>;
	cleared: number;
}

export async function status(
	context: MirrorContext,
	options: { clear?: boolean } = {},
): Promise<StatusResult> {
	const lock =
		(await readMemoryLock(context.root, context.projectId)) ??
		emptyMemoryLock(context.projectId);
	const settled = await settleOutbox(context, lock);
	await resolveOutbox(context, lock);
	let cleared = 0;
	if (options.clear) {
		const keep = lock.outbox.filter(
			(record) =>
				record.status === "PENDING" || record.status === "PULL_REQUEST",
		);
		cleared = lock.outbox.length - keep.length;
		lock.outbox = keep;
	}

	const targets = await loadTargets(context, lock);
	const folders = targets.map((target) => target.folder);
	const tracked = (await context.git.tracked(folders)) ?? new Set<string>();
	const local = new Map<string, string>();
	for (const target of targets) {
		const scan = await scanFolder(context.root, target.folder);
		for (const file of scan.files) {
			const read = await readLocalFile(context.root, file.path);
			if (read.ok) {
				local.set(file.path, read.file.hash);
			}
		}
	}
	const plan = planPush({
		targets: targets.map((target) => ({
			id: target.id,
			folder: target.folder,
		})),
		local,
		lock,
		tracked,
	});
	await writeMemoryLock(context.root, lock);
	return {
		settled,
		...summarise(lock),
		changes: plan.changes,
		skipped: plan.skipped,
		cleared,
	};
}
