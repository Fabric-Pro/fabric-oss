/**
 * Admitting a Living Memory write (ADR-022): everything `submit` decides before
 * the workflow starts, on the REAL bytes.
 *
 * A write names each file it puts in one of two ways: inline text, or a file
 * the caller staged (its key, size and SHA-256), uploaded straight to storage
 * through a signed URL (`createUploadUrls`). Staged files are read back and
 * must be exactly the file named; inline text is bounded in total, so a request
 * body stays small. The contents are then judged together with the rest of the
 * request (`evaluateMemoryWrite`: the mode, the sync, the target, every path,
 * the bytes, the secret scan, the headroom), and every problem is reported,
 * not the first. Nothing is stored for a request that is not admitted.
 *
 * Only then is anything written: inline text is staged by the server under a
 * key no URL was ever signed for, so the workflow ALWAYS reads from storage and
 * its payload carries only keys; and the receipt is stored with its entries
 * (`submitMemoryWrite`), under the member's lock on the project. An identical
 * request already in flight or landed returns its receipt, and a member with
 * too many writes pending is refused. Bytes staged for a request that ends in
 * neither a new receipt nor a failure are removed again.
 */
import {
	type MemoryWriteStatus,
	type MemoryWriteVia,
	submitMemoryWrite,
} from "@repo/database";
import type {
	MemoryWriteEntryInput,
	MemoryWriteProblem,
} from "@repo/temporal/memory-write/evaluate";
import {
	deleteStagedBytes,
	isMemoryWriteStagingKeyOf,
	readStagedBytes,
	stageInlineBytes,
} from "@repo/temporal/memory-write/staging";
import {
	MEMORY_WRITE_DEDUPE_WINDOW_MS,
	MEMORY_WRITE_MAX_PENDING,
	MEMORY_WRITE_PENDING_WINDOW_MS,
} from "@repo/temporal/memory-write-types";
import { judgeMemoryWrite } from "./validate-memory-write";

/** Inline text may fill at most this much of one request: a body past it is for the staged route. */
export const MAX_INLINE_BYTES_PER_REQUEST = 3 * 1024 * 1024;

/** All the bytes of one request, inline and staged: what one sync run may read (50 MiB). */
const MAX_REQUEST_BYTES = 50 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The text a staged file stands for until it is read back, and for good when
 * it cannot be: a problem of its own is already reported for it, and a benign
 * placeholder keeps the evaluator from adding "content required" to it.
 */
const UNREAD = "x";

/** One path of a `submit` request, as the caller sent it. */
export type SubmitEntryInput = {
	path: string;
	op: "PUT" | "DELETE";
	ifMatchOid?: string;
	/** Inline UTF-8 text; PUT only. */
	content?: string;
	/** A staged file's key, size and SHA-256; PUT only, all three or none. */
	stagedKey?: string;
	bytes?: number;
	sha256?: string;
};

export type AdmitMemoryWriteResult =
	| { kind: "refused"; problems: MemoryWriteProblem[] }
	| { kind: "too-many-pending"; limit: number }
	| {
			kind: "admitted";
			writeId: string;
			status: MemoryWriteStatus;
			digest: string;
			/** An identical request already had this receipt. */
			deduplicated: boolean;
			target: { id: string; folder: string; mode: string };
	  };

type Resolved = {
	entries: MemoryWriteEntryInput[];
	problems: MemoryWriteProblem[];
	/** Staged files, by path, as the caller named them and the server verified them. */
	staged: Map<string, { stagedKey: string; bytes: number; sha256: string }>;
};

/**
 * Turns each PUT into the text it writes, whichever way the caller named it,
 * and collects the problems that are about the bytes rather than the request's
 * rules. A DELETE carries no content, so one that names any (inline or staged)
 * is handed on with an empty text, for the evaluator to refuse it as it refuses
 * any DELETE with content.
 */
async function resolveEntries(
	projectId: string,
	input: readonly SubmitEntryInput[],
): Promise<Resolved> {
	const entries: MemoryWriteEntryInput[] = [];
	const problems: MemoryWriteProblem[] = [];
	const staged: Resolved["staged"] = new Map();
	let declaredBytes = 0;
	for (const entry of input) {
		const { path, op, ifMatchOid } = entry;
		const named =
			entry.stagedKey !== undefined ||
			entry.sha256 !== undefined ||
			entry.bytes !== undefined;
		if (op === "DELETE") {
			entries.push({
				path,
				op,
				ifMatchOid,
				...(entry.content !== undefined || named
					? { content: "" }
					: {}),
			});
			continue;
		}
		if (!named) {
			entries.push({ path, op, ifMatchOid, content: entry.content });
			declaredBytes += Buffer.byteLength(entry.content ?? "", "utf8");
			continue;
		}
		if (entry.content !== undefined) {
			problems.push({ path, code: "CONTENT_AMBIGUOUS" });
			entries.push({ path, op, ifMatchOid, content: entry.content });
			continue;
		}
		const { stagedKey, bytes, sha256 } = entry;
		if (
			stagedKey === undefined ||
			bytes === undefined ||
			sha256 === undefined
		) {
			problems.push({
				path,
				code: "STAGED_OBJECT_INVALID",
				detail: "incomplete",
			});
			entries.push({ path, op, ifMatchOid, content: UNREAD });
			continue;
		}
		if (!isMemoryWriteStagingKeyOf(projectId, stagedKey)) {
			problems.push({
				path,
				code: "STAGED_OBJECT_INVALID",
				detail: "key",
			});
			entries.push({ path, op, ifMatchOid, content: UNREAD });
			continue;
		}
		if (!SHA256_HEX.test(sha256)) {
			problems.push({
				path,
				code: "STAGED_OBJECT_INVALID",
				detail: "sha256",
			});
			entries.push({ path, op, ifMatchOid, content: UNREAD });
			continue;
		}
		declaredBytes += bytes;
		staged.set(path, { stagedKey, bytes, sha256 });
		entries.push({ path, op, ifMatchOid, content: UNREAD });
	}

	if (declaredBytes > MAX_REQUEST_BYTES) {
		problems.push({ code: "REQUEST_TOO_LARGE" });
		return { entries, problems, staged: new Map() };
	}
	// Reading a staged file is the expensive part: only requests whose bytes fit.
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	for (const [path, file] of staged) {
		const read = await readStagedBytes({
			key: file.stagedKey,
			bytes: file.bytes,
			sha256: file.sha256,
		});
		const index = entries.findIndex((entry) => entry.path === path);
		if (!read.ok) {
			problems.push({
				path,
				code:
					read.reason === "missing"
						? "STAGED_OBJECT_MISSING"
						: "STAGED_OBJECT_MISMATCH",
				detail: read.reason,
			});
			staged.delete(path);
			continue;
		}
		let content: string;
		try {
			content = decoder.decode(read.bytes);
		} catch {
			// Not UTF-8: a NUL stands for it, which the evaluator refuses as binary
			// (`CONTENT_NOT_TEXT`), the same verdict a binary file gets inline.
			content = "\u0000";
		}
		const target = entries[index];
		if (target) {
			target.content = content;
		}
	}
	return { entries, problems, staged };
}

