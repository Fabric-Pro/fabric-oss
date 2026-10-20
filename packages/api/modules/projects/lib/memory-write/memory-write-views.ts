/**
 * What an agent or the CLI reads about Living Memory writes (ADR-022), shared
 * by the app's procedures, the v1 REST routes and the MCP tools so every
 * surface answers with the same shapes.
 *
 * Every function takes the hosting organization the caller already resolved
 * server-side and is scoped to it and the project; none authorizes. The caller
 * has passed its own gate (CONTEXT_READ to read, CONTEXT_CREATE to write).
 */
import {
	getContextRepositorySync,
	getMemoryFolderFile,
	getMemoryFolderState,
	getMemoryWriteReceipt,
	listContextWriteTargets,
	listMemoryFolderFiles,
} from "@repo/database";
import { memoryWriteOutcomeSchema } from "@repo/temporal/memory-write/outcome";

type Scope = { projectId: string; organizationId: string };

/**
 * `prefix` without its trailing slash when it is the write folder or below it
 * by whole path segments, else `null`. A path with a `..`, `.` or empty
 * segment (a leading slash included) is inside nothing.
 */
function insideFolder(folder: string, prefix: string): string | null {
	const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
	if (
		trimmed
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	) {
		return null;
	}
	return trimmed === folder || trimmed.startsWith(`${folder}/`)
		? trimmed
		: null;
}

/** Most files one listing page answers: about 200 bytes each keeps a page far below the 4.5 MB response cap. */
export const MEMORY_FOLDER_FILES_MAX_PAGE = 1000;
export const MEMORY_FOLDER_FILES_DEFAULT_PAGE = 500;

/**
 * The write folders and where their files go, and whether Fabric embeds them
 * for AI search (`indexMode`: INDEXED, or STORE_ONLY, which keeps the files
 * readable but out of search and summaries). `sync` is null when the project
 * has no Living Memory repository sync, and then there are no folders.
 * `ingesting` says whether landed files reach Living Memory on their own: an
 * automatic sync that is not paused.
 */
export async function getMemoryWriteTargetsView(scope: Scope) {
	const [sync, targets] = await Promise.all([
		getContextRepositorySync(scope.projectId, scope.organizationId),
		listContextWriteTargets(scope),
	]);
	if (!sync) {
		return { sync: null, targets: [] };
	}
	return {
		sync: {
			ref: sync.ref,
			lastAppliedCommitSha: sync.lastAppliedCommitSha,
			ingesting: sync.automatic && sync.automaticPausedReason === null,
			repository: {
				provider: sync.repositoryIntegration.provider,
				owner: sync.repositoryIntegration.repositoryOwner,
				name: sync.repositoryIntegration.repositoryName,
			},
		},
		targets: targets.map((target) => ({
			id: target.id,
			folder: target.folder,
			mode: target.mode,
			indexMode: target.indexMode,
			version: target.version,
		})),
	};
}

/**
 * The receipt of one write: where it stands and how it ended. No message, no
 * content and no staged key. `null` when the write is not this project's.
 */
export async function getMemoryWriteView(scope: Scope & { writeId: string }) {
	const receipt = await getMemoryWriteReceipt(scope);
	if (!receipt) {
		return null;
	}
	const outcome = memoryWriteOutcomeSchema.safeParse(receipt.outcome);
	return {
		writeId: receipt.id,
		status: receipt.status,
		digest: receipt.digest,
		targetId: receipt.targetId,
		folder: receipt.folder,
		mode: receipt.mode,
		ref: receipt.ref,
		via: receipt.via,
		entries: receipt.entries.map((entry) => ({
			path: entry.path,
			op: entry.op,
		})),
		outcome: outcome.success ? outcome.data : null,
		createdAt: receipt.createdAt,
		settledAt: receipt.settledAt,
	};
}

/**
 * One page of the files Living Memory holds under a write folder, by path.
 * `lastAppliedCommitSha` is the commit the listing reflects: the repository
 * may be ahead of it, and a pull-request write is absent until it is merged
 * and a sync run has read it. `nextCursor` is the last path of a full page,
 * or null at the end. `null` when the folder is not this project's.
 */
