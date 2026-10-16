/**
 * `fabric memory push`: send what changed in the write folders to Fabric.
 *
 * The difference between the tree and the lock, one write per folder (and per
 * fifty files), each naming the blob the lock holds so anybody's change since
 * is a conflict and never an overwrite. The write is submitted, not awaited: the
 * outbox remembers it, and the next pull or status folds in how it ended.
 * Files the server would refuse (not text, too large) are reported instead of
 * sent, so one cannot block the rest.
 */

import { randomBytes } from "node:crypto";
import {
	FabricError,
	type MemoryWriteEntry,
	type MemoryWriteMode,
	type MemoryWriteRefusalData,
	type MemoryWriteTarget,
} from "@fabricorg/sdk";
import { gitBlobOid } from "../git-blob.js";
import { aborted, inParallel, type MirrorContext, now } from "./context.js";
import { readLocalFile, scanFolder, sha256Hex } from "./local.js";
import {
	emptyMemoryLock,
	type MemoryLock,
	type OutboxRecord,
	readMemoryLock,
	writeMemoryLock,
} from "./lock.js";
import { resolveOutbox, type SettledWrite, settleOutbox } from "./outbox.js";
import { type PushChange, type PushSkipReason, planPush } from "./plan.js";
import { loadTargets } from "./targets.js";

/** Entries one write may carry: the server's own bound. */
const MAX_ENTRIES_PER_WRITE = 50;

/** Inline text may fill 3 MiB of a request; staging starts below that so the JSON around it fits. */
const INLINE_BYTES_LIMIT = 2.5 * 1024 * 1024;

/** The refusals that mean the folders changed under the lock's copy of them. */
const STALE_TARGET = /^TARGET_(NOT_FOUND|STALE)$/;

/** A byte-order mark is part of the file: the server hashes the string it receives. */
const TEXT_KEEPING_BOM = new TextDecoder("utf-8", { ignoreBOM: true });

interface SentWrite {
	writeId: string;
	folder: string;
	mode: MemoryWriteMode;
	fileCount: number;
	deduplicated: boolean;
}

export interface PushResult {
	noFolders: boolean;
	sent: SentWrite[];
	skipped: Array<{ path: string; reason: PushSkipReason | string }>;
	/** Writes the server did not take, with its words. */
	refused: Array<{ folder: string; problems: string[] }>;
	/** More changes than fit in the writes allowed at once: run push again. */
	remaining: number;
	/** The server asked to wait: too many writes are pending. */
	busy: boolean;
	settled: SettledWrite[];
}

function describeProblem(problem: {
	path?: string;
	code: string;
	detail?: string;
}): string {
	return `${problem.path ?? "the write"}: ${problem.code}${problem.detail ? ` (${problem.detail})` : ""}`;
}

/** A staged upload: the signed URL takes the bytes, the write names the staged file. */
async function stageBytes(
	context: MirrorContext,
	files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
): Promise<Map<string, { stagedKey: string; bytes: number; sha256: string }>> {
	const urls = await context.client.memory.createUploadUrls(
		context.projectId,
		files.map((file) => ({ bytes: file.bytes.byteLength })),
	);
	const staged = new Map<
		string,
		{ stagedKey: string; bytes: number; sha256: string }
	>();
	const fetchImpl = context.fetchImpl ?? fetch;
	await inParallel(
		files.map((file, index) => ({ file, upload: urls.uploads[index] })),
		async ({ file, upload }) => {
			if (upload === undefined) {
				throw new Error(
					"The server returned fewer upload URLs than files.",
				);
			}
			aborted(context);
			const response = await fetchImpl(upload.url, {
				method: "PUT",
				headers: { "content-type": upload.contentType },
				body: file.bytes as BodyInit,
				signal: context.signal,
			});
			if (!response.ok) {
				throw new Error(
					`Staging ${file.path} failed with HTTP ${response.status}.`,
				);
			}
			staged.set(file.path, {
				stagedKey: upload.stagedKey,
				bytes: file.bytes.byteLength,
				sha256: sha256Hex(file.bytes),
			});
		},
	);
	return staged;
}

function defaultMessage(count: number, date: Date): string {
	const day = date.toISOString().slice(0, 10);
	return `Update project memory (${count} file${count === 1 ? "" : "s"}, ${day})`;
}

