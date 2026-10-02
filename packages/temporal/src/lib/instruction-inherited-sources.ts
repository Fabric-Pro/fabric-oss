/**
 * The inherited half of a derived snapshot's checks: which inherited rows may
 * be trusted, which of those were already cleared by the current scan rule
 * set, and how their bytes reach this snapshot's own prefix without a
 * download.
 *
 * An inherited row (`inheritedFromFileId`) stands for a file of a READY
 * snapshot whose bytes were hashed when that snapshot was promoted and live at
 * an IMMUTABLE key: nothing signs a write to a promoted key
 * (`create-upload-urls.ts` signs staging keys only). That is what makes a
 * server-side copy safe for such a row, where it stays forbidden for a staging
 * key, which the client can overwrite while its signed PUT lives.
 *
 * The source is validated from the SOURCE row, never from the derived
 * snapshot's `baseSnapshotId`, a `SetNull` column the retention prune can
 * clear. Not an activities module: every export of one becomes an activity.
 */
import {
	type InheritedInstructionSource,
	type InstructionRejection,
	isAcceptableInheritedSource,
	listInheritedInstructionSources,
	moveInheritedInstructionFileKeys,
} from "@repo/database";
import { FABRIC_IGNORE_FILE, snapshotKey } from "@repo/instructions";
import { INSTRUCTION_SCAN_RULES_VERSION } from "@repo/instructions/scan-rules-version";
import type { StorageProviderInterface } from "@repo/storage";

/** Copies run with their own width: they hold no buffers, unlike a download. */
export const COPY_CONCURRENCY = 32;

/** Rows moved per bulk key write. */
export const KEY_UPDATE_CHUNK = 500;

type SnapshotScope = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
};

type InheritedRow = {
	id: string;
	path: string;
	size: number;
	sha256: string;
	storageKey: string;
	inheritedFromFileId?: string | null;
};

export type InheritedSources = ReadonlyMap<string, InheritedInstructionSource>;

/** The sources of every inherited row among `files`, in one query. */
export function loadInheritedSources(
	scope: SnapshotScope,
	files: ReadonlyArray<Pick<InheritedRow, "inheritedFromFileId">>,
): Promise<InheritedSources> {
	return listInheritedInstructionSources({
		projectId: scope.projectId,
		organizationId: scope.organizationId,
		sourceFileIds: files.flatMap((f) =>
			f.inheritedFromFileId ? [f.inheritedFromFileId] : [],
		),
	});
}

/**
 * Where an inherited row's bytes are, and whether they were already cleared.
 *
 * `null` means the row is not waiting on a source: it is not inherited, or it
 * already sits at its own promoted key (a retry of a promotion that moved it),
 * and the caller treats it like any other row. Anything else that does not
 * pass `isAcceptableInheritedSource` is the existing `missing` rejection.
 */
export function resolveInheritedFile(
	scope: SnapshotScope,
	file: InheritedRow,
	sources: InheritedSources,
):
	| { rejection: InstructionRejection }
	| { key: string; cleared: boolean }
	| null {
	if (
		!file.inheritedFromFileId ||
		file.storageKey ===
			snapshotKey(scope.projectId, scope.snapshotId, file.id)
	) {
		return null;
	}
	const source = sources.get(file.inheritedFromFileId);
	if (
		source === undefined ||
		source.snapshotId === scope.snapshotId ||
		!isAcceptableInheritedSource(
			source,
			file,
			snapshotKey(scope.projectId, source.snapshotId, source.id),
		)
	) {
		return { rejection: { path: file.path, reason: "missing" } };
	}
	return {
		key: file.storageKey,
		cleared: source.scanRulesVersion === INSTRUCTION_SCAN_RULES_VERSION,
	};
}

/**
 * The ids of the rows whose bytes need no read: inherited from a source that
 * the CURRENT scan rule set cleared, with the same bytes, and still at the
 * source's key or already at this snapshot's own.
 *
 * The root `.fabricignore` is never in it: its provenance check needs its
 * text. A source cleared under an older rule set, or never cleared (published
 * before its scan, or the scan found something), is not in it either, so
 * those files get the full read and scan.
 */
