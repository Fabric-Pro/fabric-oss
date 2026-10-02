/**
 * Company context retrieval for Proposal and Business Case generation
 * (Fizzy #2719).
 *
 * An organization keeps sources about itself — case studies, service
 * descriptions, its website — once, and generation draws on them alongside the
 * project's own context. This module produces the company half of
 * `retrieveProjectContexts`: a short list of context strings, each labeled as
 * vendor material, that the activity appends after the project entries.
 *
 * Who gets it, and whose:
 * - The organization is the project row's, never the workflow input's. The
 *   project-setup path passes the session's organization, which for a user in
 *   two organizations can be a different tenant than the project's.
 * - The `COMPANY_CONTEXT` gate is read for that organization.
 * - The author must be a member of that organization. A project guest is not,
 *   even when they are a member elsewhere: company material is the host's,
 *   and the project invitation does not extend to it.
 *
 * What it finds:
 * - The query is the document type's vendor-side intent plus the project's
 *   name, description and goals, so the material is chosen for the project
 *   being proposed, not only for the document type.
 * - It is embedded with the organization's embedding model, separately from
 *   the project query, and only vectors of that model, from sources that are
 *   ready right now (`companyContextReadyWhere`), can answer it.
 * - A crawled page's hit counts only while its page row exists and holds
 *   that model's vectors: a page's vectors can outlive its row when the
 *   prune that removed the row could not remove them.
 * - A model whose dimension no collection can hold skips the search.
 * - Hits group by source, best first; at most four sources, three chunks each.
 *
 * What it returns: strings starting with `VENDOR_CONTEXT_MARKER`, then the
 * source label, type and guidance, then the matched text — neutralized here,
 * because one of the four render sites (the agent's own prompt builder) does
 * not neutralize what it is given.
 *
 * It never throws, and never takes longer than `COMPANY_RETRIEVAL_TIMEOUT_MS`.
 * A failure or a timeout is logged once and yields no company entries, so the
 * author keeps their project context whatever happens here.
 */

import { VENDOR_CONTEXT_MARKER } from "@repo/agent-types";
import {
	companyContextReadyWhere,
	db,
	getProjectRagSettings,
	isFeatureEnabled,
	isOrganizationMember,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	COMPANY_EMBEDDING_RESOLUTION,
	type CompanyContextSearchHit,
	companyEmbeddingIdentity,
	generateEmbedding,
	resolveCompanyEmbeddingModel,
	searchCompanyContexts,
} from "@repo/rag";
import { neutralizeAiChatAttachmentBody } from "@repo/utils/ai-chat-attachment";
import { heartbeat } from "@temporalio/activity";

/**
 * The vendor-side question each document type asks of the company context.
 * Only these document types retrieve it; every other type is unchanged.
 */
const COMPANY_CONTEXT_INTENTS: Record<string, string> = {
	PROPOSAL:
		"What relevant experience, case studies, past projects and their outcomes, capabilities, services, delivery approach, methodologies, team expertise, certifications, partnerships and differentiators does our company have for a project like this one?",
	BUSINESS_CASE:
		"What evidence from our company's past work supports a decision about a project like this one: comparable projects and their measured outcomes, delivery track record, capabilities, reusable assets, typical effort, and the risks we have seen?",
};

/** Company entries per generation, after grouping hits by source. */
const MAX_COMPANY_ENTRIES = 4;
/** Chunks of one source kept in its entry. */
const MAX_CHUNKS_PER_ENTRY = 3;
/** Hits requested from the search: enough to fill four sources. */
const COMPANY_SEARCH_TOP_K = MAX_COMPANY_ENTRIES * MAX_CHUNKS_PER_ENTRY;
/** Each project field's share of the query; keeps it inside one embedding input. */
const MAX_PROFILE_FIELD_CHARS = 2000;

/**
 * How long the company half may take before generation goes on without it.
 *
 * It runs inside `retrieveProjectContexts`, after the project half, and the
 * tightest timeout that activity runs under is the task agent's 30-second
 * heartbeat timeout (document generation allows 2 minutes between heartbeats
 * and 15 minutes in all). The company half heartbeats as it starts, so 20
 * seconds from there leaves that heartbeat room to spare, while still
 * covering a slow embedding call and search.
 */
export const COMPANY_RETRIEVAL_TIMEOUT_MS = 20_000;

/** What the deadline race resolves with when the company half ran out of time. */
const TIMED_OUT = Symbol("company-context-retrieval-timed-out");

const READY_SOURCE_SELECT = {
	id: true,
	sourceTitle: true,
	originalFilename: true,
	sourceUrl: true,
	sourceType: true,
	aiInstructions: true,
} as const;

