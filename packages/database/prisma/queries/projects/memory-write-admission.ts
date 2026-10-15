/**
 * The facts admission judges a proposed Living Memory write against
 * (ADR-022), read together. Reads only, and takes no lock: admission is a
 * static check, and the write workflow re-reads what it acts on (the tip, and
 * the target at its frozen version) when it runs.
 *
 * Everything is scoped to the project and organization the caller resolved,
 * never to a value the request supplied, and the target is found only through
 * the project's own sync, so a stray `targetId` reads nothing of another
 * tenant's.
 */

import { db } from "../../client";
import type { ContextWriteMode } from "./context-write-targets";

export interface MemoryWriteAdmissionState {
	readOnlyMode: boolean;
	sync: {
		id: string;
		userId: string;
		ref: string;
		repositoryIntegrationId: string;
		paths: string[];
		excludedPaths: string[];
		automatic: boolean;
		automaticPausedReason: string | null;
	} | null;
	target: {
		id: string;
		version: number;
		folder: string;
		mode: ContextWriteMode;
	} | null;
	instructionRoots: string[];
	/** Rows the sync manages now. */
	managedCount: number;
	/** Which of the asked-about paths already have a managed row. */
	managedKeys: string[];
}

/** `null` when the project is not in this organization. */
export async function getMemoryWriteAdmissionState(input: {
	projectId: string;
	organizationId: string;
	targetId: string;
	/** Storage keys of the files the request would create or replace. */
	putPaths: readonly string[];
}): Promise<MemoryWriteAdmissionState | null> {
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	const [project, sync] = await Promise.all([
		db.project.findFirst({
			where: {
				id: input.projectId,
				organizationId: input.organizationId,
			},
			select: { readOnlyMode: true },
		}),
		db.projectContextRepositorySync.findFirst({
			where: scope,
			select: {
				id: true,
				userId: true,
				ref: true,
				repositoryIntegrationId: true,
				paths: true,
				excludedPaths: true,
				automatic: true,
				automaticPausedReason: true,
			},
		}),
	]);
	if (!project) {
		return null;
	}
	if (!sync) {
		return {
			readOnlyMode: project.readOnlyMode,
			sync: null,
			target: null,
			instructionRoots: [],
			managedCount: 0,
			managedKeys: [],
		};
	}
	const [target, instructionSyncs, managedCount, managed] = await Promise.all(
		[
			db.projectContextWriteTarget.findFirst({
				where: { id: input.targetId, syncId: sync.id, ...scope },
				select: { id: true, version: true, folder: true, mode: true },
			}),
			db.projectInstructionRepositorySync.findMany({
				where: {
					projectId: input.projectId,
					repositoryIntegrationId: sync.repositoryIntegrationId,
				},
				select: { rootPath: true },
			}),
			db.projectContext.count({
				where: { ...scope, repositorySyncId: sync.id },
			}),
			input.putPaths.length === 0
				? Promise.resolve([])
				: db.projectContext.findMany({
						where: {
							...scope,
							repositorySyncId: sync.id,
							sourcePath: { in: [...input.putPaths] },
						},
						select: { sourcePath: true },
					}),
		],
	);
	return {
		readOnlyMode: project.readOnlyMode,
		sync,
		target,
		instructionRoots: instructionSyncs.map((row) => row.rootPath),
		managedCount,
		managedKeys: managed.flatMap((row) =>
			row.sourcePath === null ? [] : [row.sourcePath],
		),
	};
}
