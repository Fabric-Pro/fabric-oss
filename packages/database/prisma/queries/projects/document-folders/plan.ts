/**
 * The reconciliation plan: what one listing does to a folder's ledger,
 * without touching the database.
 */

import {
	DOCUMENT_FOLDER_FILE_STATUS,
	DOCUMENT_FOLDER_IMPORT_CAP,
	DOCUMENT_FOLDER_SKIP_CODE,
	type DocumentFolderFileStatus,
	type DocumentFolderSkipCode,
	MISSES_BEFORE_LOOKUP,
	READS_BEFORE_REFRESH,
} from "./constants";
import { classifyDocumentFolderFile } from "./helpers";

/** One file in a listing, as the Graph tree read reports it. */
export interface DocumentFolderListedFile {
	driveItemId: string;
	name: string;
	/** Path below the connected folder, ending in the name. */
	relativePath: string;
	size: number | null;
	mimeType: string | null;
	/** ISO time the file last changed at the source. */
	lastModified: string | null;
	/** `quickXorHash:<hash>`, or `size:<n>|modified:<iso>` without a hash. */
	contentVersion: string;
}

/** A ledger row as reconciliation reads it. */
export interface DocumentFolderLedgerRow {
	id: string;
	driveItemId: string;
	name: string;
	relativePath: string;
	size: number | null;
	sourceModifiedAt: Date | null;
	status: DocumentFolderFileStatus;
	skipCode: string | null;
	contextId: string | null;
	importedVersion: string | null;
	latestVersion: string | null;
	latestVersionSeenCount: number;
	excludedVersion: string | null;
	missCount: number;
	retiredAt: Date | null;
}

export interface DocumentFolderRowPatch {
	name?: string;
	relativePath?: string;
	size?: number | null;
	sourceModifiedAt?: Date | null;
	status?: DocumentFolderFileStatus;
	skipCode?: string | null;
	failureCode?: string | null;
	contextId?: null;
	excludedVersion?: string | null;
	latestVersion?: string;
	latestVersionSeenCount?: number;
	retiredAt?: null;
	missCount?: number;
}

export interface DocumentFolderReconcilePlan {
	inserts: Array<{
		driveItemId: string;
		name: string;
		relativePath: string;
		size: number | null;
		sourceModifiedAt: Date | null;
		status: "PENDING" | "SKIPPED";
		skipCode: DocumentFolderSkipCode | null;
		latestVersion: string;
	}>;
	/** Row changes, each conditional on the status the plan read. */
	updates: Array<{
		id: string;
		fromStatus: DocumentFolderFileStatus;
		fromRetired: boolean;
		data: DocumentFolderRowPatch;
		/** Save this context's own guidance on the row before it is deleted. */
		saveGuidanceFromContextId: string | null;
	}>;
	/** Imported contexts whose file was renamed or moved within the folder. */
	renamedContexts: Array<{
		contextId: string;
		name: string;
		relativePath: string;
	}>;
	/** Rows the listing contained. */
	seenIds: string[];
	/** Complete listings only: seen rows whose miss count goes back to 0. */
	resetMissIds: string[];
	/** Complete listings only: unretired rows the listing did not contain. */
	missedIds: string[];
	/** Rows missing from two consecutive complete listings, to look up. */
	candidates: Array<{ fileId: string; driveItemId: string }>;
	counts: {
		inserted: number;
		renamed: number;
		refreshQueued: number;
		excluded: number;
		returnedToPending: number;
		capSkipped: number;
		missed: number;
	};
}

export const EMPTY_COUNTS: DocumentFolderReconcilePlan["counts"] = {
	inserted: 0,
	renamed: 0,
	refreshQueued: 0,
	excluded: 0,
	returnedToPending: 0,
	capSkipped: 0,
	missed: 0,
};

/** Statuses that hold a place in the import window. */
function inWindowState(status: string, skipCode: string | null): boolean {
	return !(
		status === DOCUMENT_FOLDER_FILE_STATUS.SKIPPED &&
		skipCode !== DOCUMENT_FOLDER_SKIP_CODE.CAP_REACHED
	);
}

function toDate(iso: string | null): Date | null {
	if (!iso) {
		return null;
	}
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : date;
}

interface WindowEntry {
	driveItemId: string;
	modified: number;
	/** The file's status after this pass's other changes. */
	get: () => {
		status: string;
		skipCode: string | null;
		contextId: string | null;
	};
	set: (
		status: DocumentFolderFileStatus,
		skipCode: string | null,
		saveGuidance: boolean,
	) => void;
	/** Entered the window this pass: new, or back from a skip or retirement. */
	entering: boolean;
}

/**
 * What one listing does to a folder's ledger, without touching the database.
 *
 * Every listing records new files, renames and moves, content versions, hand
 * removals and versions that bring a file back. Only a complete listing moves
 * the import window and counts misses, because a partial one cannot tell a
 * missing file from one it did not reach.
 */
