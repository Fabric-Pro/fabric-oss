import { ORPCError } from "@orpc/server";
import { hasProjectAccess, upsertProjectRagSettings } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const ChunkSplitMethodSchema = z.enum([
	"PARAGRAPH",
	"SENTENCE",
	"FIXED",
	"RECURSIVE",
	"DOCUMENT",
	"SEMANTIC",
]);
const EmbeddingModelSchema = z.enum([
	"TEXT_EMBEDDING_3_SMALL",
	"TEXT_EMBEDDING_3_LARGE",
]);

export const updateRagSettingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/projects/:projectId/rag-settings",
		tags: ["Projects", "RAG"],
		summary: "Update RAG settings",
		description: "Update the RAG settings for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			chunkSize: z.number().min(500).max(10000).optional(),
			chunkOverlap: z.number().min(0).max(2000).optional(),
			splitMethod: ChunkSplitMethodSchema.optional(),
			embeddingModel: EmbeddingModelSchema.optional(),
			topK: z.number().min(1).max(50).optional(),
			similarityThreshold: z.number().min(0).max(1).optional(),
			enableReranking: z.boolean().optional(),
			codeSearchEnabled: z.boolean().optional(),
			codeSearchProvider: z
				.enum(["api", "indexed", "hybrid"])
				.nullable()
				.optional(),
			codeEmbeddingModel: z
				.enum(["TEXT_EMBEDDING_3_SMALL", "VOYAGE_CODE_3"])
				.nullable()
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId, ...updateData } = input;
		const user = context.user;

		// Check project access
		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Validate chunk overlap is less than chunk size
		if (
			updateData.chunkSize !== undefined &&
			updateData.chunkOverlap !== undefined &&
			updateData.chunkOverlap >= updateData.chunkSize
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Chunk overlap must be less than chunk size",
			});
		}

		// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
		const settings = await upsertProjectRagSettings(projectId, {
			...updateData,
			userId: user.id,
			organizationId: organizationId ?? undefined,
		});

		return { settings };
	});