export async function push(
	context: MirrorContext,
	options: { message?: string; cached?: boolean } = {},
): Promise<PushResult> {
	const first = await pushOnce(context, options);
	// The folders the lock remembered moved since: ask again, once.
	const stale = first.refused.some((refusal) =>
		refusal.problems.some((problem) =>
			/TARGET_(NOT_FOUND|STALE)/.test(problem),
		),
	);
	return options.cached && stale
		? pushOnce(context, { ...options, cached: false })
		: first;
}

async function pushOnce(
	context: MirrorContext,
	options: { message?: string; cached?: boolean },
): Promise<PushResult> {
	const lock =
		(await readMemoryLock(context.root, context.projectId)) ??
		emptyMemoryLock(context.projectId);
	const settled = await settleOutbox(context, lock);
	await resolveOutbox(context, lock);

	const targets = await loadTargets(context, lock, {
		cached: options.cached,
	});
	const result: PushResult = {
		noFolders: targets.length === 0,
		sent: [],
		skipped: [],
		refused: [],
		remaining: 0,
		busy: false,
		settled,
	};
	if (targets.length === 0) {
		await writeMemoryLock(context.root, lock);
		return result;
	}

	const folders = targets.map((target) => target.folder);
	const tracked = (await context.git.tracked(folders)) ?? new Set<string>();
	const local = new Map<string, string>();
	const contents = new Map<string, Uint8Array>();
	for (const target of targets) {
		const scan = await scanFolder(context.root, target.folder);
		for (const skipped of scan.skipped) {
			result.skipped.push({ path: skipped.path, reason: skipped.reason });
		}
		for (const file of scan.files) {
			const read = await readLocalFile(context.root, file.path);
			if (read.ok) {
				local.set(file.path, read.file.hash);
				contents.set(file.path, read.file.bytes);
			} else if (lock.files[file.path] === undefined) {
				result.skipped.push({ path: file.path, reason: read.reason });
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
	for (const skipped of plan.skipped) {
		result.skipped.push(skipped);
	}

	const byTarget = new Map<string, PushChange[]>();
	for (const change of plan.changes) {
		byTarget.set(change.targetId, [
			...(byTarget.get(change.targetId) ?? []),
			change,
		]);
	}
	let submissions = 0;
	for (const target of targets) {
		const changes = byTarget.get(target.id) ?? [];
		for (
			let start = 0;
			start < changes.length;
			start += MAX_ENTRIES_PER_WRITE
		) {
			if (result.busy) {
				result.remaining += changes.length - start;
				break;
			}
			aborted(context);
			const batch = changes.slice(start, start + MAX_ENTRIES_PER_WRITE);
			const outcome = await submitBatch(
				context,
				lock,
				target,
				batch,
				contents,
				options.message,
			);
			submissions++;
			if (outcome.kind === "sent") {
				result.sent.push(outcome.sent);
				if (outcome.refusedProblems !== undefined) {
					result.refused.push({
						folder: target.folder,
						problems: outcome.refusedProblems,
					});
				}
			} else if (outcome.kind === "refused") {
				result.refused.push({
					folder: target.folder,
					problems: outcome.problems,
				});
			} else if (outcome.kind === "busy") {
				result.busy = true;
				result.remaining += batch.length;
			}
			await writeMemoryLock(context.root, lock);
		}
	}
	if (submissions === 0) {
		await writeMemoryLock(context.root, lock);
	}
	await context.git.exclude([...folders, ".fabric"]).catch(() => undefined);
	return result;
}

type BatchOutcome =
	| { kind: "sent"; sent: SentWrite; refusedProblems?: string[] }
	| { kind: "refused"; problems: string[] }
	| { kind: "busy" }
	| { kind: "nothing" };

/**
 * A write the server refused is kept in the outbox like any other problem: it
 * stays in every report, and the same content is not sent again, until the
 * files change or the person dismisses it.
 */
function recordRefusal(
	context: MirrorContext,
	lock: MemoryLock,
	target: MemoryWriteTarget,
	changes: readonly PushChange[],
	contents: ReadonlyMap<string, Uint8Array>,
	problems: ReadonlyArray<{ path?: string; code: string }>,
): void {
	const first = problems[0]?.code ?? "REFUSED";
	lock.outbox = [
		...lock.outbox,
		{
			writeId: `refused-${randomBytes(6).toString("hex")}`,
			targetId: target.id,
			folder: target.folder,
			submittedAt: now(context).toISOString(),
			status: "REFUSED",
			detail: first,
			paths: changes.map((change) => {
				const bytes = contents.get(change.path);
				const problem = problems.find(
					(entry) => entry.path === change.path,
				);
				return {
					path: change.path,
					op: change.kind === "deleted" ? "DELETE" : "PUT",
					contentHash: bytes === undefined ? null : sha256Hex(bytes),
					newBlobOid: null,
					...(problem === undefined
						? {}
						: { verdict: { code: problem.code } }),
				};
			}),
		},
	];
}

async function submitBatch(
	context: MirrorContext,
	lock: MemoryLock,
	target: MemoryWriteTarget,
	batch: readonly PushChange[],
	contents: ReadonlyMap<string, Uint8Array>,
	message: string | undefined,
	excluded: ReadonlySet<string> = new Set(),
): Promise<BatchOutcome> {
	const changes = batch.filter((change) => !excluded.has(change.path));
	if (changes.length === 0) {
		return { kind: "nothing" };
	}
	const puts = changes.filter((change) => change.kind !== "deleted");
	const files = puts.map((change) => ({
		path: change.path,
		bytes: contents.get(change.path) as Uint8Array,
	}));
	const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
	const staged =
		total > INLINE_BYTES_LIMIT ? await stageBytes(context, files) : null;

	const entries: MemoryWriteEntry[] = changes.map((change) => {
		if (change.kind === "deleted") {
			return {
				path: change.path,
				op: "DELETE",
				ifMatchOid: change.ifMatchOid,
			};
		}
		const bytes = contents.get(change.path) as Uint8Array;
		const base = {
			path: change.path,
			op: "PUT" as const,
			...(change.ifMatchOid === undefined
				? {}
				: { ifMatchOid: change.ifMatchOid }),
		};
		const stagedFile = staged?.get(change.path);
		return stagedFile === undefined
			? { ...base, content: TEXT_KEEPING_BOM.decode(bytes) }
			: { ...base, ...stagedFile };
	});

	try {
		const submitted = await context.client.memory.submitWrite(
			context.projectId,
			{
				targetId: target.id,
				message:
					message ?? defaultMessage(changes.length, now(context)),
				entries,
			},
		);
		const record: OutboxRecord = {
			writeId: submitted.writeId,
			targetId: target.id,
			folder: target.folder,
			submittedAt: now(context).toISOString(),
			status: "PENDING",
			paths: changes.map((change) => {
				const bytes = contents.get(change.path);
				return {
					path: change.path,
					op: change.kind === "deleted" ? "DELETE" : "PUT",
					contentHash: bytes === undefined ? null : sha256Hex(bytes),
					newBlobOid: bytes === undefined ? null : gitBlobOid(bytes),
				};
			}),
		};
		lock.outbox = [
			...lock.outbox.filter(
				(existing) => existing.writeId !== record.writeId,
			),
			record,
		];
		return {
			kind: "sent",
			sent: {
				writeId: submitted.writeId,
				folder: target.folder,
				mode: target.mode,
				fileCount: changes.length,
				deduplicated: submitted.deduplicated,
			},
		};
	} catch (error) {
		if (error instanceof FabricError && error.status === 429) {
			return { kind: "busy" };
		}
		if (error instanceof FabricError && error.status === 400) {
			const data = (error.data ?? {}) as MemoryWriteRefusalData;
			const problems = data.problems ?? [];
			const badPaths = new Set(
				problems.flatMap((problem) =>
					problem.path === undefined ? [] : [problem.path],
				),
			);
			const described =
				problems.length > 0
					? problems.map(describeProblem)
					: [error.message];
			// Problems about particular files: send the others, and say which stayed.
			if (
				badPaths.size > 0 &&
				problems.every((problem) => problem.path !== undefined) &&
				excluded.size === 0 &&
				badPaths.size < changes.length
			) {
				recordRefusal(
					context,
					lock,
					target,
					changes.filter((change) => badPaths.has(change.path)),
					contents,
					problems,
				);
				const retried = await submitBatch(
					context,
					lock,
					target,
					changes,
					contents,
					message,
					badPaths,
				);
				return retried.kind === "sent"
					? { ...retried, refusedProblems: described }
					: { kind: "refused", problems: described };
			}
			// A folder that moved is not the files' fault: nothing to keep, and the
			// caller asks for the folders again.
			if (!problems.some((problem) => STALE_TARGET.test(problem.code))) {
				recordRefusal(
					context,
					lock,
					target,
					changes,
					contents,
					problems,
				);
			}
			return { kind: "refused", problems: described };
		}
		throw error;
	}
}
