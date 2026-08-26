import { ORPCError } from "@orpc/server";
import { importMemory, validateMemoryFile } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const importMemoryInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	agentInstanceId: z.string(),
	files: z.record(z.string(), z.string()), // { path: content }
	validateFirst: z.boolean().default(true),
});

export const importMemoryProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_MANAGE))
	.route({
		method: "POST",
		path: "/agent-memory/import",
		tags: ["Agent Memory"],
		summary: "Import memory files from a JSON object",
	})
	.input(importMemoryInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Validate all files first if requested
		if (input.validateFirst) {
			const validationErrors: Array<{ path: string; error: string }> = [];

			for (const [path, content] of Object.entries(input.files)) {
				const validation = validateMemoryFile(path, content);
				if (!validation.valid) {
					validationErrors.push({
						path,
						error: validation.error || "Unknown validation error",
					});
				}
			}

			if (validationErrors.length > 0) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Validation failed for ${validationErrors.length} files`,
					data: { validationErrors },
				});
			}
		}

		const importedFiles = await importMemory(
			{
				agentInstanceId: input.agentInstanceId,
				userId: context.user.id,
				organizationId,
			},
			input.files,
		);

		return {
			files: importedFiles,
			importedAt: new Date().toISOString(),
		};
	});