export async function getMemoryFolderFilesView(
	scope: Scope & {
		targetId: string;
		after: string | null;
		limit: number;
		/** A folder at or below the write folder; the whole folder when absent. */
		prefix?: string;
	},
) {
	const state = await getMemoryFolderState(scope);
	if (!state) {
		return null;
	}
	const folder = scope.prefix
		? insideFolder(state.target.folder, scope.prefix)
		: state.target.folder;
	if (folder === null) {
		return null;
	}
	const limit = Math.min(
		Math.max(scope.limit, 1),
		MEMORY_FOLDER_FILES_MAX_PAGE,
	);
	const files = await listMemoryFolderFiles({
		projectId: scope.projectId,
		organizationId: scope.organizationId,
		syncId: state.sync.id,
		folder,
		after: scope.after,
		limit: limit + 1,
	});
	const page = files.slice(0, limit);
	return {
		targetId: state.target.id,
		folder: state.target.folder,
		ref: state.sync.ref,
		lastAppliedCommitSha: state.sync.lastAppliedCommitSha,
		files: page,
		nextCursor:
			files.length > limit ? (page[page.length - 1]?.path ?? null) : null,
	};
}

/**
 * One file under a write folder, with its text. `null` when the folder is not
 * this project's or holds no such path (a path outside the folder included).
 */
export async function getMemoryFolderFileView(
	scope: Scope & { targetId: string; path: string },
) {
	const state = await getMemoryFolderState(scope);
	if (!state || !scope.path.startsWith(`${state.target.folder}/`)) {
		return null;
	}
	const file = await getMemoryFolderFile({
		projectId: scope.projectId,
		organizationId: scope.organizationId,
		syncId: state.sync.id,
		path: scope.path,
	});
	if (!file) {
		return null;
	}
	return {
		targetId: state.target.id,
		ref: state.sync.ref,
		lastAppliedCommitSha: state.sync.lastAppliedCommitSha,
		...file,
	};
}

/** A read of one file answers this many bytes of text unless asked for fewer or more. */
export const MEMORY_READ_DEFAULT_BYTES = 12_000;
export const MEMORY_READ_MAX_BYTES = 50_000;

/** The nearest position at or before `at` that is not inside a UTF-8 sequence. */
function characterBoundary(bytes: Buffer, at: number): number {
	let position = at;
	while (
		position > 0 &&
		position < bytes.length &&
		(bytes[position] & 0xc0) === 0x80
	) {
		position--;
	}
	return position;
}

/**
 * One file under a write folder as a page of its text: at most `maxBytes`
 * from byte `offset`, never cutting a character in two, with `nextOffset`
 * where the next page starts (null at the end) and the file's `totalBytes`.
 * `null` exactly when `getMemoryFolderFileView` is. A Store only folder's
 * files are read like any other.
 */
export async function getMemoryFolderTextView(
	scope: Scope & {
		targetId: string;
		path: string;
		offset?: number;
		maxBytes?: number;
	},
) {
	const file = await getMemoryFolderFileView(scope);
	if (!file) {
		return null;
	}
	const bytes = Buffer.from(file.content, "utf8");
	const maxBytes = Math.min(
		Math.max(Math.floor(scope.maxBytes ?? MEMORY_READ_DEFAULT_BYTES), 1),
		MEMORY_READ_MAX_BYTES,
	);
	const wanted = Math.min(
		Math.max(Math.floor(scope.offset ?? 0), 0),
		bytes.length,
	);
	const start = characterBoundary(bytes, wanted);
	const end = characterBoundary(
		bytes,
		Math.min(start + maxBytes, bytes.length),
	);
	const { content: _whole, ...rest } = file;
	return {
		...rest,
		content: bytes.subarray(start, end).toString("utf8"),
		offset: start,
		nextOffset: end < bytes.length ? end : null,
		totalBytes: bytes.length,
	};
}
