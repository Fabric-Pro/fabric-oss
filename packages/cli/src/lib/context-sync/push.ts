/**
 * Sending a context plan, one file per request, and what the lock learns
 * from the answers.
 *
 * Sequential and in sorted path order: the report reads in the order things
 * happened, and a folder of notes gains nothing from racing its own requests
 * against the server's per-key rate limit.
 *
 * Outcomes per file:
 *
 *   created | updated | unchanged   the server holds this content now —
 *                                   recorded in the lock
 *   duplicate                       the path is new and identical content is
 *                                   already stored under another path —
 *                                   nothing stored; recorded as a duplicate
 *                                   (hash, no row), so it is not re-sent
 *                                   until it changes
 *   conflict                        the path holds a version this folder did
 *                                   not name, or the version it named was
 *                                   deleted on the server — nothing written,
 *                                   the lock entry left exactly as it was
 *   changed-during-run              the file no longer hashes to what was
 *                                   planned — not sent, lock entry untouched;
 *                                   the next run picks the new content up
 *   failed                          this request failed; the others still go
 *
 * Each file is read again, through the guarded reader, immediately before
 * its request: the plan keeps hashes, not contents, so a folder is never held
 * in memory at once, and what is sent is exactly what was planned.
 *
 * `--force` answers a conflict by sending the same content again, once,
 * naming the version the conflict reported — or, when the named version was
 * deleted on the server, naming none, which recreates the file unless that
 * content already exists elsewhere in the project (then the answer is
 * `duplicate`). If that is a conflict too — somebody changed it again in
 * between — it is reported as one. There is no third attempt: `--force`
 * means "replace the version you just told me about", never "win whatever
 * happens". The file is read again before the resend too, so a file saved
 * while the first request was out is `changed-during-run`, not resent.
 *
 * A refusal that would repeat for every file — the key is invalid, lacks
 * `projects:write`, its owner lost the permission, the project is not
 * there, the rate limit, a server that cannot be reached — stops the run
 * rather than failing every remaining file with the same sentence.
 *
 * ## Moves and `--prune` (Fizzy #2636)
 *
 * Moves go first, each one request: the new path, naming the old one as
 * `movedFromSourcePath` and the lock's hash for it as the version. `moved`
 * moves the lock entry. Any other answer records the new path as a push
 * would, and says why the server did not rename: only `source-missing` (the
 * old path has no row) drops the old entry — otherwise the old row is still
 * there, and the old path is a plain removal. A conflict about the old path
 * leaves both entries and sends nothing else for the pair; `--force` resends
 * the move once naming the old path's current version (a move never
 * replaces content, so that stores this folder's version at the new path and
 * keeps the old row), or, when the old row is gone, pushes the new path as a
 * new file.
 *
 * Then the pushes, and LAST, only with `--prune`, the deletions: every
 * removed path, and every old path a move left in place, deleted by
 * `deleteSyncedFile` naming the lock's hash. `deleted` and `absent` drop the
 * entry; a conflict (the file changed on the server since) keeps it, and
 * `--force` resends once naming the version the conflict reported.
 * `in-progress` (the server's deletion has not finished answering) keeps the
 * entry too, since the file may or may not be gone yet: the next `--prune`
 * names the same version and confirms. It is never forced. A run stopped
 * early deletes nothing it had not reached.
 */
import type {
	FabricClient,
	SyncedContextFileConflict,
	SyncedContextFileCurrentVersion,
	SyncedContextFileMoveNotAppliedReason,
	SyncedContextFileResult,
} from "@fabricorg/sdk";
import {
	asCliFailure,
	type CliFailure,
	describeError,
} from "../command-boundary.js";
import { readFileSafely } from "../instructions/safe-write.js";
import {
	classifyContextBytes,
	hashContextContent,
	MAX_CONTEXT_FILE_BYTES,
} from "./classify.js";
import type { ContextLock } from "./lock.js";
import { CONTEXT_LOCK_VERSION } from "./lock.js";
import type {
	ContextMoveCandidate,
	ContextPlan,
	ContextPushCandidate,
} from "./plan.js";

