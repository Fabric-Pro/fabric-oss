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
import { rethrowIfDispatchStopped } from "@repo/utils/dispatch-guard";
import { log } from "@temporalio/activity";
import {
	runWithTurnDispatch,
	startTurnHeartbeat,
	type TurnScope,
} from "./orchestrator/turn-dispatch";

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
 * Activity wrapper for the `fabric_list_meeting_transcripts` tool.
 *
 * The iterative orchestrator runs inside a workflow, which must not touch the
 * database directly, so the shared listing helper is reached through here —
 * mirroring how `retrieveProjectContextsActivity` fronts project RAG. Read-only
 * and therefore trivially idempotent under Temporal's retries.
 */
export async function listMeetingTranscriptsActivity(input: {
	projectId: string;
	userId: string;
	organizationId?: string;
	from?: string;
	to?: string;
	subject?: string;
	limit?: number;
}): Promise<{ response: string; transcriptCount: number; total: number }> {
	const { listProjectMeetingTranscripts, readTranscriptFilters } =
		await import("./shared/meeting-transcript-listing");

	try {
		const listing = await listProjectMeetingTranscripts({
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			filters: readTranscriptFilters({
				from: input.from,
				to: input.to,
				subject: input.subject,
				limit: input.limit,
			}),
		});
		log.info("[MeetingTranscripts] Listed transcripts", {
			projectId: input.projectId,
			transcriptCount: listing.transcriptCount,
			total: listing.total,
		});
		return listing;
	} catch (error) {
		log.error("[MeetingTranscripts] Failed to list transcripts", {
			error: String(error),
			projectId: input.projectId,
		});
		// Surface the failure rather than an empty list: "no transcripts" and
		// "the lookup broke" must never look the same to the model, which is
		// the whole point of this tool (Fizzy #2473).
		throw error;
	}
}

/**
 * Header for `project_rag_query` results.
 *
 * The caveat is load-bearing, not decoration (Fizzy #2473). This tool returns a
 * similarity-ranked SAMPLE — a handful of documents out of a corpus that can run
 * to hundreds — with no date ordering anywhere in the index. Without being told
 * that, the model reads the sample as an inventory: asked whether a transcript
 * from a given day existed, it reported "no" and named the newest date it
 * happened to receive as "the most recent on record". Two runs of the same
 * question named different dates, months apart, while the document was present
 * and embedded the whole time.
 */
const PROJECT_CONTEXT_RESULTS_HEADER = [
	"## Project Context Results",
	"",
	"These are the closest semantic matches to the query — a ranked sample, NOT a",
	"complete or date-ordered listing of the project's sources. Never conclude from",
	"this set that a document does not exist, and never present the newest item in it",
	"as the most recent on record. To answer a question about what exists on a given",
	"date, use a date-filtered tool if one is available rather than inferring an",
	"answer from these results; if none is available, say the search cannot be",
	"scoped by date instead of reporting an absence.",
].join("\n");

/**
 * Retrieve project contexts via RAG for the project_rag_query tool.
 * This wraps the @repo/rag retrieval function as a Temporal activity.
 *
 * `options.turnScope` (the Advisor chat turn the search serves; the trailing
 * argument so the other callers are untouched) runs the retrieval inside the
 * turn's dispatch guard: its embedding and model requests are checked against
 * the turn record and aborted by a Stop, and a stop is rethrown, not returned
 * as "no context". A caller already inside a turn's guard gets the same
 * rethrow without passing it.
 */
export async function retrieveProjectContextsActivity(
	query: string,
	projectId: string,
	userId: string,
	organizationId: string | undefined,
	topK?: number,
	options?: { turnScope?: TurnScope },
): Promise<{ context: string; chunkCount: number }> {
	const turnScope = options?.turnScope;
	const stopHeartbeat = startTurnHeartbeat(turnScope);
	try {
		return await runWithTurnDispatch(turnScope, () =>
			retrieveProjectContextsForTool(
				query,
				projectId,
				userId,
				organizationId,
				topK,
			),
		);
	} finally {
		stopHeartbeat();
	}
}

async function retrieveProjectContextsForTool(
	query: string,
	projectId: string,
	userId: string,
	organizationId: string | undefined,
	topK: number | undefined,
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
						filename?: string;
						sourceTitle?: string;
						sourceUrl?: string;
						metadata?: { filename?: string; type?: string };
						sourceType?: string;
						aiInstructions?: string;
					},
					i: number,
				) => {
					// Read the retrieval shape's OWN fields, not `metadata.*`.
					// `RetrievedContext` carries `filename` / `sourceTitle` at the
					// top level; `metadata` is the raw stored JSON and almost never
					// holds either key, so the old `metadata?.filename ??
					// metadata?.type` pair fell through to "Context N" for nearly
					// every source. That stripped the one place a meeting
					// transcript's date reaches the model — its title, e.g.
					// "Meeting Transcript: Fabric DSU (9/10/2026, 4:01:34 PM)"
					// (Fizzy #2473). Precedence matches `formatContextsForPrompt`.
					const source =
						r.filename ||
						r.sourceTitle ||
						r.sourceUrl ||
						r.metadata?.filename ||
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
			context: `${PROJECT_CONTEXT_RESULTS_HEADER}\n\n${formattedResults}`,
			chunkCount: results.length,
		};
	} catch (error) {
		// Inside a chat turn's dispatch guard a stop is not "no context".
		rethrowIfDispatchStopped(error);
		log.error("[ProjectRAG] Failed to retrieve project context", {
			error: String(error),
			projectId,
		});
		return { context: "", chunkCount: 0 };
	}
}
