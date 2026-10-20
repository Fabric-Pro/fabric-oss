/**
 * What a pull or a push should do, decided from three things and nothing else:
 * what the server lists, what the working tree holds, and what the lock last
 * agreed on. Pure, so every case in the decision tables is a plain test.
 *
 * The rule that runs through both: a local edit is never lost. A pull never
 * overwrites or deletes a file whose bytes differ from the lock's, and a push
 * sends only the difference between the tree and the lock, naming the version
 * the lock holds so anybody else's change since is a conflict and not a
 * silent overwrite.
 */
import type { MemoryLock, MemoryLockEntry, OutboxRecord } from "./lock.js";

export interface RemoteFile {
	path: string;
	targetId: string;
	blobOid: string | null;
	contentHash: string | null;
	bytes: number;
}

export type KeepReason =
	/** The tree has edits the lock does not know of, and the server has a version too. */
	| "modified"
	/** A file is here that the mirror did not put here, and it differs from the server's. */
	| "untracked-differs"
	/** Deleted here, changed on the server since. */
	| "deleted-locally-changed-remotely"
	/** Edited here, removed from the server since: it becomes a new local file. */
	| "modified-and-removed";

export type PullAction =
	| { kind: "write"; file: RemoteFile; reason: "new" | "updated" }
	/** Local bytes already equal the server's: record it, write nothing. */
	| { kind: "adopt"; file: RemoteFile }
	| { kind: "delete"; path: string; expectedHash: string }
	| { kind: "forget"; path: string }
	| { kind: "keep"; path: string; reason: KeepReason }
	| { kind: "tracked"; path: string };

export interface PullInput {
	remote: readonly RemoteFile[];
	/** sha256 of each local file under the folders, by path. */
	local: ReadonlyMap<string, string>;
	lock: MemoryLock;
	/** Paths the developer's repository tracks: the mirror leaves those to git. */
	tracked: ReadonlySet<string>;
	/**
	 * Paths whose local version the person has chosen to give up for the
	 * server's, which for a path the server no longer lists means removing it.
	 * Only paths under the folders: the caller filters them.
	 */
	acceptRemote: ReadonlySet<string>;
}

function remoteDiffers(remote: RemoteFile, entry: MemoryLockEntry): boolean {
	return (
		remote.contentHash !== entry.contentHash ||
		(remote.blobOid !== null && remote.blobOid !== entry.blobOid)
	);
}