/** Removes staged bytes this request put there and did not end up owning. Best effort. */
async function discardStaged(keys: readonly string[]): Promise<void> {
	try {
		await deleteStagedBytes(keys);
	} catch {
		// A leftover object is not a failed request.
	}
}

export async function admitMemoryWrite(input: {
	projectId: string;
	organizationId: string;
	userId: string;
	via: MemoryWriteVia;
	oauthClientId: string | null;
	targetId: string;
	message: string;
	entries: readonly SubmitEntryInput[];
}): Promise<AdmitMemoryWriteResult> {
	const inlineBytes = input.entries.reduce(
		(total, entry) =>
			entry.op === "PUT" && entry.stagedKey === undefined
				? total + Buffer.byteLength(entry.content ?? "", "utf8")
				: total,
		0,
	);
	const resolved =
		inlineBytes > MAX_INLINE_BYTES_PER_REQUEST
			? null
			: await resolveEntries(input.projectId, input.entries);
	if (resolved === null) {
		return {
			kind: "refused",
			problems: [
				{
					code: "REQUEST_TOO_LARGE",
					detail: "inline",
				},
			],
		};
	}

	const { validation, repositoryIntegrationId } = await judgeMemoryWrite({
		projectId: input.projectId,
		organizationId: input.organizationId,
		targetId: input.targetId,
		message: input.message,
		entries: resolved.entries,
	});
	const problems = [...resolved.problems, ...validation.problems];
	const { digest, target } = validation;
	if (
		problems.length > 0 ||
		digest === null ||
		target === null ||
		repositoryIntegrationId === null
	) {
		return { kind: "refused", problems };
	}

	// Admitted: inline text is staged now, once, under keys of the server's own.
	const staged = new Map(resolved.staged);
	const ownKeys: string[] = [];
	try {
		for (const entry of resolved.entries) {
			if (
				entry.op === "PUT" &&
				entry.content !== undefined &&
				!staged.has(entry.path)
			) {
				const stored = await stageInlineBytes({
					projectId: input.projectId,
					bytes: Buffer.from(entry.content, "utf8"),
				});
				ownKeys.push(stored.stagedKey);
				staged.set(entry.path, stored);
			}
		}
		const result = await submitMemoryWrite({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			via: input.via,
			oauthClientId: input.oauthClientId,
			target: {
				id: target.id,
				version: target.version,
				folder: target.folder,
				mode: target.mode,
				ref: target.ref,
				repositoryIntegrationId,
			},
			message: input.message,
			digest,
			entries: resolved.entries.map((entry) => {
				const file = staged.get(entry.path);
				return {
					path: entry.path,
					op: entry.op,
					ifMatchOid: entry.ifMatchOid ?? null,
					stagedKey: file?.stagedKey ?? null,
					bytes: file?.bytes ?? null,
					sha256: file?.sha256 ?? null,
				};
			}),
			dedupeWindowMs: MEMORY_WRITE_DEDUPE_WINDOW_MS,
			pendingWindowMs: MEMORY_WRITE_PENDING_WINDOW_MS,
			maxPending: MEMORY_WRITE_MAX_PENDING,
		});
		if (result.kind === "created") {
			return {
				kind: "admitted",
				writeId: result.write.id,
				status: "PENDING",
				digest: result.write.digest,
				deduplicated: false,
				target: {
					id: target.id,
					folder: target.folder,
					mode: target.mode,
				},
			};
		}
		await discardStaged(ownKeys);
		if (result.kind === "too-many-pending") {
			return {
				kind: "too-many-pending",
				limit: MEMORY_WRITE_MAX_PENDING,
			};
		}
		return {
			kind: "admitted",
			writeId: result.write.id,
			status: result.write.status,
			digest: result.write.digest,
			deduplicated: true,
			target: { id: target.id, folder: target.folder, mode: target.mode },
		};
	} catch (error) {
		await discardStaged(ownKeys);
		throw error;
	}
}
