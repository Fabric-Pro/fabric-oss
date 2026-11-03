/**
 * Project chunking runs (spec 2026-10-28 §8a–§8c), shared by the API (RAG
 * Settings) and the Fabric agent's tools, so both start, confirm and apply
 * runs the same way.
 *
 *  - re-chunk: started by a saved chunking change;
 *  - analysis (MEASURE or TUNE): prepared with a bounded cost estimate the
 *    person confirms before any model or embedding call, then run by
 *    `projectChunkingAnalysisWorkflow`;
 *  - apply: a TUNE proposal becomes the project's per-type settings, which
 *    is a chunking change and so starts the re-chunk.
 *
 * Every function scopes the run by project AND organization: a run id from
 * another tenant matches nothing.
 */

import {
	countProjectChunkingSources,
	createProjectChunkingRun,
	db,
	getProjectChunkingSettings,
	type Prisma,
	type ProjectChunkingSnapshot,
	saveProjectChunkingChange,
	supersedeRunningRechunks,
	updateProjectChunkingRun,
} from "@repo/database";
import {
	type AnalysisEstimate,
	type AnalysisSource,
	type ChunkProfilesConfig,
	contentGroupFor,
	contentKindForContext,
	contentKindForDocumentType,
	estimateAnalysis,
	isCustomChunking,
	type ProposalRow,
	parseChunkProfilesConfig,
	profileByType,
	profileSource,
	resolveProjectIndexEmbeddingModel,
	sampleSources,
	type TypeProfile,
} from "@repo/rag";
import { getTemporalClient } from "../client";
import { PROJECT_EMBEDDING_TASK_QUEUE } from "../task-queues";

/** Lets the API add its request correlation memo to a start. */
export type StartOptionsDecorator = <T extends object>(options: T) => T;
const asIs: StartOptionsDecorator = (options) => options;

export function projectRechunkWorkflowId(projectId: string): string {
	return `project-rechunk-${projectId}`;
}

export function projectChunkingAnalysisWorkflowId(runId: string): string {
	return `project-chunking-analysis-${runId}`;
}