export function planPull(input: PullInput): PullAction[] {
	const actions: PullAction[] = [];
	const remotePaths = new Set<string>();
	for (const remote of input.remote) {
		remotePaths.add(remote.path);
		const path = remote.path;
		if (input.tracked.has(path)) {
			actions.push({ kind: "tracked", path });
			continue;
		}
		const local = input.local.get(path);
		const entry = input.lock.files[path];
		const accept = input.acceptRemote.has(path);
		if (entry === undefined) {
			if (local === undefined) {
				actions.push({ kind: "write", file: remote, reason: "new" });
			} else if (local === remote.contentHash) {
				actions.push({ kind: "adopt", file: remote });
			} else if (accept) {
				actions.push({
					kind: "write",
					file: remote,
					reason: "updated",
				});
			} else {
				actions.push({
					kind: "keep",
					path,
					reason: "untracked-differs",
				});
			}
			continue;
		}
		if (local === undefined) {
			if (!remoteDiffers(remote, entry)) {
				continue;
			}
			actions.push(
				accept
					? { kind: "write", file: remote, reason: "updated" }
					: {
							kind: "keep",
							path,
							reason: "deleted-locally-changed-remotely",
						},
			);
			continue;
		}
		if (local === entry.contentHash) {
			if (remote.contentHash === entry.contentHash) {
				if (
					remote.blobOid !== entry.blobOid ||
					entry.origin === "push"
				) {
					actions.push({ kind: "adopt", file: remote });
				}
			} else {
				actions.push({
					kind: "write",
					file: remote,
					reason: "updated",
				});
			}
			continue;
		}
		if (local === remote.contentHash) {
			actions.push({ kind: "adopt", file: remote });
		} else if (accept) {
			actions.push({ kind: "write", file: remote, reason: "updated" });
		} else {
			actions.push({ kind: "keep", path, reason: "modified" });
		}
	}

	for (const [path, entry] of Object.entries(input.lock.files)) {
		if (remotePaths.has(path)) {
			continue;
		}
		// A write this mirror committed that the server's listing does not show
		// yet: the sync has not read it. It stays until the listing catches up.
		if (entry.origin === "push") {
			continue;
		}
		const local = input.local.get(path);
		if (local === undefined) {
			actions.push({ kind: "forget", path });
		} else if (
			local === entry.contentHash ||
			input.acceptRemote.has(path)
		) {
			actions.push({ kind: "delete", path, expectedHash: local });
		} else {
			actions.push({
				kind: "keep",
				path,
				reason: "modified-and-removed",
			});
		}
	}
	// A file an earlier pull kept as new after the server removed it: taking the
	// server's version of it means removing it here too.
	for (const path of input.acceptRemote) {
		const local = input.local.get(path);
		if (
			local !== undefined &&
			!remotePaths.has(path) &&
			input.lock.files[path] === undefined &&
			!input.tracked.has(path)
		) {
			actions.push({ kind: "delete", path, expectedHash: local });
		}
	}
	return actions.sort((a, b) => {
		const left = actionPath(a);
		const right = actionPath(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

function actionPath(action: PullAction): string {
	return action.kind === "write" || action.kind === "adopt"
		? action.file.path
		: action.path;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export interface PushChange {
	path: string;
	targetId: string;
	kind: "new" | "modified" | "deleted";
	/** The blob the lock holds; absent for a new file. */
	ifMatchOid?: string;
	/** The content hash to send; absent for a delete. */
	contentHash?: string;
}

export type PushSkipReason =
	| "tracked"
	/** The lock holds no blob for this path yet, so there is no version to name. */
	| "version-unknown"
	/** Already sent, in a write that has not ended. */
	| "already-sent"
	/** A write with this content ended in a problem the person has not resolved. */
	| "unresolved-problem";

export interface PushPlan {
	changes: PushChange[];
	skipped: Array<{ path: string; reason: PushSkipReason }>;
}

interface PushTarget {
	id: string;
	folder: string;
}

export interface PushInput {
	targets: readonly PushTarget[];
	/** sha256 of each pushable local file, by path. */
	local: ReadonlyMap<string, string>;
	lock: MemoryLock;
	tracked: ReadonlySet<string>;
}

function targetOf(
	path: string,
	targets: readonly PushTarget[],
): PushTarget | undefined {
	return targets.find((target) => path.startsWith(`${target.folder}/`));
}

/** Is a write for this path and content already in the outbox, and in what state? */
function recordFor(
	outbox: readonly OutboxRecord[],
	path: string,
	contentHash: string | null,
): OutboxRecord | undefined {
	return outbox.find((record) =>
		record.paths.some(
			(entry) => entry.path === path && entry.contentHash === contentHash,
		),
	);
}

export function planPush(input: PushInput): PushPlan {
	const plan: PushPlan = { changes: [], skipped: [] };
	const consider = (change: PushChange, hash: string | null) => {
		const record = recordFor(input.lock.outbox, change.path, hash);
		if (record !== undefined) {
			if (
				record.status === "PENDING" ||
				record.status === "PULL_REQUEST"
			) {
				plan.skipped.push({
					path: change.path,
					reason: "already-sent",
				});
				return;
			}
			if (record.status !== "FAILED") {
				plan.skipped.push({
					path: change.path,
					reason: "unresolved-problem",
				});
				return;
			}
		}
		plan.changes.push(change);
	};

	for (const [path, hash] of input.local) {
		const target = targetOf(path, input.targets);
		if (target === undefined) {
			continue;
		}
		const entry = input.lock.files[path];
		if (input.tracked.has(path)) {
			plan.skipped.push({ path, reason: "tracked" });
			continue;
		}
		if (entry === undefined) {
			consider(
				{ path, targetId: target.id, kind: "new", contentHash: hash },
				hash,
			);
		} else if (entry.contentHash !== hash) {
			if (entry.blobOid === null) {
				plan.skipped.push({ path, reason: "version-unknown" });
				continue;
			}
			consider(
				{
					path,
					targetId: target.id,
					kind: "modified",
					ifMatchOid: entry.blobOid,
					contentHash: hash,
				},
				hash,
			);
		}
	}
	for (const [path, entry] of Object.entries(input.lock.files)) {
		if (input.local.has(path)) {
			continue;
		}
		const target = targetOf(path, input.targets);
		if (target === undefined) {
			continue;
		}
		if (entry.blobOid === null) {
			plan.skipped.push({ path, reason: "version-unknown" });
			continue;
		}
		consider(
			{
				path,
				targetId: target.id,
				kind: "deleted",
				ifMatchOid: entry.blobOid,
			},
			null,
		);
	}
	plan.changes.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	plan.skipped.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	return plan;
}
