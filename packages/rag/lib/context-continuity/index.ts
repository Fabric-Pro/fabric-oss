import {
	ContextReadError,
	readProjectContextSnapshot,
} from "../context-quality/project-reader";
import { createSelectedContextAssembler } from "./assemble";
import {
	ContextAssemblyError,
	type ContextSelectionActor,
	contextSelectionActorSchema,
	contextSelectionInputSchema,
} from "./contracts";

export {
	type ContextAssemblyDependencies,
	createSelectedContextAssembler,
} from "./assemble";
export * from "./contracts";

/** Uses existing current Fabric authorities; no discovery, model, writes or index operations. */
export async function assembleSelectedContext(
	actor: ContextSelectionActor,
	rawInput: unknown,
) {
	if (
		!contextSelectionActorSchema.safeParse(actor).success ||
		!contextSelectionInputSchema.safeParse(rawInput).success
	) {
		throw new ContextAssemblyError("INVALID_INPUT");
	}
	try {
		const [database, permissions, workspace] = await Promise.all([
			import("@repo/database"),
			import("../context-quality/project-access"),
			import("@repo/database/prisma/queries/workspaces/document-content"),
		]);
		return await createSelectedContextAssembler({
			readProject: readProjectContextSnapshot,
			readWorkspace: workspace.readWorkspaceDocumentContent,
			authorizeProject: async (scope) => {
				const access =
					await permissions.resolveEffectiveProjectPermissions(
						scope.projectId,
						scope.userId,
					);
				if (
					!access ||
					access.organizationId !== scope.organizationId ||
					access.organizationDeleted ||
					!(await database.hasProjectAccess(
						scope.projectId,
						scope.userId,
						scope.organizationId,
					)) ||
					(await database.isProjectSoftDeleted(scope.projectId))
				) {
					throw new ContextReadError("NOT_FOUND");
				}
				const { hasPermission, Permissions } = await import(
					"@repo/permissions"
				);
				if (
					!hasPermission(access.permissions, Permissions.CONTEXT_READ)
				) {
					throw new ContextReadError("FORBIDDEN");
				}
			},
		})(actor, rawInput);
	} catch (error) {
		if (error instanceof ContextAssemblyError) {
			throw error;
		}
		throw new ContextAssemblyError("UNAVAILABLE");
	}
}