export async function startProjectRechunkRun(
	params: {
		projectId: string;
		organizationId: string;
		userId: string;
		chunkingVersion: number;
	},
	decorate: StartOptionsDecorator = asIs,
): Promise<{ runId: string; workflowId: string }> {
	const { projectId, organizationId, userId, chunkingVersion } = params;
	const workflowId = projectRechunkWorkflowId(projectId);
	const snapshot = await takeProjectChunkingSnapshot({
		projectId,
		organizationId,
		userId,
	});
	const run = await createProjectChunkingRun({
		projectId,
		organizationId,
		userId,
		kind: "RECHUNK",
		chunkingVersion,
		workflowId,
		result: { snapshot } as unknown as Prisma.InputJsonValue,
	});
	await supersedeRunningRechunks({ projectId, exceptRunId: run.id });
	try {
		const client = await getTemporalClient();
		await client.workflow.start(
			"projectRechunkWorkflow",
			decorate({
				taskQueue: PROJECT_EMBEDDING_TASK_QUEUE,
				workflowId,
				// One re-chunk per project: a newer change supersedes it.
				workflowIdConflictPolicy: "TERMINATE_EXISTING" as const,
				args: [
					{
						projectId,
						organizationId,
						userId,
						runId: run.id,
						chunkingVersion,
					},
				],
			}),
		);
	} catch (error) {
		// The settings are saved either way; the run says the re-chunk did
		// not start, and new ingestion already uses the new settings.
		await updateProjectChunkingRun(run.id, {
			status: "FAILED",
			error: error instanceof Error ? error.message : String(error),
			finished: true,
		});
		throw error;
	}
	return { runId: run.id, workflowId };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type ChunkingAnalysisMode = "MEASURE" | "TUNE";

/** What a prepared analysis run keeps before the person confirms its cost. */
export interface AnalysisPlan {
	stage: "estimate";
	mode: ChunkingAnalysisMode;
	estimate: AnalysisEstimate;
	types: TypeProfile[];
	/** Sampled source ids per content type (measurable types only). */
	sample: Record<string, string[]>;
	/** What the check saw, compared on later visits (spec §8d). */
	snapshot?: ProjectChunkingSnapshot;
}

/** Counts and the embedding model now: the baseline the next check compares. */
export async function takeProjectChunkingSnapshot(params: {
	projectId: string;
	organizationId: string;
	userId: string;
}): Promise<ProjectChunkingSnapshot> {
	const [{ sources }, embeddingModel] = await Promise.all([
		countProjectChunkingSources(params),
		resolveProjectIndexEmbeddingModel(params),
	]);
	return { at: new Date().toISOString(), sources, embeddingModel };
}

/** The project's sources as the analysis reads them: stored text only. */
export async function loadAnalysisSources(
	projectId: string,
	organizationId: string,
): Promise<AnalysisSource[]> {
	const [contexts, documents] = await Promise.all([
		db.projectContext.findMany({
			where: {
				projectId,
				organizationId,
				extractionStatus: "COMPLETED",
				type: { notIn: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
			},
			select: {
				id: true,
				type: true,
				metadata: true,
				content: true,
				mimeType: true,
				originalFilename: true,
			},
		}),
		db.projectDocument.findMany({
			where: { projectId, organizationId, isActive: true },
			select: { id: true, type: true, title: true, content: true },
		}),
	]);
	return [
		...contexts
			.filter((c) => c.content.trim().length > 0)
			.map((c) => {
				const kind = contentKindForContext({
					type: c.type,
					metadata: c.metadata,
				});
				const mimeType = c.mimeType ?? "";
				const filename = c.originalFilename ?? c.id;
				return {
					id: c.id,
					contentType: contentGroupFor({
						kind,
						content: c.content,
						mimeType,
						filename,
					}),
					kind,
					mimeType,
					filename,
					text: c.content,
				};
			}),
		...documents
			.filter((d) => d.content.trim().length > 0)
			.map((d) => {
				const kind = contentKindForDocumentType(d.type);
				return {
					id: `doc-${d.id}`,
					contentType: kind ?? `document:${d.type}`,
					kind,
					mimeType: "text/markdown",
					filename: d.title,
					text: d.content,
				};
			}),
	];
}

/**
 * Profile the content (deterministic, no model) and record a run awaiting
 * the person's confirmation of its bounded cost.
 */
export async function prepareChunkingAnalysisRun(params: {
	projectId: string;
	organizationId: string;
	userId: string;
	mode: ChunkingAnalysisMode;
}): Promise<{ runId: string; plan: AnalysisPlan }> {
	const sources = await loadAnalysisSources(
		params.projectId,
		params.organizationId,
	);
	const types = profileByType(sources.map(profileSource));
	const sample: Record<string, string[]> = {};
	for (const type of types) {
		if (type.measurable) {
			sample[type.contentType] = sampleSources(
				sources.filter((s) => s.contentType === type.contentType),
			).map((s) => s.id);
		}
	}
	const candidates = params.mode === "MEASURE" ? 1 : 4;
	const plan: AnalysisPlan = {
		stage: "estimate",
		mode: params.mode,
		estimate: estimateAnalysis(types, candidates),
		types,
		sample,
		snapshot: await takeProjectChunkingSnapshot(params),
	};
	const run = await createProjectChunkingRun({
		projectId: params.projectId,
		organizationId: params.organizationId,
		userId: params.userId,
		kind: params.mode,
	});
	await updateProjectChunkingRun(run.id, {
		status: "AWAITING_APPROVAL",
		result: plan as unknown as Prisma.InputJsonValue,
	});
	return { runId: run.id, plan };
}

async function findRun(params: {
	runId: string;
	projectId: string;
	organizationId: string;
}) {
	return db.projectChunkingRun.findFirst({
		where: {
			id: params.runId,
			projectId: params.projectId,
			organizationId: params.organizationId,
		},
	});
}

export type RunRefusal =
	| "not-found"
	| "not-awaiting-confirmation"
	| "not-a-proposal";

/** The person confirmed the cost: start the analysis workflow. */
export async function confirmChunkingAnalysisRun(
	params: {
		runId: string;
		projectId: string;
		organizationId: string;
		userId: string;
	},
	decorate: StartOptionsDecorator = asIs,
): Promise<
	{ ok: true; workflowId: string } | { ok: false; refusal: RunRefusal }
> {
	const run = await findRun(params);
	if (!run) {
		return { ok: false, refusal: "not-found" };
	}
	const plan = run.result as unknown as AnalysisPlan | null;
	if (run.status !== "AWAITING_APPROVAL" || plan?.stage !== "estimate") {
		return { ok: false, refusal: "not-awaiting-confirmation" };
	}
	const workflowId = projectChunkingAnalysisWorkflowId(run.id);
	await updateProjectChunkingRun(run.id, { status: "RUNNING", workflowId });
	const client = await getTemporalClient();
	await client.workflow.start(
		"projectChunkingAnalysisWorkflow",
		decorate({
			taskQueue: PROJECT_EMBEDDING_TASK_QUEUE,
			workflowId,
			args: [
				{
					runId: run.id,
					projectId: params.projectId,
					organizationId: params.organizationId,
					userId: params.userId,
				},
			],
		}),
	);
	return { ok: true, workflowId };
}

/** A finished TUNE run's proposal, as kept on the run. */
export interface TuneProposal {
	stage: "proposal";
	mode: ChunkingAnalysisMode;
	rows: ProposalRow[];
	measuredAt: string;
}

/**
 * Apply an approved TUNE proposal: the per-type choices become the project's
 * `chunkProfiles` and content-type chunking is turned on. That is a chunking
 * change, so it starts the project re-chunk.
 */
export async function applyChunkingProposalRun(
	params: {
		runId: string;
		projectId: string;
		organizationId: string;
		userId: string;
	},
	decorate: StartOptionsDecorator = asIs,
): Promise<
	| { ok: true; chunkingVersion: number; rechunkRunId: string }
	| { ok: false; refusal: RunRefusal }
> {
	const run = await findRun(params);
	if (!run) {
		return { ok: false, refusal: "not-found" };
	}
	const proposal = run.result as unknown as TuneProposal | null;
	if (
		run.kind !== "TUNE" ||
		run.status !== "AWAITING_APPROVAL" ||
		proposal?.stage !== "proposal"
	) {
		return { ok: false, refusal: "not-a-proposal" };
	}
	const current = await getProjectChunkingSettings(params.projectId);
	const profiles: ChunkProfilesConfig = parseChunkProfilesConfig(
		current.chunkProfiles,
	);
	for (const row of proposal.rows) {
		if (row.tuning) {
			profiles[row.contentType as keyof ChunkProfilesConfig] = row.tuning;
		}
	}
	const { chunkingVersion } = await saveProjectChunkingChange({
		projectId: params.projectId,
		userId: params.userId,
		organizationId: params.organizationId,
		// Only the proposed types change; every other type keeps its row (or
		// Standard), so applying a proposal never moves a type nobody asked for.
		change: {
			chunkProfiles: profiles as Prisma.InputJsonValue,
		},
	});
	await updateProjectChunkingRun(run.id, {
		status: "COMPLETED",
		result: {
			...proposal,
			appliedAt: new Date().toISOString(),
			appliedBy: params.userId,
		} as unknown as Prisma.InputJsonValue,
		finished: true,
	});
	const rechunk = await startProjectRechunkRun(
		{
			projectId: params.projectId,
			organizationId: params.organizationId,
			userId: params.userId,
			chunkingVersion,
		},
		decorate,
	);
	return { ok: true, chunkingVersion, rechunkRunId: rechunk.runId };
}

/** The current candidate per type, from the project's settings. */
export function currentSettingFor(
	type: TypeProfile,
	settings: { chunkByContentType: boolean; chunkProfiles: unknown },
) {
	const tuning = parseChunkProfilesConfig(settings.chunkProfiles)[
		type.contentType as keyof ChunkProfilesConfig
	];
	if (isCustomChunking(tuning, settings.chunkByContentType)) {
		return { profile: "prose" as const };
	}
	return { profile: tuning?.profile ?? type.defaultProfile, tuning };
}
