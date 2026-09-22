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
 */
import type {
	FabricClient,
	SyncedContextFileConflict,
	SyncedContextFileCurrentVersion,
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
import type { ContextPlan, ContextPushCandidate } from "./plan.js";

export type ContextPushResult =
	| {
			sourcePath: string;
			status: "created" | "updated" | "unchanged";
			contextId: string;
			contentHash: string;
			/**
			 * Present when `--force` replaced a version somebody else had
			 * changed: the version it replaced.
			 */
			overwrote?: SyncedContextFileCurrentVersion;
	  }
	| {
			sourcePath: string;
			status: "duplicate";
			contentHash: string;
			duplicateOfContextId: string;
			duplicateOfSourcePath: string | null;
	  }
	| {
			sourcePath: string;
			status: "conflict";
			contentHash: string;
			/** Whether this path was in the lock when it was sent. */
			wasLocked: boolean;
			/** True when this is the answer to the one `--force` resend. */
			afterForce: boolean;
			/** `null`: the version this folder named was deleted on the server. */
			current: SyncedContextFileCurrentVersion | null;
	  }
	| {
			sourcePath: string;
			/**
			 * The file no longer hashes to what the plan recorded (edited,
			 * deleted, or no longer text since). Not sent this run.
			 */
			status: "changed-during-run";
	  }
	| {
			sourcePath: string;
			status: "failed";
			error: string;
			/** The documented exit code this failure maps to. */
			exitCode: number;
	  };

export interface ContextPushRun {
	results: ContextPushResult[];
	/** A refusal that stopped the run before every file was sent. */
	stoppedBy: CliFailure | null;
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
	{ status: "created" | "updated" | "unchanged" | "duplicate" }
>;

function fromResult(
	sourcePath: string,
	result: SyncedContextFileResult,
): ServerAnswer {
	if (result.status === "duplicate") {
		return {
			sourcePath,
			status: "duplicate",
			contentHash: result.contentHash,
			duplicateOfContextId: result.duplicateOfContextId,
			duplicateOfSourcePath: result.duplicateOfSourcePath,
		};
	}
	return {
		sourcePath,
		status: result.status,
		contextId: result.contextId,
		contentHash: result.contentHash,
	};
}

export async function pushContextPlan(input: {
	client: FabricClient;
	projectId: string;
	org?: string;
	/** The folder the plan was made from (`resolveExistingRoot`). */
	root: string;
	plan: ContextPlan;
	force: boolean;
}): Promise<ContextPushRun> {
	const results: ContextPushResult[] = [];

	const send = (
		entry: ContextPushCandidate,
		content: string,
		expectedContentHash?: string,
	) =>
		input.client.contexts.upsertSyncedFile(
			input.projectId,
			{
				sourcePath: entry.sourcePath,
				content,
				...(expectedContentHash !== undefined
					? { expectedContentHash }
					: {}),
			},
			{ org: input.org },
		);

	for (const entry of input.plan.push) {
		try {
			const content = await readPlannedContent(input.root, entry);
			if (content === null) {
				results.push({
					sourcePath: entry.sourcePath,
					status: "changed-during-run",
				});
				continue;
			}
			try {
				results.push(
					fromResult(
						entry.sourcePath,
						await send(entry, content, entry.expectedContentHash),
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
				if (
					!input.force ||
					(current !== null && current.contentHash === null)
				) {
					results.push({
						sourcePath: entry.sourcePath,
						status: "conflict",
						contentHash: conflict.contentHash,
						wasLocked: entry.expectedContentHash !== undefined,
						afterForce: false,
						current,
					});
					continue;
				}
				// Read the file again: it may have been saved while the first
				// request was out, and a resend that names the server's version
				// must not replace it with content the folder no longer holds.
				const forcedContent = await readPlannedContent(
					input.root,
					entry,
				);
				if (forcedContent === null) {
					results.push({
						sourcePath: entry.sourcePath,
						status: "changed-during-run",
					});
					continue;
				}
				try {
					const forced = fromResult(
						entry.sourcePath,
						await send(
							entry,
							forcedContent,
							current === null
								? undefined
								: (current.contentHash ?? undefined),
						),
					);
					// Only a replace overwrote anything. `unchanged` means the
					// server already held this very content by then, and a
					// recreate replaced nothing.
					results.push(
						forced.status === "updated" && current !== null
							? { ...forced, overwrote: current }
							: forced,
					);
				} catch (retryError) {
					const again = conflictOf(retryError);
					if (again === null) {
						throw retryError;
					}
					results.push({
						sourcePath: entry.sourcePath,
						status: "conflict",
						contentHash: again.contentHash,
						wasLocked: entry.expectedContentHash !== undefined,
						afterForce: true,
						current: again.current,
					});
				}
			}
		} catch (error) {
			const failure = asCliFailure(error);
			if (stopsTheRun(error)) {
				return { results, stoppedBy: failure };
			}
			results.push({
				sourcePath: entry.sourcePath,
				status: "failed",
				error: describeError(error),
				exitCode: failure.exitCode,
			});
		}
	}
	return { results, stoppedBy: null };
}

/**
 * The lock after these results, or `null` when it would say nothing new.
 *
 * Starts from the previous ledger, so paths that were not sent this time —
 * unchanged locally, removed locally, skipped, conflicting, changed during
 * the run, failed — keep exactly the entry they had. What the server
 * confirmed moves; a duplicate is recorded as one; a `forgotten` duplicate
 * (its file gone, and the server never stored its path) is dropped.
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
	for (const sourcePath of input.forgotten ?? []) {
		if (sourcePath in files) {
			delete files[sourcePath];
			changed = true;
		}
	}
	for (const result of input.results) {
		if (result.status === "duplicate") {
			const before = files[result.sourcePath];
			if (
				before?.state === "duplicate" &&
				before.sha256 === result.contentHash
			) {
				continue;
			}
			files[result.sourcePath] = {
				sha256: result.contentHash,
				state: "duplicate",
			};
			changed = true;
			continue;
		}
		if (
			result.status !== "created" &&
			result.status !== "updated" &&
			result.status !== "unchanged"
		) {
			continue;
		}
		const before = files[result.sourcePath];
		if (
			before?.state === undefined &&
			before?.sha256 === result.contentHash &&
			before.contextId === result.contextId
		) {
			continue;
		}
		files[result.sourcePath] = {
			sha256: result.contentHash,
			contextId: result.contextId,
		};
		changed = true;
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
