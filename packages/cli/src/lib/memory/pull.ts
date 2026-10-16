/**
 * `fabric memory pull`: bring Living Memory's write folders into the working
 * tree, at their repository-relative paths.
 *
 * Settles the outbox first, so what an earlier push did is folded in before
 * the server's listing is compared with the tree. Then, for each folder: the
 * listing, the decisions of `planPull`, the files fetched and written, and the
 * lock. A file the developer edited is never overwritten or deleted, and a
 * path git tracks is left to git.
 */
import type { MemoryFolderFile, MemoryWriteTarget } from "@fabricorg/sdk";
import {
	deleteFileSafely,
	writeFileSafely,
} from "../instructions/safe-write.js";
import { aborted, inParallel, type MirrorContext } from "./context.js";
import { hashLocalFile, sha256Hex } from "./local.js";
import {
	emptyMemoryLock,
	type MemoryLock,
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
import {
	type KeepReason,
	type PullAction,
	planPull,
	type RemoteFile,
} from "./plan.js";
import { loadTargets } from "./targets.js";

const LISTING_PAGE = 500;

interface KeptFile {
	path: string;
	reason: KeepReason;
}

export interface PullResult {
	/** No write folders: nothing to mirror. */
	noFolders: boolean;
	written: string[];
	deleted: string[];
	kept: KeptFile[];
	trackedByGit: string[];
	settled: SettledWrite[];
	/** Writes that ended in a problem and are still waiting for the person. */
	problems: OutboxRecord[];
	pullRequests: OutboxRecord[];
	pending: number;
	/** The commit the server's listing reflects, per folder. */
	lastAppliedCommitSha: string | null;
}

async function listRemote(
	context: MirrorContext,
	target: MemoryWriteTarget,
): Promise<{ files: RemoteFile[]; commit: string | null }> {
	const files: RemoteFile[] = [];
	let after: string | undefined;
	let commit: string | null = null;
	for (;;) {
		aborted(context);
		const page = await context.client.memory.listFiles(context.projectId, {
			targetId: target.id,
			after,
			limit: LISTING_PAGE,
		});
		commit = page.lastAppliedCommitSha;
		for (const file of page.files) {
			files.push(toRemote(file, target.id));
		}
		if (page.nextCursor === null) {
			return { files, commit };
		}
		after = page.nextCursor;
	}
}

function toRemote(file: MemoryFolderFile, targetId: string): RemoteFile {
	return {
		path: file.path,
		targetId,
		blobOid: file.blobOid,
		contentHash: file.contentHash,
		bytes: file.bytes,
	};
}

export async function pull(
	context: MirrorContext,
	options: { acceptRemote?: readonly string[] } = {},
): Promise<PullResult> {
	const lock =
		(await readMemoryLock(context.root, context.projectId)) ??
		emptyMemoryLock(context.projectId);
	const settled = await settleOutbox(context, lock);

	const targets = await loadTargets(context, lock);
	const result: PullResult = {
		noFolders: targets.length === 0,
		written: [],
		deleted: [],
		kept: [],
		trackedByGit: [],
		settled,
		problems: [],
		pullRequests: [],
		pending: 0,
		lastAppliedCommitSha: null,
	};
	if (targets.length === 0) {
		await writeMemoryLock(context.root, lock);
		return { ...result, ...summarise(lock) };
	}

	const remote: RemoteFile[] = [];
	for (const target of targets) {
		const listed = await listRemote(context, target);
		remote.push(...listed.files);
		result.lastAppliedCommitSha ??= listed.commit;
	}
	const folders = targets.map((target) => target.folder);
	const tracked = (await context.git.tracked(folders)) ?? new Set<string>();

	// Hash only the files a decision depends on: what the server lists and what
	// the lock holds. Everything else under the folders is the person's.
	const local = new Map<string, string>();
	const relevant = new Set([
		...remote.map((file) => file.path),
		...Object.keys(lock.files),
	]);
	for (const file of relevant) {
		const hash = await hashLocalFile(context.root, file);
		if (hash !== null) {
			local.set(file, hash);
		}
	}

	const actions = planPull({
		remote,
		local,
		lock,
		tracked,
		acceptRemote: new Set(options.acceptRemote ?? []),
	});
	await applyPull(context, lock, actions, result);
	await resolveOutbox(context, lock);
	await writeMemoryLock(context.root, lock);
	await context.git.exclude([...folders, ".fabric"]).catch(() => undefined);
	return { ...result, ...summarise(lock) };
}

async function applyPull(
	context: MirrorContext,
	lock: MemoryLock,
	actions: readonly PullAction[],
	result: PullResult,
): Promise<void> {
	const writes = actions.filter(
		(action): action is Extract<PullAction, { kind: "write" }> =>
			action.kind === "write",
	);
	await inParallel(writes, async (action) => {
		aborted(context);
		const file = await context.client.memory.getFile(context.projectId, {
			targetId: action.file.targetId,
			path: action.file.path,
		});
		const bytes = new TextEncoder().encode(file.content);
		const hash = sha256Hex(bytes);
		if (file.contentHash !== null && hash !== file.contentHash) {
			throw new Error(
				`${file.path} did not match the hash the server listed for it, so it was not written.`,
			);
		}
		await writeFileSafely({
			root: context.root,
			relativePath: action.file.path,
			bytes,
		});
		lock.files[action.file.path] = {
			targetId: action.file.targetId,
			blobOid: file.blobOid ?? action.file.blobOid,
			contentHash: hash,
			origin: "pull",
		};
		result.written.push(action.file.path);
	});

	for (const action of actions) {
		switch (action.kind) {
			case "write":
				break;
			case "adopt":
				lock.files[action.file.path] = {
					targetId: action.file.targetId,
					blobOid: action.file.blobOid,
					contentHash:
						action.file.contentHash ??
						lock.files[action.file.path]?.contentHash ??
						"",
					origin: "pull",
				};
				break;
			case "delete": {
				const outcome = await deleteFileSafely(
					context.root,
					action.path,
					action.expectedHash,
				);
				if (outcome === "modified") {
					result.kept.push({ path: action.path, reason: "modified" });
				} else {
					delete lock.files[action.path];
					result.deleted.push(action.path);
				}
				break;
			}
			case "forget":
				delete lock.files[action.path];
				break;
			case "keep":
				result.kept.push({ path: action.path, reason: action.reason });
				if (action.reason === "modified-and-removed") {
					delete lock.files[action.path];
				}
				break;
			case "tracked":
				result.trackedByGit.push(action.path);
				break;
		}
	}
	result.written.sort();
}