export function planDocumentFolderReconcile(params: {
	rows: DocumentFolderLedgerRow[];
	files: DocumentFolderListedFile[];
	complete: boolean;
	/** Which of the rows' contexts still exist. */
	liveContextIds: ReadonlySet<string>;
	importCap?: number;
}): DocumentFolderReconcilePlan {
	const cap = params.importCap ?? DOCUMENT_FOLDER_IMPORT_CAP;
	const S = DOCUMENT_FOLDER_FILE_STATUS;
	const result: DocumentFolderReconcilePlan = {
		inserts: [],
		updates: [],
		renamedContexts: [],
		seenIds: [],
		resetMissIds: [],
		missedIds: [],
		candidates: [],
		counts: { ...EMPTY_COUNTS },
	};
	const byItem = new Map(params.rows.map((row) => [row.driveItemId, row]));
	const seenItems = new Set<string>();
	const window: WindowEntry[] = [];
	const updates = new Map<
		string,
		DocumentFolderReconcilePlan["updates"][number]
	>();

	for (const file of params.files) {
		if (seenItems.has(file.driveItemId)) {
			continue;
		}
		seenItems.add(file.driveItemId);
		const modifiedAt = toDate(file.lastModified);
		const modified = modifiedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
		const version = file.contentVersion;
		const existing = byItem.get(file.driveItemId);

		if (!existing) {
			const classified = classifyDocumentFolderFile(file);
			const insert: DocumentFolderReconcilePlan["inserts"][number] = {
				driveItemId: file.driveItemId,
				name: file.name,
				relativePath: file.relativePath,
				size: file.size,
				sourceModifiedAt: modifiedAt,
				status: classified.status,
				skipCode: classified.skipCode,
				latestVersion: version,
			};
			result.inserts.push(insert);
			result.counts.inserted++;
			if (classified.status === S.PENDING) {
				window.push({
					driveItemId: file.driveItemId,
					modified,
					entering: true,
					get: () => ({
						status: insert.status,
						skipCode: insert.skipCode,
						contextId: null,
					}),
					set: (status, skipCode) => {
						insert.status = status as "PENDING" | "SKIPPED";
						insert.skipCode =
							skipCode as DocumentFolderSkipCode | null;
					},
				});
			}
			continue;
		}

		const row = existing;
		result.seenIds.push(row.id);
		const data: DocumentFolderRowPatch = {};
		let saveGuidance: string | null = null;
		let status: DocumentFolderFileStatus = row.status;
		let skipCode = row.skipCode;
		let contextId = row.contextId;
		let retired = row.retiredAt !== null;
		let entering = false;

		if (file.name !== row.name || file.relativePath !== row.relativePath) {
			data.name = file.name;
			data.relativePath = file.relativePath;
			result.counts.renamed++;
			if (row.contextId && !retired) {
				result.renamedContexts.push({
					contextId: row.contextId,
					name: file.name,
					relativePath: file.relativePath,
				});
			}
		}
		if (file.size !== row.size) {
			data.size = file.size;
		}
		if (
			(modifiedAt?.getTime() ?? null) !==
			(row.sourceModifiedAt?.getTime() ?? null)
		) {
			data.sourceModifiedAt = modifiedAt;
		}

		const newVersion = version !== row.latestVersion;
		let seen = row.latestVersionSeenCount;
		if (newVersion) {
			seen = 1;
			data.latestVersion = version;
			data.latestVersionSeenCount = 1;
		} else if (
			(row.status === S.IMPORTED || row.status === S.FAILED) &&
			row.importedVersion !== version
		) {
			seen = row.latestVersionSeenCount + 1;
			data.latestVersionSeenCount = seen;
		}
		const changedAndStable =
			version !== row.importedVersion && seen >= READS_BEFORE_REFRESH;

		const toClassified = () => {
			const classified = classifyDocumentFolderFile(file);
			status = classified.status;
			skipCode = classified.skipCode;
			entering = classified.status === S.PENDING;
			if (entering) {
				result.counts.returnedToPending++;
			}
		};

		if (retired) {
			// Back in the folder. It returns once its old context is gone; until
			// then the deletion follow-up returns it.
			if (row.contextId === null) {
				retired = false;
				data.retiredAt = null;
				data.missCount = 0;
				data.failureCode = null;
				if (
					row.excludedVersion !== null &&
					row.excludedVersion === version
				) {
					status = S.EXCLUDED;
					skipCode = null;
				} else {
					toClassified();
					data.excludedVersion = null;
				}
			}
		} else if (row.status === S.IMPORTED) {
			if (!row.contextId || !params.liveContextIds.has(row.contextId)) {
				status = S.EXCLUDED;
				data.excludedVersion = row.importedVersion;
				data.contextId = null;
				contextId = null;
				result.counts.excluded++;
			} else if (changedAndStable) {
				status = S.REFRESHING;
				saveGuidance = row.contextId;
				result.counts.refreshQueued++;
			}
		} else if (row.status === S.FAILED) {
			if (changedAndStable) {
				if (row.contextId) {
					status = S.REFRESHING;
					saveGuidance = row.contextId;
					result.counts.refreshQueued++;
				} else {
					toClassified();
					data.failureCode = null;
				}
			}
		} else if (row.status === S.SKIPPED) {
			if (
				row.skipCode !== DOCUMENT_FOLDER_SKIP_CODE.CAP_REACHED &&
				newVersion
			) {
				toClassified();
			}
		} else if (row.status === S.EXCLUDED) {
			if (version !== row.excludedVersion) {
				toClassified();
				data.excludedVersion = null;
			}
		}

		// Runs again whenever the window moves the file, so a value that returns
		// to what the row holds is dropped rather than left from the last run.
		const commit = () => {
			if (status !== row.status) {
				data.status = status;
			} else {
				delete data.status;
			}
			if (skipCode !== row.skipCode) {
				data.skipCode = skipCode;
			} else {
				delete data.skipCode;
			}
			if (Object.keys(data).length > 0 || saveGuidance) {
				updates.set(row.id, {
					id: row.id,
					fromStatus: row.status,
					fromRetired: row.retiredAt !== null,
					data,
					saveGuidanceFromContextId: saveGuidance,
				});
			}
		};
		commit();

		if (!retired && inWindowState(status, skipCode)) {
			window.push({
				driveItemId: row.driveItemId,
				modified,
				entering,
				get: () => ({ status, skipCode, contextId }),
				set: (nextStatus, nextSkip, save) => {
					status = nextStatus;
					skipCode = nextSkip;
					if (save && contextId && !saveGuidance) {
						saveGuidance = contextId;
					}
					commit();
				},
			});
		}
	}

	const order = (a: WindowEntry, b: WindowEntry) =>
		b.modified - a.modified ||
		(a.driveItemId < b.driveItemId
			? -1
			: a.driveItemId > b.driveItemId
				? 1
				: 0);

	if (params.complete) {
		window.sort(order);
		window.forEach((entry, index) => {
			const current = entry.get();
			if (index < cap) {
				// A displaced file still holding its context waits until the
				// deletion follow-up has removed it: a pending row has none.
				if (
					current.status === S.SKIPPED &&
					current.contextId === null
				) {
					entry.set(S.PENDING, null, false);
					result.counts.returnedToPending++;
				}
				return;
			}
			if (
				current.status === S.PENDING ||
				current.status === S.FAILED ||
				current.status === S.IMPORTED ||
				current.status === S.REFRESHING
			) {
				entry.set(
					S.SKIPPED,
					DOCUMENT_FOLDER_SKIP_CODE.CAP_REACHED,
					true,
				);
				result.counts.capSkipped++;
			}
		});

		for (const row of params.rows) {
			if (row.retiredAt !== null) {
				continue;
			}
			if (seenItems.has(row.driveItemId)) {
				if (row.missCount > 0) {
					result.resetMissIds.push(row.id);
				}
				continue;
			}
			result.missedIds.push(row.id);
			result.counts.missed++;
			if (row.missCount + 1 >= MISSES_BEFORE_LOOKUP) {
				result.candidates.push({
					fileId: row.id,
					driveItemId: row.driveItemId,
				});
			}
		}
	} else {
		// A partial listing moves nothing out of the window, but a file new to
		// it waits outside while the window is full.
		const held = window.filter((entry) => !entry.entering).length;
		let free = cap - held;
		for (const entry of window.filter((e) => e.entering).sort(order)) {
			if (free > 0) {
				free--;
				continue;
			}
			entry.set(S.SKIPPED, DOCUMENT_FOLDER_SKIP_CODE.CAP_REACHED, false);
			result.counts.capSkipped++;
		}
	}

	// A hand-removed context is an exclusion whether or not this listing
	// reached the file: otherwise a file deleted at the source and later
	// restored would be imported again.
	for (const row of params.rows) {
		if (
			seenItems.has(row.driveItemId) ||
			row.retiredAt !== null ||
			row.status !== S.IMPORTED ||
			(row.contextId && params.liveContextIds.has(row.contextId))
		) {
			continue;
		}
		updates.set(row.id, {
			id: row.id,
			fromStatus: row.status,
			fromRetired: false,
			data: {
				status: S.EXCLUDED,
				excludedVersion: row.importedVersion,
				contextId: null,
			},
			saveGuidanceFromContextId: null,
		});
		result.counts.excluded++;
	}

	result.updates = [...updates.values()];
	return result;
}