/** On every result of a planned move, but `moved` itself (Fizzy #2636). */
interface MoveFields {
	/** The lock path the file moved from, when this result is a move's. */
	movedFrom?: string;
	/**
	 * Why the server did not rename it, when it answered without renaming.
	 * Only `source-missing` means the old path has no row any more.
	 */
	moveNotApplied?: SyncedContextFileMoveNotAppliedReason;
}

export type ContextPushResult =
	| ({
			sourcePath: string;
			status: "created" | "updated" | "unchanged";
			contextId: string;
			contentHash: string;
			/**
			 * Present when `--force` replaced a version somebody else had
			 * changed: the version it replaced.
			 */
			overwrote?: SyncedContextFileCurrentVersion;
	  } & MoveFields)
	| {
			/** The new path; the row that was at `movedFrom` is here now. */
			sourcePath: string;
			status: "moved";
			movedFrom: string;
			contextId: string;
			contentHash: string;
	  }
	| ({
			sourcePath: string;
			status: "duplicate";
			contentHash: string;
			duplicateOfContextId: string;
			duplicateOfSourcePath: string | null;
	  } & MoveFields)
	| ({
			sourcePath: string;
			status: "conflict";
			contentHash: string;
			/**
			 * Whether this path was in the lock when it was sent — for a move
			 * whose old path changed, whether the conflict is about that old
			 * path (which the lock names).
			 */
			wasLocked: boolean;
			/** True when this is the answer to the one `--force` resend. */
			afterForce: boolean;
			/** `null`: the version this folder named was deleted on the server. */
			current: SyncedContextFileCurrentVersion | null;
	  } & MoveFields)
	| {
			/**
			 * The new path of a move the server could not apply because it
			 * does not support moves: a server from before Fizzy #2636
			 * ignores `movedFromSourcePath` and answers the new path as an
			 * ordinary push naming a version it never had. Nothing was
			 * stored, nothing more is sent (even with `--force`), and the old
			 * path's lock entry stays, so the move is tried again next run.
			 */
			sourcePath: string;
			status: "move-unsupported";
			movedFrom: string;
	  }
	| ({
			sourcePath: string;
			/**
			 * The file no longer hashes to what the plan recorded (edited,
			 * deleted, or no longer text since). Not sent this run.
			 */
			status: "changed-during-run";
	  } & MoveFields)
	| ({
			sourcePath: string;
			status: "failed";
			error: string;
			/** The documented exit code this failure maps to. */
			exitCode: number;
	  } & MoveFields)
	// --prune: a removed path's server entry.
	| {
			sourcePath: string;
			status: "deleted";
			contextId: string;
			/** The hash of the version deleted. */
			contentHash: string;
			/** Present when `--force` deleted a version somebody else changed. */
			overwrote?: SyncedContextFileCurrentVersion;
	  }
	| {
			/** The server had no row at this path: dropped from the lock. */
			sourcePath: string;
			status: "already-gone";
	  }
	| {
			/**
			 * The server's deletion is still running: the file may or may not
			 * be gone yet. The lock entry is kept, so the next `--prune`
			 * confirms it. Counted as not deleted.
			 */
			sourcePath: string;
			status: "delete-in-progress";
	  }
	| {
			/** Changed on the server since the last push: not deleted. */
			sourcePath: string;
			status: "delete-conflict";
			afterForce: boolean;
			current: SyncedContextFileCurrentVersion;
	  }
	| {
			sourcePath: string;
			status: "delete-failed";
			error: string;
			exitCode: number;
	  };

/** The statuses a `--prune` deletion ends in. */
export const DELETE_STATUSES: ReadonlySet<ContextPushResult["status"]> =
	new Set([
		"deleted",
		"already-gone",
		"delete-in-progress",
		"delete-conflict",
		"delete-failed",
	]);

