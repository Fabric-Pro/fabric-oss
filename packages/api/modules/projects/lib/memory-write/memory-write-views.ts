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

/** Most files one listing page answers: about 200 bytes each keeps a page far below the 4.5 MB response cap. */
export const MEMORY_FOLDER_FILES_MAX_PAGE = 1000;
export const MEMORY_FOLDER_FILES_DEFAULT_PAGE = 500;

/**
 * The write folders and where their files go. `sync` is null when the project
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
	},
) {
	const state = await getMemoryFolderState(scope);
	if (!state) {
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
		folder: state.target.folder,
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
