/**
 * Project Metadata Activity
 *
 * Fetches project metadata for injection into the orchestrator's system prompt.
 * This provides the AI with high-level project context (name, description, goals,
 * tech stack, etc.) so it can give project-aware responses.
 *
 * Detailed project context is retrieved on-demand via the project_rag_query tool.
 */

import {
	db,
	getProjectContextAvailability,
	getProjectRepositoryRoles,
	type ProjectRepositoryRole,
	parseRepoUrl,
	tenantWhere,
} from "@repo/database";
import { log } from "@temporalio/activity";

export async function getProjectMetadataActivity(
	projectId: string,
	tenant: { userId: string; organizationId?: string | null },
) {
	const project = await db.project.findFirst({
		where: {
			id: projectId,
			...tenantWhere(tenant.userId, tenant.organizationId),
		},
		select: {
			id: true,
			name: true,
			description: true,
			goals: true,
			techStack: true,
			features: true,
			status: true,
			repositoryUrl: true,
			codeAnalysisStatus: true,
			_count: {
				select: {
					contexts: {
						where: { importedDocuments: { none: {} } },
					},
					documents: true,
				},
			},
		},
	});

	if (!project) {
		return null;
	}

	const [contextAvailability, dbRepoRoles] = await Promise.all([
		getProjectContextAvailability(projectId),
		getProjectRepositoryRoles(projectId),
	]);

	// If no active integrations exist in DB, synthesize a ProjectRepositoryRole
	// from the legacy Project.repositoryUrl column so downstream consumers see a uniform shape.
	const repositoryRoles: ProjectRepositoryRole[] =
		dbRepoRoles.length > 0
			? dbRepoRoles
			: project.repositoryUrl
				? [
						{
							url: project.repositoryUrl,
							provider:
								parseRepoUrl(project.repositoryUrl)?.provider ??
								"GITHUB",
							roleTag: null,
						},
					]
				: [];

	// Raw URL array for background scan consumers and in-flight workflow replay
	const repositoryUrls = repositoryRoles.map((r) => r.url);

	return {
		...project,
		repositoryUrls,
		repositoryRoles,
		contextCount: project._count.contexts,
		documentCount: project._count.documents,
		hasCodeAnalysis: contextAvailability.hasCodebase,
		...contextAvailability,
	};
}

/**
 * Retrieve project contexts via RAG for the project_rag_query tool.
 * This wraps the @repo/rag retrieval function as a Temporal activity.
 */
export async function retrieveProjectContextsActivity(
	query: string,
	projectId: string,
	userId: string,
	organizationId: string | undefined,
	topK?: number,
): Promise<{ context: string; chunkCount: number }> {
	try {
		const { retrieveProjectContexts, contextMetaHeader } = await import(
			"@repo/rag"
		);

		const results = await retrieveProjectContexts({
			projectId,
			query,
			userId,
			organizationId,
			topK,
			// Agent project_rag_query: diversify across distinct documents so a
			// long, multi-chunk document (e.g. a meeting transcript) can't crowd
			// out other relevant documents (e.g. a PRD) the user is asking about.
			diversify: true,
			// This is the agent's in-line hot path — it answers a waiting user,
			// so it takes hybrid-RRF order rather than paying for a rerank call.
			// Previously implicit in the diversify branch; now stated, because a
			// background caller wants the opposite.
			skipRerank: true,
		});

		if (!results || results.length === 0) {
			return { context: "", chunkCount: 0 };
		}

		const formattedResults = results
			.map(
				(
					r: {
						content: string;
						metadata?: { filename?: string; type?: string };
						sourceType?: string;
						aiInstructions?: string;
					},
					i: number,
				) => {
					const source =
						r.metadata?.filename ??
						r.metadata?.type ??
						`Context ${i + 1}`;
					// Type label + AI guidance (#1888): metadata arrives
					// flag-gated from retrieval; header is "" when unset.
					return `### From: ${source}\n${contextMetaHeader(r)}${r.content}`;
				},
			)
			.join("\n\n---\n\n");

		log.info("[ProjectRAG] Retrieved project context", {
			resultCount: results.length,
			projectId,
		});

		return {
			context: `## Project Context Results\n\n${formattedResults}`,
			chunkCount: results.length,
		};
	} catch (error) {
		log.error("[ProjectRAG] Failed to retrieve project context", {
			error: String(error),
			projectId,
		});
		return { context: "", chunkCount: 0 };
	}
}