export interface ContextPushRun {
	results: ContextPushResult[];
	/** A refusal that stopped the run before every file was sent. */
	stoppedBy: CliFailure | null;
	/**
	 * With `--prune`, every path it set out to delete, in order: the removed
	 * paths and the old paths moves left in place, each with a lock entry
	 * naming a stored version. Set even when a refusal stopped the run before
	 * the deletions began, so a summary can count what was never tried as
	 * not deleted.
	 */
	pruneTargets: string[];
}

/** HTTP statuses that are about the key or the project, not the file. */
const RUN_LEVEL_STATUSES = new Set([401, 403, 404, 429]);

/**
 * Failures with no HTTP answer at all, after the client's own retries: the
 * server is unreachable or not answering, and the next file would say so too.
 */
const RUN_LEVEL_CODES = new Set(["NETWORK_ERROR", "TIMEOUT"]);

function stopsTheRun(error: unknown): boolean {
	const { status, code } = error as { status?: unknown; code?: unknown };
	return (
		(typeof status === "number" && RUN_LEVEL_STATUSES.has(status)) ||
		(typeof code === "string" && RUN_LEVEL_CODES.has(code))
	);
}

/**
 * The conflict payload, from the SDK's typed error. Read by shape rather than
 * by `instanceof`, so a second copy of the SDK in a dependency tree cannot
 * turn a conflict into a generic failure.
 */
function conflictOf(error: unknown): SyncedContextFileConflict | null {
	if (typeof error !== "object" || error === null) {
		return null;
	}
	const conflict = (error as { conflict?: unknown }).conflict;
	if (
		typeof conflict === "object" &&
		conflict !== null &&
		(conflict as { status?: unknown }).status === "conflict" &&
		"current" in conflict &&
		// An object, or `null` for a named version deleted on the server.
		typeof (conflict as { current?: unknown }).current === "object"
	) {
		return conflict as SyncedContextFileConflict;
	}
	return null;
}

/**
 * The file's text as it is now, or `null` when it is no longer what the plan
 * hashed — the same guarded read, classification and hash the plan used, so
 * a file edited, deleted or turned binary since is never sent under the
 * plan's hash.
 */
async function readPlannedContent(
	root: string,
	entry: ContextPushCandidate,
): Promise<string | null> {
	const read = await readFileSafely(root, entry.diskPath, {
		maxBytes: MAX_CONTEXT_FILE_BYTES,
	}).catch((error: unknown) => {
		if (error instanceof Error && /too large/.test(error.message)) {
			return null;
		}
		throw error;
	});
	if (read === null) {
		return null;
	}
	const verdict = classifyContextBytes(read.bytes);
	if (!verdict.ok || hashContextContent(verdict.content) !== entry.sha256) {
		return null;
	}
	return verdict.content;
}

type ServerAnswer = Extract<
	ContextPushResult,
	{ status: "created" | "updated" | "unchanged" | "duplicate" | "moved" }
>;

/**
 * A push's answer as a result. For a move's, `movedFrom` is the lock's old
 * path and `moveNotApplied` the server's reason when it did not rename.
 */
function fromResult(
	sourcePath: string,
	result: SyncedContextFileResult,
	movedFrom?: string,
): ServerAnswer {
	if (result.status === "moved") {
		return {
			sourcePath,
			status: "moved",
			movedFrom: movedFrom ?? result.movedFromSourcePath,
			contextId: result.contextId,
			contentHash: result.contentHash,
		};
	}
	const move: MoveFields =
		movedFrom === undefined
			? {}
			: {
					movedFrom,
					...(result.moveNotApplied
						? { moveNotApplied: result.moveNotApplied.reason }
						: {}),
				};
	if (result.status === "duplicate") {
		return {
			sourcePath,
			status: "duplicate",
			contentHash: result.contentHash,
			duplicateOfContextId: result.duplicateOfContextId,
			duplicateOfSourcePath: result.duplicateOfSourcePath,
			...move,
		};
	}
	return {
		sourcePath,
		status: result.status,
		contextId: result.contextId,
		contentHash: result.contentHash,
		...move,
	};
}