export function clearedInheritedIds(
	scope: SnapshotScope,
	files: readonly InheritedRow[],
	sources: InheritedSources,
): Set<string> {
	const cleared = new Set<string>();
	for (const file of files) {
		if (!file.inheritedFromFileId || file.path === FABRIC_IGNORE_FILE) {
			continue;
		}
		const source = sources.get(file.inheritedFromFileId);
		if (
			source === undefined ||
			source.snapshotId === scope.snapshotId ||
			source.scanRulesVersion !== INSTRUCTION_SCAN_RULES_VERSION
		) {
			continue;
		}
		const sourceKey = snapshotKey(
			scope.projectId,
			source.snapshotId,
			source.id,
		);
		const ownKey = snapshotKey(scope.projectId, scope.snapshotId, file.id);
		if (
			(file.storageKey === sourceKey || file.storageKey === ownKey) &&
			isAcceptableInheritedSource(
				source,
				{ ...file, storageKey: sourceKey },
				sourceKey,
			)
		) {
			cleared.add(file.id);
		}
	}
	return cleared;
}

/**
 * Runs `fn` over `items` with at most `width` in flight. On the first error no
 * further item starts, every started one is awaited, and the first error is
 * thrown, so a retry never overlaps a straggler.
 */
async function runPool<T>(
	items: readonly T[],
	width: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	const queue = items.values();
	const errors: unknown[] = [];
	const worker = async (): Promise<void> => {
		while (errors.length === 0) {
			const next = queue.next();
			if (next.done) {
				return;
			}
			try {
				await fn(next.value);
			} catch (error) {
				errors.push(error);
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(width, items.length) }, () => worker()),
	);
	if (errors.length > 0) {
		throw errors[0];
	}
}

/**
 * Copies each inherited file's source object onto this snapshot's own
 * promoted key, server-side, then moves the rows there in bulk.
 *
 * Per chunk of `KEY_UPDATE_CHUNK` rows: the copies, then ONE conditional key
 * write for the ones that landed. The write only matches a row still holding
 * its source key, so a retry is idempotent, and a copy onto an existing
 * destination is harmless. A copy that throws is told apart by a HEAD of the
 * source: gone is the `missing` rejection, anything else is an
 * infrastructure error that propagates so Temporal retries.
 *
 * `onChunk` receives how many files are decided so far (copied or rejected).
 */
export async function copyInheritedFiles(input: {
	storage: StorageProviderInterface;
	bucket: string;
	scope: SnapshotScope;
	files: ReadonlyArray<{ id: string; path: string; sourceKey: string }>;
	onChunk?: (decided: number) => Promise<void> | void;
}): Promise<{ rejections: InstructionRejection[]; copied: number }> {
	const { storage, bucket, scope } = input;
	const rejections: InstructionRejection[] = [];
	let copied = 0;
	for (let i = 0; i < input.files.length; i += KEY_UPDATE_CHUNK) {
		const chunk = input.files.slice(i, i + KEY_UPDATE_CHUNK);
		const moves: Array<{ fileId: string; from: string; to: string }> = [];
		await runPool(chunk, COPY_CONCURRENCY, async (file) => {
			const to = snapshotKey(scope.projectId, scope.snapshotId, file.id);
			try {
				await storage.copyFile(file.sourceKey, to, { bucket });
			} catch (error) {
				const head = await storage.getFileMetadata(file.sourceKey, {
					bucket,
				});
				if (head === null) {
					rejections.push({ path: file.path, reason: "missing" });
					return;
				}
				throw error;
			}
			moves.push({ fileId: file.id, from: file.sourceKey, to });
		});
		await moveInheritedInstructionFileKeys({
			snapshotId: scope.snapshotId,
			projectId: scope.projectId,
			organizationId: scope.organizationId,
			moves,
		});
		copied += moves.length;
		await input.onChunk?.(copied + rejections.length);
	}
	return { rejections, copied };
}
