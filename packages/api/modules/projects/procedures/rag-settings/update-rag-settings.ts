import { ORPCError } from "@orpc/server";
import {
	getProjectChunkingSettings,
	getProjectRagSettings,
	hasProjectAccess,
	isChunkingChange,
	resetCodeIndexRefreshSchedule,
	saveProjectChunkingChange,
	upsertProjectRagSettings,
} from "@repo/database";
import { chunkProfilesConfigSchema } from "@repo/rag";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { startCodeIndexingForUnindexedRepos } from "../../lib/code-indexing-trigger";
import { resolveProjectOrganizationId } from "../../lib/project-organization";
import { startProjectRechunk } from "../../lib/project-rechunk";

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
			topK: z.number().int().min(1).max(100).optional(),
			rerankTopK: z.number().int().min(1).max(50).optional(),
			similarityThreshold: z.number().min(0).max(1).optional(),
			enableReranking: z.boolean().optional(),
			// How AI agents search the project's code (spec 2026-10-29
			// code-index-sync §6a): not at all, live, or from the code index.
			codeSearchMode: z.enum(["OFF", "CODE_SEARCH", "RAG"]).optional(),
			codeEmbeddingModel: z
				.enum(["TEXT_EMBEDDING_3_SMALL", "VOYAGE_CODE_3"])
				.nullable()
				.optional(),
			// How often each repository's code index is refreshed from its
			// branch, changed files only (spec 2026-10-29 code-index-sync).
			codeIndexRefreshInterval: z
				.enum(["OFF", "HOURLY", "EVERY_6_HOURS", "DAILY"])
				.optional(),
			// Content-type chunking (spec 2026-10-28). Saving any change to
			// chunking re-chunks the whole project.
			chunkByContentType: z.boolean().optional(),
			chunkProfiles: chunkProfilesConfigSchema.nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const {
			projectId,
			organizationId: _inputOrganizationId,
			...updateData
		} = input;
		const user = context.user;
		// The project's own organization, stamped on the settings row. A
		// different input organization is refused before anything is written.
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			projectId,
		);

		// Check project access
		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId,
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

		const {
			chunkByContentType,
			chunkProfiles,
			chunkSize,
			chunkOverlap,
			splitMethod,
			...retrievalData
		} = updateData;
		const chunkingChange = {
			chunkByContentType,
			chunkProfiles,
			chunkSize,
			chunkOverlap,
			splitMethod,
		};

		const previous = await getProjectRagSettings(projectId);
		const previousMode = previous.codeSearchMode;
		if (
			(updateData.topK !== undefined ||
				updateData.rerankTopK !== undefined) &&
			(updateData.rerankTopK ?? previous.rerankTopK ?? 10) >
				(updateData.topK ?? previous.topK)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Maximum sources returned must not exceed candidate chunks",
			});
		}
		// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
		let settings = await upsertProjectRagSettings(projectId, {
			...retrievalData,
			userId: user.id,
			organizationId,
		});
		// A new interval applies from now, not from the old next check.
		if (retrievalData.codeIndexRefreshInterval !== undefined) {
			await resetCodeIndexRefreshSchedule(projectId);
		}
		// Switching to RAG indexes the included repositories not indexed yet;
		// the save never fails on it.
		if (retrievalData.codeSearchMode === "RAG" && previousMode !== "RAG") {
			try {
				await startCodeIndexingForUnindexedRepos({
					projectId,
					userId: user.id,
					organizationId,
				});
			} catch (error) {
				console.error(
					"[update-rag-settings] Could not start code indexing:",
					error instanceof Error ? error.name : typeof error,
				);
			}
		}

		// A chunking change is saved with a version bump and starts the
		// project re-chunk; retrieval settings (Top K, threshold, reranking)
		// never re-chunk.
		let rechunk: { runId: string } | null = null;
		const current = await getProjectChunkingSettings(projectId);
		if (isChunkingChange(current, chunkingChange)) {
			if (!organizationId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Chunking settings need the project's organization",
				});
			}
			const { chunkingVersion } = await saveProjectChunkingChange({
				projectId,
				userId: user.id,
				organizationId,
				change: chunkingChange,
			});
			rechunk = await startProjectRechunk({
				projectId,
				organizationId,
				userId: user.id,
				chunkingVersion,
			});
			settings = await upsertProjectRagSettings(projectId, {
				userId: user.id,
				organizationId,
			});
		}

		return { settings, rechunk };
	});