/**
 * Whether a move's result leaves its old path as a plain removal: the server
 * answered without renaming, and did not say the old row is gone.
 */
function moveKeptOldPath(result: ContextPushResult): string | null {
	if (
		(result.status === "created" ||
			result.status === "updated" ||
			result.status === "unchanged" ||
			result.status === "duplicate") &&
		result.movedFrom !== undefined &&
		result.moveNotApplied !== "source-missing"
	) {
		return result.movedFrom;
	}
	return null;
}

export async function pushContextPlan(input: {
	client: FabricClient;
	projectId: string;
	org?: string;
	/** The folder the plan was made from (`resolveExistingRoot`). */
	root: string;
	plan: ContextPlan;
	force: boolean;
	/** Delete removed paths' server entries (Fizzy #2636). */
	prune?: boolean;
	/** The lock the plan was made against: the versions `--prune` names. */
	lock?: ContextLock | null;
}): Promise<ContextPushRun> {
	const results: ContextPushResult[] = [];
	const pruneTargets: string[] = [];
	const { force } = input;

	const send = (
		sourcePath: string,
		content: string,
		expectedContentHash?: string,
		movedFromSourcePath?: string,
	) =>
		input.client.contexts.upsertSyncedFile(
			input.projectId,
			{
				sourcePath,
				content,
				...(expectedContentHash !== undefined
					? { expectedContentHash }
					: {}),
				...(movedFromSourcePath !== undefined
					? { movedFromSourcePath }
					: {}),
			},
			{ org: input.org },
		);

	/** One file's push, with the one `--force` resend a conflict allows. */
	const pushEntry = async (
		entry: ContextPushCandidate,
	): Promise<ContextPushResult> => {
		const content = await readPlannedContent(input.root, entry);
		if (content === null) {
			return {
				sourcePath: entry.sourcePath,
				status: "changed-during-run",
			};
		}
		try {
			return fromResult(
				entry.sourcePath,
				await send(
					entry.sourcePath,
					content,
					entry.expectedContentHash,
				),
			);
		} catch (error) {
			const conflict = conflictOf(error);
			if (conflict === null) {
				throw error;
			}
			const { current } = conflict;
			// No hash on the stored row means no version a push can name,
			// so `--force` has nothing to replace it with. A deleted one
			// (`current: null`) is resent naming no version at all, which
			// recreates it or answers `duplicate`.
			if (!force || (current !== null && current.contentHash === null)) {
				return {
					sourcePath: entry.sourcePath,
					status: "conflict",
					contentHash: conflict.contentHash,
					wasLocked: entry.expectedContentHash !== undefined,
					afterForce: false,
					current,
				};
			}
			// Read the file again: it may have been saved while the first
			// request was out, and a resend that names the server's version
			// must not replace it with content the folder no longer holds.
			const forcedContent = await readPlannedContent(input.root, entry);
			if (forcedContent === null) {
				return {
					sourcePath: entry.sourcePath,
					status: "changed-during-run",
				};
			}
			try {
				const forced = fromResult(
					entry.sourcePath,
					await send(
						entry.sourcePath,
						forcedContent,
						current === null
							? undefined
							: (current.contentHash ?? undefined),
					),
				);
				// Only a replace overwrote anything. `unchanged` means the
				// server already held this very content by then, and a
				// recreate replaced nothing.
				return forced.status === "updated" && current !== null
					? { ...forced, overwrote: current }
					: forced;
			} catch (retryError) {
				const again = conflictOf(retryError);
				if (again === null) {
					throw retryError;
				}
				return {
					sourcePath: entry.sourcePath,
					status: "conflict",
					contentHash: again.contentHash,
					wasLocked: entry.expectedContentHash !== undefined,
					afterForce: true,
					current: again.current,
				};
			}
		}
	};

	/** One move: the new path, naming the old one and the lock's version. */
	const pushMove = async (
		move: ContextMoveCandidate,
	): Promise<ContextPushResult> => {
		const entry: ContextPushCandidate = {
			sourcePath: move.to,
			diskPath: move.diskPath,
			sha256: move.sha256,
			bytes: move.bytes,
		};
		const moveFields = { movedFrom: move.from };
		const content = await readPlannedContent(input.root, entry);
		if (content === null) {
			return {
				sourcePath: move.to,
				status: "changed-during-run",
				...moveFields,
			};
		}
		const asConflict = (
			conflict: SyncedContextFileConflict,
			afterForce: boolean,
		): ContextPushResult => ({
			sourcePath: move.to,
			status: "conflict",
			contentHash: conflict.contentHash,
			// About the old path (which the lock names) or the new one.
			wasLocked: conflict.moveNotApplied?.reason === "source-changed",
			afterForce,
			current: conflict.current,
			...moveFields,
			...(conflict.moveNotApplied
				? { moveNotApplied: conflict.moveNotApplied.reason }
				: {}),
		});
		try {
			return fromResult(
				move.to,
				await send(move.to, content, move.sha256, move.from),
				move.from,
			);
		} catch (error) {
			const conflict = conflictOf(error);
			if (conflict === null) {
				throw error;
			}
			const { current } = conflict;
			// A server that supports moves says why on every answer to a move
			// that is not a rename, and never answers one with `current:
			// null` without a reason. That shape is a server from before
			// moves: it ignored the old path and answered the new one as a
			// push naming a version it never had. Nothing is stored, and
			// `--force` must not turn the move into a new copy.
			if (current === null && conflict.moveNotApplied === undefined) {
				return {
					sourcePath: move.to,
					status: "move-unsupported",
					movedFrom: move.from,
				};
			}
			if (!force || (current !== null && current.contentHash === null)) {
				return asConflict(conflict, false);
			}
			const forcedContent = await readPlannedContent(input.root, entry);
			if (forcedContent === null) {
				return {
					sourcePath: move.to,
					status: "changed-during-run",
					...moveFields,
				};
			}
			const aboutOldPath =
				conflict.moveNotApplied?.reason === "source-changed";
			try {
				if (aboutOldPath && current === null) {
					// The old row is gone: the new path is a new file, and
					// the old entry has nothing left to name.
					const created = fromResult(
						move.to,
						await send(move.to, forcedContent),
					);
					return created.status === "moved"
						? created
						: {
								...created,
								...moveFields,
								moveNotApplied: "source-missing",
							};
				}
				if (aboutOldPath) {
					// Resend the move naming the old path's current version.
					return fromResult(
						move.to,
						await send(
							move.to,
							forcedContent,
							current?.contentHash ?? undefined,
							move.from,
						),
						move.from,
					);
				}
				// The new path's own row holds other content: replace that
				// version, as `--force` does for any push; the old row stays.
				const forced = fromResult(
					move.to,
					await send(
						move.to,
						forcedContent,
						current?.contentHash ?? undefined,
					),
				);
				if (forced.status === "moved") {
					return forced;
				}
				return {
					...(forced.status === "updated" && current !== null
						? { ...forced, overwrote: current }
						: forced),
					...moveFields,
					...(conflict.moveNotApplied
						? { moveNotApplied: conflict.moveNotApplied.reason }
						: {}),
				};
			} catch (retryError) {
				const again = conflictOf(retryError);
				if (again === null) {
					throw retryError;
				}
				if (again.moveNotApplied !== undefined) {
					return asConflict(again, true);
				}
				// A resend of the move answers for itself. The other two
				// resends are not moves, so the server says nothing about the
				// old path; what the first answer established still holds.
				const reason:
					| SyncedContextFileMoveNotAppliedReason
					| undefined = aboutOldPath
					? current === null
						? "source-missing"
						: undefined
					: conflict.moveNotApplied?.reason;
				return asConflict(
					reason === undefined
						? again
						: {
								...again,
								moveNotApplied: {
									movedFromSourcePath: move.from,
									reason,
								},
							},
					true,
				);
			}
		}
	};

	/** One removed path's server entry, only in the lock's version. */
	const deleteEntry = async (
		sourcePath: string,
		sha256: string,
	): Promise<ContextPushResult> => {
		const remove = (expectedContentHash: string) =>
			input.client.contexts.deleteSyncedFile(
				input.projectId,
				{ sourcePath, expectedContentHash },
				{ org: input.org },
			);
		const fromAnswer = (
			answer: Awaited<ReturnType<typeof remove>>,
			overwrote?: SyncedContextFileCurrentVersion,
		): ContextPushResult => {
			switch (answer.status) {
				case "deleted":
					return {
						sourcePath,
						status: "deleted",
						contextId: answer.contextId,
						contentHash: answer.contentHash,
						...(overwrote ? { overwrote } : {}),
					};
				case "absent":
					return { sourcePath, status: "already-gone" };
				case "in-progress":
					// Not a conflict, so never resent: the next run confirms.
					return { sourcePath, status: "delete-in-progress" };
			}
		};
		try {
			return fromAnswer(await remove(sha256));
		} catch (error) {
			const conflict = conflictOf(error);
			if (conflict === null || conflict.current === null) {
				throw error;
			}
			const { current } = conflict;
			if (!force || current.contentHash === null) {
				return {
					sourcePath,
					status: "delete-conflict",
					afterForce: false,
					current,
				};
			}
			try {
				return fromAnswer(await remove(current.contentHash), current);
			} catch (retryError) {
				const again = conflictOf(retryError);
				if (again === null || again.current === null) {
					throw retryError;
				}
				return {
					sourcePath,
					status: "delete-conflict",
					afterForce: true,
					current: again.current,
				};
			}
		}
	};

	/**
	 * Run one step. A failure that would repeat for every file stops the run
	 * (returned); any other is this step's own result.
	 */
	const step = async (
		run: () => Promise<ContextPushResult>,
		failed: (error: unknown, exitCode: number) => ContextPushResult,
	): Promise<CliFailure | null> => {
		try {
			results.push(await run());
			return null;
		} catch (error) {
			const failure = asCliFailure(error);
			if (stopsTheRun(error)) {
				return failure;
			}
			results.push(failed(error, failure.exitCode));
			return null;
		}
	};

	/**
	 * What `--prune` sets out to delete, given the results so far: the removed
	 * paths and the old paths moves left in place, each with a lock entry
	 * naming a stored version (a duplicate's path was never stored).
	 */
	const pruneTargetsSoFar = (): string[] => {
		const keptByMoves = results
			.map(moveKeptOldPath)
			.filter((path): path is string => path !== null);
		return [...new Set([...input.plan.removed, ...keptByMoves])]
			.filter((path) => {
				const locked = input.lock?.files[path];
				return locked !== undefined && locked.state !== "duplicate";
			})
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	};

	const stopped = (stoppedBy: CliFailure): ContextPushRun => {
		// Stopped before the deletions began: they were all still to do.
		if (input.prune && pruneTargets.length === 0) {
			pruneTargets.push(...pruneTargetsSoFar());
		}
		return { results, stoppedBy, pruneTargets };
	};

	for (const move of input.plan.moves) {
		const stoppedBy = await step(
			() => pushMove(move),
			(error, exitCode) => ({
				sourcePath: move.to,
				status: "failed",
				error: describeError(error),
				exitCode,
				movedFrom: move.from,
			}),
		);
		if (stoppedBy) {
			return stopped(stoppedBy);
		}
	}

	for (const entry of input.plan.push) {
		const stoppedBy = await step(
			() => pushEntry(entry),
			(error, exitCode) => ({
				sourcePath: entry.sourcePath,
				status: "failed",
				error: describeError(error),
				exitCode,
			}),
		);
		if (stoppedBy) {
			return stopped(stoppedBy);
		}
	}

	if (input.prune) {
		pruneTargets.push(...pruneTargetsSoFar());
		for (const sourcePath of pruneTargets) {
			const locked = input.lock?.files[sourcePath];
			if (!locked || locked.state === "duplicate") {
				continue;
			}
			const stoppedBy = await step(
				() => deleteEntry(sourcePath, locked.sha256),
				(error, exitCode) => ({
					sourcePath,
					status: "delete-failed",
					error: describeError(error),
					exitCode,
				}),
			);
			if (stoppedBy) {
				return stopped(stoppedBy);
			}
		}
	}

	return { results, stoppedBy: null, pruneTargets };
}

