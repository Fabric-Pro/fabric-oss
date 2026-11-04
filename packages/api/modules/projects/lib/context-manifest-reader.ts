import type { listContextManifestMetadata } from "@repo/database/prisma/queries/projects/context-manifest";
import { ProjectContextTypeSchema } from "@repo/database/prisma/zod";
import { hasPermission, Permissions } from "@repo/permissions";
import { z } from "zod";
import type { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";
import { buildContextDiscoveryManifest } from "./context-download-manifest";

const id = z.string().trim().min(1).max(128);
export const contextManifestPageSchema = z.strictObject({
	limit: z.number().int().min(1).max(50).default(20),
	offset: z.number().int().min(0).max(2147483646).default(0),
	includeCodeContexts: z.boolean().default(false),
	type: ProjectContextTypeSchema.optional(),
});
export const contextManifestScopeSchema = z
	.strictObject({ projectId: id, organizationId: id.optional() })
	.extend(contextManifestPageSchema.shape);
const actorSchema = z.strictObject({
	userId: id,
	organizationId: id,
	projectId: id,
});
export type ContextManifestActor = z.infer<typeof actorSchema>;
export class ContextManifestError extends Error {
	constructor(readonly code: "INVALID_INPUT" | "NOT_FOUND" | "FORBIDDEN") {
		super(
			code === "INVALID_INPUT"
				? "Use a valid project context manifest scope and bounded page."
				: code === "NOT_FOUND"
					? "Project context manifest not found or access denied."
					: "No permission to read context sources of this project.",
		);
		this.name = "ContextManifestError";
	}
	get status(): 400 | 403 | 404 {
		return this.code === "INVALID_INPUT"
			? 400
			: this.code === "FORBIDDEN"
				? 403
				: 404;
	}
}
interface Dependencies {
	resolveAccess: typeof resolveEffectiveProjectPermissions;
	hasAccess: (
		projectId: string,
		userId: string,
		organizationId?: string,
	) => Promise<boolean>;
	isDeleted: (projectId: string) => Promise<boolean>;
	list: typeof listContextManifestMetadata;
}

/** All advertised transports repeat the UI's current object/role decision before and after metadata reads. */
export function createContextManifestReader(dependencies: Dependencies) {
	const authorize = async (actor: ContextManifestActor) => {
		const access = await dependencies.resolveAccess(
			actor.projectId,
			actor.userId,
		);
		if (
			!access ||
			access.organizationId !== actor.organizationId ||
			access.organizationDeleted ||
			!(await dependencies.hasAccess(
				actor.projectId,
				actor.userId,
				actor.organizationId,
			)) ||
			(await dependencies.isDeleted(actor.projectId))
		)
			throw new ContextManifestError("NOT_FOUND");
		if (!hasPermission(access.permissions, Permissions.CONTEXT_READ))
			throw new ContextManifestError("FORBIDDEN");
	};
	return async (rawActor: ContextManifestActor, rawPage: unknown) => {
		const actor = actorSchema.safeParse(rawActor);
		const page = contextManifestPageSchema.safeParse(rawPage);
		if (!actor.success || !page.success)
			throw new ContextManifestError("INVALID_INPUT");
		await authorize(actor.data);
		const observed = await dependencies.list({
			...actor.data,
			...page.data,
		});
		await authorize(actor.data);
		return buildContextDiscoveryManifest({
			...actor.data,
			...page.data,
			...observed,
		});
	};
}
export async function readContextManifest(
	actor: ContextManifestActor,
	page: unknown,
) {
	const [database, permissions, metadata] = await Promise.all([
		import("@repo/database"),
		import("../../../lib/effective-project-permissions"),
		import("@repo/database/prisma/queries/projects/context-manifest"),
	]);
	return createContextManifestReader({
		resolveAccess: permissions.resolveEffectiveProjectPermissions,
		hasAccess: database.hasProjectAccess,
		isDeleted: database.isProjectSoftDeleted,
		list: metadata.listContextManifestMetadata,
	})(actor, page);
}