interface ReadySource {
	id: string;
	sourceTitle: string | null;
	originalFilename: string | null;
	sourceUrl: string | null;
	sourceType: string | null;
	aiInstructions: string | null;
}

interface ProjectProfile {
	name: string;
	description: string | null;
	goals: string | null;
}

function clip(text: string): string {
	return text.length > MAX_PROFILE_FIELD_CHARS
		? text.slice(0, MAX_PROFILE_FIELD_CHARS)
		: text;
}

function buildCompanyContextQuery(
	intent: string,
	project: ProjectProfile,
): string {
	const profile = [
		`Project: ${clip(project.name)}`,
		project.description
			? `Description: ${clip(project.description)}`
			: null,
		project.goals ? `Goals: ${clip(project.goals)}` : null,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
	return `${intent}\n\n${profile}`;
}

function sourceLabel(source: ReadySource): string {
	return (
		source.sourceTitle ||
		source.originalFilename ||
		source.sourceUrl ||
		"Company context"
	);
}

function formatVendorEntry(source: ReadySource, chunks: string[]): string {
	const header = [
		VENDOR_CONTEXT_MARKER,
		`[Source: ${sourceLabel(source)}]`,
		source.sourceType ? `[Source type: ${source.sourceType}]` : null,
		source.aiInstructions
			? `[Source guidance: ${source.aiInstructions}]`
			: null,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
	return neutralizeAiChatAttachmentBody(
		`${header}\n${chunks.join("\n\n[...]\n\n")}`,
	);
}

/**
 * Drop the hits of crawled pages whose row is gone, or no longer holds
 * `embeddingModel`'s vectors, under a ready source. One query, scoped to the
 * organization and its ready sources, for the pages among the hits; a hit on
 * a source's own text needs none.
 */
async function keepLivePageHits(
	hits: readonly CompanyContextSearchHit[],
	scope: {
		organizationId: string;
		sourceIds: readonly string[];
		embeddingModel: string;
	},
): Promise<CompanyContextSearchHit[]> {
	const isPageHit = (hit: CompanyContextSearchHit) =>
		Boolean(hit.parentContextId);
	const pageIds = [
		...new Set(hits.filter(isPageHit).map((hit) => hit.contextId)),
	];
	if (pageIds.length === 0) {
		return [...hits];
	}
	const livePages = await db.companyContextUrlPage.findMany({
		where: {
			organizationId: scope.organizationId,
			id: { in: pageIds },
			parentSourceId: { in: [...scope.sourceIds] },
			embeddedAt: { not: null },
			embeddingModel: scope.embeddingModel,
		},
		select: { id: true, parentSourceId: true },
	});
	const parentOf = new Map(
		livePages.map((page) => [page.id, page.parentSourceId]),
	);
	return hits.filter(
		(hit) =>
			!isPageHit(hit) || parentOf.get(hit.contextId) === hit.sourceId,
	);
}

/**
 * Group hits by source in score order, keep only sources that are still
 * ready, and cap the result. Hits arrive best first, so the first hit of a
 * source fixes its rank.
 */
function selectVendorEntries(
	hits: readonly CompanyContextSearchHit[],
	readySources: ReadonlyMap<string, ReadySource>,
): string[] {
	const selected = new Map<
		string,
		{ source: ReadySource; chunks: string[] }
	>();
	for (const hit of hits) {
		const source = readySources.get(hit.sourceId);
		if (!source) {
			continue;
		}
		const entry = selected.get(hit.sourceId);
		if (entry) {
			if (entry.chunks.length < MAX_CHUNKS_PER_ENTRY) {
				entry.chunks.push(hit.content);
			}
		} else if (selected.size < MAX_COMPANY_ENTRIES) {
			selected.set(hit.sourceId, { source, chunks: [hit.content] });
		}
	}
	return [...selected.values()].map(({ source, chunks }) =>
		formatVendorEntry(source, chunks),
	);
}

/**
 * The company context entries for one generation run, or none. Never throws,
 * and gives up after `COMPANY_RETRIEVAL_TIMEOUT_MS`: a hung embedding call or
 * search must not hold, or fail, the activity the project entries ride in.
 */
export async function retrieveCompanyContextEntries(input: {
	projectId: string;
	userId: string;
	documentType: string;
}): Promise<string[]> {
	const { projectId } = input;
	const documentType = input.documentType.toUpperCase();
	const intent = COMPANY_CONTEXT_INTENTS[documentType];
	if (!intent) {
		return [];
	}

	try {
		heartbeat({ phase: "retrieving_company_context" });
	} catch {
		// Not in an activity context (e.g. tests).
	}

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(
			() => resolve(TIMED_OUT),
			COMPANY_RETRIEVAL_TIMEOUT_MS,
		);
	});
	try {
		const entries = await Promise.race([
			findCompanyContextEntries(
				{ ...input, documentType, intent },
				controller.signal,
			),
			deadline,
		]);
		if (entries !== TIMED_OUT) {
			return entries;
		}
		// Cancels the embedding call if that is where it hangs; whatever
		// else is in flight finishes unobserved and is ignored.
		controller.abort();
		logger.warn(
			"[CompanyContext] Company context retrieval timed out; continuing with project context only",
			{
				projectId,
				documentType,
				timeoutMs: COMPANY_RETRIEVAL_TIMEOUT_MS,
			},
		);
		return [];
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The retrieval `retrieveCompanyContextEntries` bounds. Never throws; once
 * `signal` is aborted it stops at its next step and logs nothing, since the
 * caller already logged the timeout.
 */
async function findCompanyContextEntries(
	input: {
		projectId: string;
		userId: string;
		documentType: string;
		intent: string;
	},
	signal: AbortSignal,
): Promise<string[]> {
	const { projectId, userId, documentType, intent } = input;
	try {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				organizationId: true,
				name: true,
				description: true,
				goals: true,
			},
		});
		const organizationId = project?.organizationId;
		if (!project || !organizationId) {
			return [];
		}

		if (!(await isFeatureEnabled("COMPANY_CONTEXT", organizationId))) {
			return [];
		}
		if (!(await isOrganizationMember(userId, organizationId))) {
			logger.info(
				"[CompanyContext] Author is not a member of the project's organization; company context not retrieved",
				{ projectId, organizationId },
			);
			return [];
		}

		const model = await resolveCompanyEmbeddingModel({
			organizationId,
			userId,
		});
		if (!model.supported) {
			logger.warn(
				"[CompanyContext] Skipping company context: unsupported embedding model for the company context collection",
				{
					projectId,
					organizationId,
					embeddingModel: model.identity,
					dimensions: model.dimensions,
				},
			);
			return [];
		}

		const readyRows: ReadySource[] = await db.companyContextSource.findMany(
			{
				where: {
					organizationId,
					...companyContextReadyWhere(model.identity),
				},
				select: READY_SOURCE_SELECT,
			},
		);
		if (readyRows.length === 0) {
			return [];
		}
		const readySources = new Map(readyRows.map((row) => [row.id, row]));

		// The project path's threshold, from the same settings.
		const ragSettings = await getProjectRagSettings(projectId);
		const query = buildCompanyContextQuery(intent, project);
		if (signal.aborted) {
			return [];
		}
		// Embedded with the organization's model, the one `model` names and
		// the sources were written with — never the author's personal one.
		const queryEmbedding = await generateEmbedding(
			query,
			{
				userId,
				organizationId,
				projectId,
				tags: ["company-context-retrieval"],
				...COMPANY_EMBEDDING_RESOLUTION,
			},
			undefined,
			signal,
		);
		// The call resolves the model again. Should the organization have
		// switched models in between, the query vector lives in another
		// embedding space than the ready sources': no search this run.
		const queryModel = companyEmbeddingIdentity(queryEmbedding);
		if (queryModel !== model.identity) {
			logger.info(
				"[CompanyContext] The organization's embedding model changed during retrieval; company context not retrieved this run",
				{
					projectId,
					organizationId,
					embeddingModel: model.identity,
					queryModel,
				},
			);
			return [];
		}
		if (signal.aborted) {
			return [];
		}
		const { embedding } = queryEmbedding;

		const hits = await searchCompanyContexts({
			organizationId,
			embeddingModel: model.identity,
			queryEmbedding: embedding,
			sourceIds: [...readySources.keys()],
			topK: COMPANY_SEARCH_TOP_K,
			minSimilarity: ragSettings.similarityThreshold ?? 0.5,
		});

		const liveHits = await keepLivePageHits(hits, {
			organizationId,
			sourceIds: [...readySources.keys()],
			embeddingModel: model.identity,
		});
		const entries = selectVendorEntries(liveHits, readySources);
		logger.info("[CompanyContext] Company context retrieved", {
			projectId,
			organizationId,
			documentType,
			readySourceCount: readyRows.length,
			hitCount: hits.length,
			goneHitCount: hits.length - liveHits.length,
			entryCount: entries.length,
		});
		return entries;
	} catch (error) {
		if (signal.aborted) {
			return [];
		}
		logger.warn(
			"[CompanyContext] Company context retrieval failed; continuing with project context only",
			{
				projectId,
				documentType,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return [];
	}
}