/**
 * The lock after these results, or `null` when it would say nothing new.
 *
 * Starts from the previous ledger, so paths that were not sent this time —
 * unchanged locally, removed locally (without `--prune`), skipped,
 * conflicting, changed during the run, failed — keep exactly the entry they
 * had. What the server confirmed moves; a duplicate is recorded as one; a
 * `forgotten` duplicate (its file gone, and the server never stored its path)
 * is dropped. A `moved` result moves its entry to the new path; a move the
 * server answered otherwise records the new path and drops the old one only
 * when the server said it has no row there — including when the new path's
 * answer was a conflict, which records nothing for the new path but still
 * says the old one is gone, so the same move is not planned again. A
 * `--prune` deletion that happened, or found nothing to delete, drops its
 * entry; one still running on the server keeps it.
 */
export function nextContextLock(input: {
	previous: ContextLock | null;
	projectId: string;
	results: readonly ContextPushResult[];
	forgotten?: readonly string[];
	now: Date;
}): ContextLock | null {
	const files = { ...(input.previous?.files ?? {}) };
	let changed = false;
	const drop = (sourcePath: string) => {
		if (sourcePath in files) {
			delete files[sourcePath];
			changed = true;
		}
	};
	const confirm = (sourcePath: string, sha256: string, contextId: string) => {
		const before = files[sourcePath];
		if (
			before?.state === undefined &&
			before?.sha256 === sha256 &&
			before.contextId === contextId
		) {
			return;
		}
		files[sourcePath] = { sha256, contextId };
		changed = true;
	};

	for (const sourcePath of input.forgotten ?? []) {
		drop(sourcePath);
	}
	for (const result of input.results) {
		switch (result.status) {
			case "deleted":
			case "already-gone":
				drop(result.sourcePath);
				break;
			case "delete-in-progress":
				// Maybe gone, maybe not: keep the entry, so the next --prune
				// names the same version and hears `deleted` or `absent`.
				break;
			case "moved":
				drop(result.movedFrom);
				confirm(
					result.sourcePath,
					result.contentHash,
					result.contextId,
				);
				break;
			case "duplicate": {
				const before = files[result.sourcePath];
				if (
					before?.state !== "duplicate" ||
					before.sha256 !== result.contentHash
				) {
					files[result.sourcePath] = {
						sha256: result.contentHash,
						state: "duplicate",
					};
					changed = true;
				}
				if (
					result.moveNotApplied === "source-missing" &&
					result.movedFrom
				) {
					drop(result.movedFrom);
				}
				break;
			}
			case "created":
			case "updated":
			case "unchanged":
				confirm(
					result.sourcePath,
					result.contentHash,
					result.contextId,
				);
				if (
					result.moveNotApplied === "source-missing" &&
					result.movedFrom
				) {
					drop(result.movedFrom);
				}
				break;
			case "conflict":
				// Nothing was stored at the new path, so it stays unrecorded;
				// the old path's entry goes when the server has no row there.
				if (
					result.moveNotApplied === "source-missing" &&
					result.movedFrom
				) {
					drop(result.movedFrom);
				}
				break;
			default:
				break;
		}
	}
	if (!changed) {
		return null;
	}
	return {
		version: CONTEXT_LOCK_VERSION,
		projectId: input.projectId,
		pushedAt: input.now.toISOString(),
		files,
	};
}
