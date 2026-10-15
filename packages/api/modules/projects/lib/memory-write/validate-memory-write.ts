/**
 * Admission for a proposed Living Memory write (ADR-022): reads the facts
 * (`getMemoryWriteAdmissionState`, and whether the sync's delegate may still
 * create), then judges the request against them (`evaluateMemoryWrite`).
 *
 * VALIDATION ONLY. Nothing is persisted here: no receipt, no staged bytes, no
 * workflow. A receipt that nothing settles would be a half-state, so admitting
 * a write (the receipt, the staged bytes and the workflow start, together)
 * arrives with the write workflow. Until then a request that validates is
 * simply a request that would be admitted now.
 *
 * The caller has already passed the procedure's gate (the project is visible
 * to them and they hold CONTEXT_CREATE) and `organizationId` is the project's
 * hosting organization, resolved server-side.
 */
import { ORPCError } from "@orpc/client";
import { getMemoryWriteAdmissionState } from "@repo/database";
import { hasPermission, Permissions } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import { PROJECT_NOT_FOUND_MESSAGE } from "../../../../orpc/middleware/project-visibility";
import {
	evaluateMemoryWrite,
	type MemoryWriteEntryInput,
	type MemoryWriteValidation,
} from "./evaluate";

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

export async function validateMemoryWrite(input: {
	projectId: string;
	organizationId: string;
	targetId: string;
	message: string;
	entries: readonly MemoryWriteEntryInput[];
}): Promise<MemoryWriteValidation> {
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

	return evaluateMemoryWrite(
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
}
