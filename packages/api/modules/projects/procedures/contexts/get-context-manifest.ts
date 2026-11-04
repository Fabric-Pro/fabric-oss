import { ORPCError } from "@orpc/server";
import { resolveBoundOrganization } from "../../../../lib/authorized-project-binding";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	ContextManifestError,
	contextManifestScopeSchema,
	readContextManifest,
} from "../../lib/context-manifest-reader";

export const getContextManifestProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/contexts/manifest",
		tags: ["Projects", "Contexts"],
		summary: "Inspect bounded context source metadata and read references",
	})
	.input(contextManifestScopeSchema)
	.handler(async ({ input, context }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		const bound = resolveBoundOrganization(undefined);
		if (!bound.bound)
			throw new ORPCError("FORBIDDEN", {
				message: "An authorized organization project is required.",
			});
		const { projectId, organizationId: _named, ...page } = input;
		try {
			return await readContextManifest(
				{
					projectId,
					organizationId: bound.organizationId,
					userId: context.user.id,
				},
				page,
			);
		} catch (error) {
			if (error instanceof ContextManifestError)
				throw new ORPCError(
					error.code === "INVALID_INPUT" ? "BAD_REQUEST" : error.code,
					{ message: error.message },
				);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Context manifest could not be read.",
			});
		}
	});
