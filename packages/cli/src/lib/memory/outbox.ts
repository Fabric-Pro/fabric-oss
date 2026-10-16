/**
 * The outbox: writes the mirror has submitted and not yet seen end.
 *
 * `settleOutbox` asks the server how each pending write ended and folds the
 * answer into the lock: a commit becomes what the lock holds, a pull request
 * is remembered with its URL, and a conflict, refusal or failure stays until
 * the files it names are back in step (`resolveOutbox`) or the person
 * dismisses it. Nothing here deletes or overwrites a working-tree file.
 */
import { FabricNotFoundError, type MemoryWriteReceipt } from "@fabricorg/sdk";
import { aborted, inParallel, type MirrorContext, now } from "./context.js";
import { hashLocalFile } from "./local.js";
import type { MemoryLock, OutboxPath, OutboxRecord } from "./lock.js";

/** A pull request nobody merged, or a pending write whose receipt is gone, stops being tracked after this. */
const OUTBOX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export interface SettledWrite {
	writeId: string;
	folder: string;
	status: OutboxRecord["status"] | "COMMITTED";
	url?: string;
	detail?: string;
	paths: OutboxPath[];
}

function recordFromReceipt(
	record: OutboxRecord,
	receipt: MemoryWriteReceipt,
): OutboxRecord {
	const outcome = receipt.outcome;
	if (outcome === null || receipt.status === "PENDING") {
		return record;
	}
	switch (outcome.status) {
		case "PULL_REQUEST":
			return {
				...record,
				status: "PULL_REQUEST",
				url: outcome.url,
				detail: outcome.reason,
			};
		case "CONFLICT":
			return {
				...record,
				status: "CONFLICT",
				paths: withVerdicts(record.paths, outcome.paths),
			};
		case "REFUSED":
			return {
				...record,
				status: "REFUSED",
				detail: outcome.code,
				paths: withVerdicts(record.paths, outcome.paths ?? []),
			};
		case "FAILED":
			return { ...record, status: "FAILED", detail: outcome.code };
		case "COMMITTED":
			return record;
	}
}

function withVerdicts(
	paths: readonly OutboxPath[],
	verdicts: ReadonlyArray<{
		path: string;
		code: string;
		currentOid?: string | null;
	}>,
): OutboxPath[] {
	return paths.map((entry) => {
		const verdict = verdicts.find(
			(candidate) => candidate.path === entry.path,
		);
		return verdict === undefined
			? entry
			: {
					...entry,
					verdict: {
						code: verdict.code,
						currentOid: verdict.currentOid,
					},
				};
	});
}

/** A committed write is folded into the lock: the server now holds what was sent. */
function applyCommitted(lock: MemoryLock, record: OutboxRecord): void {
	for (const entry of record.paths) {
		if (entry.op === "DELETE") {
			delete lock.files[entry.path];
		} else if (entry.contentHash !== null) {
			lock.files[entry.path] = {
				targetId: record.targetId,
				blobOid: entry.newBlobOid,
				contentHash: entry.contentHash,
				origin: "push",
			};
		}
	}
}

/**
 * Ask the server how each pending write ended and fold the answer in. A write
 * that is still pending stays. A receipt the server no longer has leaves the
 * record to expire rather than guessing what happened to it.
 */
export async function settleOutbox(
	context: MirrorContext,
	lock: MemoryLock,
): Promise<SettledWrite[]> {
	const settled: SettledWrite[] = [];
	const next: OutboxRecord[] = [];
	const pending = lock.outbox.filter((record) => record.status === "PENDING");
	const receipts = new Map<string, MemoryWriteReceipt | null>();
	await inParallel(pending, async (record) => {
		aborted(context);
		try {
			receipts.set(
				record.writeId,
				await context.client.memory.getWrite(
					context.projectId,
					record.writeId,
				),
			);
		} catch (error) {
			if (error instanceof FabricNotFoundError) {
				receipts.set(record.writeId, null);
				return;
			}
			throw error;
		}
	});
	for (const record of lock.outbox) {
		const receipt = receipts.get(record.writeId);
		if (record.status !== "PENDING" || receipt === undefined) {
			next.push(record);
			continue;
		}
		if (receipt === null) {
			next.push(record);
			continue;
		}
		if (receipt.outcome?.status === "COMMITTED") {
			applyCommitted(lock, record);
			settled.push({
				writeId: record.writeId,
				folder: record.folder,
				status: "COMMITTED",
				paths: record.paths,
			});
			continue;
		}
		const updated = recordFromReceipt(record, receipt);
		next.push(updated);
		if (updated.status !== "PENDING") {
			settled.push({
				writeId: updated.writeId,
				folder: updated.folder,
				status: updated.status,
				url: updated.url,
				detail: updated.detail,
				paths: updated.paths,
			});
		}
	}
	lock.outbox = next;
	return settled;
}

/**
 * Drop the records that no longer say anything: a pull request whose files
 * now match the server, a problem whose files are back in step, anything older
 * than the expiry. Returns the dropped records.
 */
export async function resolveOutbox(
	context: MirrorContext,
	lock: MemoryLock,
): Promise<OutboxRecord[]> {
	const dropped: OutboxRecord[] = [];
	const kept: OutboxRecord[] = [];
	for (const record of lock.outbox) {
		if (record.status === "PENDING") {
			kept.push(record);
			continue;
		}
		const expired =
			now(context).getTime() - new Date(record.submittedAt).getTime() >
			OUTBOX_EXPIRY_MS;
		let inStep = true;
		let superseded = true;
		for (const entry of record.paths) {
			const local = await hashLocalFile(context.root, entry.path);
			const held = lock.files[entry.path];
			if (entry.op === "DELETE") {
				inStep &&= local === null && held === undefined;
				superseded &&= local !== null;
			} else {
				inStep &&= held !== undefined && local === held.contentHash;
				superseded &&= local !== entry.contentHash;
				// A pull request is done once the server holds what it sent.
				if (record.status === "PULL_REQUEST") {
					inStep &&= held?.contentHash === entry.contentHash;
				}
			}
		}
		// A problem about content the person has since changed says nothing
		// about the new content: the next push judges that on its own.
		const isProblem = record.status !== "PULL_REQUEST";
		if (expired || inStep || (isProblem && superseded)) {
			dropped.push(record);
		} else {
			kept.push(record);
		}
	}
	lock.outbox = kept;
	return dropped;
}

/** The outbox as a report reads it: what ended badly, what awaits a merge, what is in flight. */
export function summarise(lock: MemoryLock) {
	return {
		problems: lock.outbox.filter(
			(record) =>
				record.status === "CONFLICT" ||
				record.status === "REFUSED" ||
				record.status === "FAILED",
		),
		pullRequests: lock.outbox.filter(
			(record) => record.status === "PULL_REQUEST",
		),
		pending: lock.outbox.filter((record) => record.status === "PENDING")
			.length,
	};
}
