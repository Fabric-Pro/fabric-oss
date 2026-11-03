/**
 * Content-type chunking on RAG Settings (spec 2026-10-28): what saving a
 * chunking change would re-chunk, and the latest re-chunk, measure and tune
 * runs with their progress.
 */

import { ORPCError } from "@orpc/server";
import {
	countProjectChunkingSources,
	getLastProjectChunkingCheck,
	getLatestProjectChunkingRuns,
	hasProjectAccess,
	isFeatureEnabled,
} from "@repo/database";
import {
	chunkingCheckPrompt,
	resolveProjectIndexEmbeddingModel,
} from "@repo/rag";
import {
	applyChunkingProposalRun,
	confirmChunkingAnalysisRun,
	prepareChunkingAnalysisRun,
	type RunRefusal,
} from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	buildProjectChunkingQuality,
	listProjectChunkingSources,
} from "../../lib/project-chunking-quality";
import { resolveProjectOrganizationId } from "../../lib/project-organization";
import { previewProjectRechunk } from "../../lib/project-rechunk";

const ProjectInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/** The project's own organization, after the caller's access to it. */
async function authorize(
	projectId: string,
	organizationId: string,
	userId: string,
): Promise<string> {
	if (!(await hasProjectAccess(projectId, userId, organizationId))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}
	return organizationId;
}

export const getRechunkPreviewProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/rag-settings/rechunk-preview",
		tags: ["Projects", "RAG"],
		summary: "Preview a project re-chunk",
		description:
			"What saving a chunking change would re-chunk: sources and estimated embedding tokens.",
	})
	.input(ProjectInput)
	.handler(async ({ input, context }) => {
		const organizationId = await authorize(
			input.projectId,
			await resolveProjectOrganizationId(
				input.organizationId,
				input.projectId,
			),
			context.user.id,
		);
		return previewProjectRechunk(input.projectId, organizationId);
	});

export const getChunkingRunsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/rag-settings/chunking-runs",
		tags: ["Projects", "RAG"],
		summary: "Latest chunking runs",
		description:
			"The latest re-chunk, measure and tune runs of a project, with progress and results.",
	})
	.input(ProjectInput)
	.handler(async ({ input, context }) => {
		await authorize(
			input.projectId,
			await resolveProjectOrganizationId(
				input.organizationId,
				input.projectId,
			),
			context.user.id,
		);
		return getLatestProjectChunkingRuns(input.projectId);
	});

export const getChunkingQualityProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/rag-settings/chunking-quality",
		tags: ["Projects", "RAG"],
		summary: "Chunking quality",
		description:
			"Per content type: sources, chunks and sizes, and the problems found in the stored chunks. Read-only.",
	})
	.input(ProjectInput)
	.handler(async ({ input, context }) => {
		const organizationId = await authorize(
			input.projectId,
			await resolveProjectOrganizationId(
				input.organizationId,
				input.projectId,
			),
			context.user.id,
		);
		return buildProjectChunkingQuality(input.projectId, organizationId);
	});

export const listChunkingSourcesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/rag-settings/chunking-sources",
		tags: ["Projects", "RAG"],
		summary: "Sources of one content type",
		description:
			"The sources one row of the chunking table counts, a page at a time: what each is, its size and its chunks. Read-only.",
	})
	.input(
		ProjectInput.extend({
			contentType: z.string().min(1).max(200),
			offset: z.number().int().min(0).default(0),
			limit: z.number().int().min(1).max(100).default(25),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await authorize(
			input.projectId,
			await resolveProjectOrganizationId(
				input.organizationId,
				input.projectId,
			),
			context.user.id,
		);
		return listProjectChunkingSources({
			projectId: input.projectId,
			organizationId,
			contentType: input.contentType,
			offset: input.offset,
			limit: input.limit,
		});
	});

export const getChunkingCheckProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/rag-settings/chunking-check",
		tags: ["Projects", "RAG"],
		summary: "Whether to offer a chunking check",
		description:
			"Compares source counts and the embedding model with the last chunking check and says whether a new check is worth offering. Counts only; the index is not read.",
	})
	.input(ProjectInput)
	.handler(async ({ input, context }) => {
		const organizationId = await authorize(
			input.projectId,
			await resolveProjectOrganizationId(
				input.organizationId,
				input.projectId,
			),
			context.user.id,
		);
		if (
			!(await isFeatureEnabled("CONTENT_AWARE_CHUNKING", organizationId))
		) {
			return { prompt: null };
		}
		const last = await getLastProjectChunkingCheck(input.projectId);
		const [counts, embeddingModel] = await Promise.all([
			countProjectChunkingSources({
				projectId: input.projectId,
				organizationId,
				since: last?.finishedAt,
			}),
			resolveProjectIndexEmbeddingModel({
				organizationId,
				userId: context.user.id,
			}),
		]);
		return {
			prompt: chunkingCheckPrompt({
				now: new Date(),
				lastCheck: last
					? {
							at: last.finishedAt,
							sources: last.snapshot?.sources ?? null,
							embeddingModel:
								last.snapshot?.embeddingModel ?? null,
						}
					: null,
				current: { ...counts, embeddingModel },
			}),
		};
	});

