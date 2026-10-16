/**
 * Admission for a proposed Living Memory write (ADR-022): reads the facts
 * (`getMemoryWriteAdmissionState`, and whether the sync's delegate may still
 * create), then judges the request against them (`evaluateMemoryWrite`).
 *
 * `validateMemoryWrite` is the check alone: nothing is persisted, no receipt,
 * no staged bytes, no workflow. `judgeMemoryWrite` is the same judgment with
 * the integration the sync reads, which `submit` freezes into the receipt it
 * stores (`admit-memory-write.ts`).
 *
 * The caller has already passed the procedure's gate (the project is visible
 * to them and they hold CONTEXT_CREATE) and `organizationId` is the project's
 * hosting organization, resolved server-side.
 */
import { ORPCError } from "@orpc/client";
import { getMemoryWriteAdmissionState } from "@repo/database";
import { hasPermission, Permissions } from "@repo/permissions";
import {
	evaluateMemoryWrite,
	type MemoryWriteEntryInput,
	type MemoryWriteValidation,
} from "@repo/temporal/memory-write/evaluate";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import { PROJECT_NOT_FOUND_MESSAGE } from "../../../../orpc/middleware/project-visibility";

/**
 * Whether the member automatic runs act as can still create context in the
 * project, on the same resolution as the gate (`resolveContextSyncAccess`).
 */
async function delegateHoldsContextCreate(
	projectId: string,
	delegateUserId: string,
): Promise<boolean> {
	const access = await resolveEffectiveProjectPermissions(
		projectId,
		delegateUserId,
	);
	return (
		access !== null &&
		(access.source === "owner" ||
			hasPermission(access.permissions, Permissions.CONTEXT_CREATE))
	);
}

type JudgeInput = {
	projectId: string;
	organizationId: string;
	targetId: string;
	message: string;
	entries: readonly MemoryWriteEntryInput[];
};

/** The judgment, and the repository integration the sync reads (null when there is no sync). */
export async function judgeMemoryWrite(input: JudgeInput): Promise<{
	validation: MemoryWriteValidation;
	repositoryIntegrationId: string | null;
}> {
	const state = await getMemoryWriteAdmissionState({
		projectId: input.projectId,
		organizationId: input.organizationId,
		targetId: input.targetId,
		putPaths: input.entries
			.filter((entry) => entry.op === "PUT")
			.map((entry) => entry.path),
	});
	if (!state) {
		throw new ORPCError("NOT_FOUND", {
			message: PROJECT_NOT_FOUND_MESSAGE,
		});
	}

	const validation = evaluateMemoryWrite(
		{
			readOnlyMode: state.readOnlyMode,
			sync: state.sync,
			delegateHoldsContextCreate:
				state.sync === null
					? false
					: await delegateHoldsContextCreate(
							input.projectId,
							state.sync.userId,
						),
			target: state.target,
			instructionRoots: state.instructionRoots,
			managedCount: state.managedCount,
			managedKeys: new Set(state.managedKeys),
		},
		{
			projectId: input.projectId,
			targetId: input.targetId,
			message: input.message,
			entries: input.entries,
		},
	);
	return {
		validation,
		repositoryIntegrationId: state.sync?.repositoryIntegrationId ?? null,
	};
}

export async function validateMemoryWrite(
	input: JudgeInput,
): Promise<MemoryWriteValidation> {
	return (await judgeMemoryWrite(input)).validation;
}
