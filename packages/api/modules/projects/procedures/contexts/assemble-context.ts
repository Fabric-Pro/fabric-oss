import { ORPCError } from "@orpc/server";
import {
	assembleSelectedContext,
	contextSelectionInputSchema,
} from "@repo/rag/lib/context-continuity";
import { z } from "zod";
import { resolveBoundOrganization } from "../../../../lib/authorized-project-binding";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { contextAssemblyRefusal } from "../../lib/context-assembly-errors";

const id = z.string().trim().min(1).max(128);
const assembleContextInputSchema = contextSelectionInputSchema.safeExtend({
	projectId: id,
	organizationId: id.optional(),
});
export const assembleContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/contexts/assemble",
		tags: ["Projects", "Contexts"],
		summary:
			"Read an explicit bounded selection of current authorized context",
	})
	.input(assembleContextInputSchema)
	.handler(async ({ input, context }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		if (
			Buffer.byteLength(
				JSON.stringify({
					projectId: input.projectId,
					selections: input.selections,
				}),
				"utf8",
			) >
			16 * 1024
		) {
			throw new ORPCError("PAYLOAD_TOO_LARGE", {
				message: "Context selection request exceeds 16 KiB.",
			});
		}
		const bound = resolveBoundOrganization(input.organizationId);
		if (!bound.bound) {
			throw new ORPCError("FORBIDDEN", {
				message: "An authorized organization project is required.",
			});
		}
		try {
			return await assembleSelectedContext(
				{
					projectId: input.projectId,
					userId: context.user.id,
					organizationId: bound.organizationId,
				},
				{ selections: input.selections },
			);
		} catch (error) {
			const refusal = contextAssemblyRefusal(error);
			throw new ORPCError(refusal.code, {
				message: refusal.message,
				data: { code: refusal.reason },
			});
		}
	});