const RunInput = ProjectInput.extend({ runId: z.string() });

const REFUSAL_MESSAGES: Record<RunRefusal, string> = {
	"not-found": "This chunking run does not exist in this project",
	"not-awaiting-confirmation":
		"This chunking run is not waiting for a confirmation",
	"not-a-proposal": "This chunking run has no proposal waiting for approval",
};

/**
 * "Measure" (§8b) or "Suggest settings" (§8c): profile the content and return
 * the bounded cost the person confirms before any model or embedding call.
 * Anyone who can read the project may ask; nothing changes in the project.
 */
export const startChunkingAnalysisProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/rag-settings/chunking-analysis",
		tags: ["Projects", "RAG"],
		summary: "Prepare a chunking analysis",
		description:
			"Profiles the project's content and returns the cost of measuring (MEASURE) or tuning (TUNE) its chunking, to be confirmed before it runs.",
	})
	.input(ProjectInput.extend({ mode: z.enum(["MEASURE", "TUNE"]) }))
	.handler(async ({ input, context }) => {
		const organizationId = await authorize(
			input.projectId,
			await resolveProjectOrganizationId(
				input.organizationId,
				input.projectId,
			),
			context.user.id,
		);
		const { runId, plan } = await prepareChunkingAnalysisRun({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			mode: input.mode,
		});
		return { runId, estimate: plan.estimate, types: plan.types };
	});

export const confirmChunkingAnalysisProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/rag-settings/chunking-analysis/:runId/confirm",
		tags: ["Projects", "RAG"],
		summary: "Run a prepared chunking analysis",
		description:
			"Confirms the shown cost and starts the analysis. Read-only for the project.",
	})
	.input(RunInput)
	.handler(async ({ input, context }) => {
		const organizationId = await authorize(
			input.projectId,
			await resolveProjectOrganizationId(
				input.organizationId,
				input.projectId,
			),
			context.user.id,
		);
		const result = await confirmChunkingAnalysisRun(
			{
				runId: input.runId,
				projectId: input.projectId,
				organizationId,
				userId: context.user.id,
			},
			withCorrelationMemo,
		);
		if (!result.ok) {
			throw new ORPCError("BAD_REQUEST", {
				message: REFUSAL_MESSAGES[result.refusal],
			});
		}
		return { runId: input.runId };
	});

/**
 * Apply a tuning proposal (§8c step 6). Changing chunking is a settings
 * change, so it needs the same permission as saving RAG Settings.
 */
export const applyChunkingProposalProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/rag-settings/chunking-analysis/:runId/apply",
		tags: ["Projects", "RAG"],
		summary: "Apply a chunking proposal",
		description:
			"Writes the proposed per-type chunking settings and re-chunks the project.",
	})
	.input(RunInput)
	.handler(async ({ input, context }) => {
		const organizationId = await authorize(
			input.projectId,
			await resolveProjectOrganizationId(
				input.organizationId,
				input.projectId,
			),
			context.user.id,
		);
		const result = await applyChunkingProposalRun(
			{
				runId: input.runId,
				projectId: input.projectId,
				organizationId,
				userId: context.user.id,
			},
			withCorrelationMemo,
		);
		if (!result.ok) {
			throw new ORPCError("BAD_REQUEST", {
				message: REFUSAL_MESSAGES[result.refusal],
			});
		}
		return {
			chunkingVersion: result.chunkingVersion,
			rechunkRunId: result.rechunkRunId,
		};
	});
