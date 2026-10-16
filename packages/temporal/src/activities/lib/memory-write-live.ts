/**
 * What a Living Memory write re-checks live, before it touches the repository
 * and again immediately before it pushes (ADR-022). Admission judged the
 * request against the facts of its moment; the write workflow runs later, so
 * every fact the receipt froze or the request relied on is read again:
 *
 * - the target still exists, and is still the version the write was admitted
 *   against (every edit of a target bumps its version);
 * - the sync still exists on the same branch and the same repository
 *   integration, and is still ingesting (automatic sync on and not paused),
 *   because a file nothing reads back is a write that did nothing;
 * - the project is not in Read-only mode;
 * - the member the write acts for, and the member automatic runs act as, can
 *   still create context;
 * - the folder still passes `checkWriteTargetFolder`, the rule that admitted it.
 *
 * `judgeMemoryWriteState` is the pure verdict over the facts; the loader reads
 * them. A refusal is a code of the write's outcome vocabulary and carries no
 * text.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	canCreateProjectContexts,
	getMemoryWriteRunState,
	type MemoryWriteRunRow,
	type MemoryWriteRunState,
} from "@repo/database";
import type { MemoryWriteRefusalCode } from "../../lib/memory-write/outcome";
import { checkWriteTargetFolder } from "../../lib/memory-write/target-rules";

/** The receipt's frozen facts the live state is compared with. */
export type FrozenWrite = Pick<
	MemoryWriteRunRow,
	| "projectId"
	| "organizationId"
	| "userId"
	| "targetId"
	| "targetVersion"
	| "folder"
	| "mode"
	| "ref"
	| "repositoryIntegrationId"
>;

/** A state that passed `judgeMemoryWriteState`: the sync and the target are there. */
export type LiveMemoryWriteState = MemoryWriteRunState & {
	sync: NonNullable<MemoryWriteRunState["sync"]>;
	target: NonNullable<MemoryWriteRunState["target"]>;
};

export type MemoryWriteLiveCheck =
	| { ok: true; state: LiveMemoryWriteState }
	| { ok: false; code: MemoryWriteRefusalCode };

/**
 * The first reason the write may not go on, or the state itself with the
 * sync and the target narrowed. The order is the order a person would fix
 * them in.
 */
export function judgeMemoryWriteState(
	write: FrozenWrite,
	state: MemoryWriteRunState,
	holds: { member: boolean; delegate: boolean },
): MemoryWriteLiveCheck {
	const { sync, target } = state;
	const refuse = (code: MemoryWriteRefusalCode): MemoryWriteLiveCheck => ({
		ok: false,
		code,
	});
	if (
		target === null ||
		target.id !== write.targetId ||
		target.version !== write.targetVersion ||
		target.folder !== write.folder ||
		target.mode !== write.mode
	) {
		return refuse("TARGET_CHANGED");
	}
	if (
		sync === null ||
		sync.ref !== write.ref ||
		sync.repositoryIntegrationId !== write.repositoryIntegrationId ||
		sync.integration.projectId !== write.projectId
	) {
		return refuse("SYNC_CHANGED");
	}
	if (!sync.automatic || sync.automaticPausedReason !== null) {
		return refuse("SYNC_NOT_INGESTING");
	}
	if (state.readOnlyMode) {
		return refuse("READ_ONLY_MODE");
	}
	if (!holds.member) {
		return refuse("PERMISSION_REVOKED");
	}
	if (!holds.delegate) {
		return refuse("SYNC_DELEGATE_LOST_PERMISSION");
	}
	if (
		checkWriteTargetFolder({
			folder: target.folder,
			selection: { paths: sync.paths, excludedPaths: sync.excludedPaths },
			instructionRoots: state.instructionRoots,
		})
	) {
		return refuse("TARGET_STALE");
	}
	return { ok: true, state: { ...state, sync, target } };
}

/**
 * Reads the live facts and judges them. A project that is not in the
 * organization any more reads as a changed target: there is nothing to write
 * into. The delegate's permission is read only when it is another member.
 */
export async function checkMemoryWriteStillAllowed(
	write: FrozenWrite,
): Promise<MemoryWriteLiveCheck> {
	const state = await getMemoryWriteRunState({
		projectId: write.projectId,
		organizationId: write.organizationId,
		targetId: write.targetId,
		userId: write.userId,
	});
	if (state === null) {
		return { ok: false, code: "TARGET_CHANGED" };
	}
	const member = await canCreateProjectContexts(
		write.projectId,
		write.userId,
	);
	const delegate =
		state.sync === null || state.sync.userId === write.userId
			? member
			: await canCreateProjectContexts(
					write.projectId,
					state.sync.userId,
				);
	return judgeMemoryWriteState(write, state, { member, delegate });
}
