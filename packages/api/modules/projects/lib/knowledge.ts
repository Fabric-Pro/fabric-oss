/**
 * Project knowledge hub service (specs/2026-10-21-ai-artifacts-hub §5.5–5.6).
 *
 * Shared by the oRPC procedures (web UI), the v1 REST routes (CLI plugin
 * render) and the MCP gateway tools (engineers' AI tools). Callers check
 * project access first; this module copies the project's own tenancy onto
 * every row it writes.
 *
 * Writes are append-only. After an entry lands it is embedded for semantic
 * search (best effort: a failure leaves the entry readable and keyword
 * searchable, and `embedPendingKnowledgeEntries` retries it) and the topic's
 * summary run is started (debounced in Temporal).
 */

import {
	type AddKnowledgeEntryInput,
	addKnowledgeEntry,
	db,
	findKnowledgeTopic,
	getKnowledgeProjectTenancy,
	getKnowledgeTimeline,
	getLatestKnowledgeTopicSummary,
	type KnowledgeTenancy,
	listKnowledgeTopics,
	listKnowledgeTypes,
	listUnembeddedKnowledgeEntries,
	type Prisma,
} from "@repo/database";
import { logger } from "@repo/logs";
import { generateQueryEmbedding } from "@repo/rag/lib/embedding/query";
import { embedKnowledgeEntry } from "@repo/rag/lib/knowledge/embed";
import {
	type KnowledgeVectorHit,
	searchKnowledgeVectors,
} from "@repo/rag/lib/knowledge/store";
import { getTemporalClient } from "@repo/temporal";
import { startKnowledgeTopicSummaryWorkflow } from "@repo/temporal/knowledge-summary-start";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

class KnowledgeProjectNotFoundError extends Error {
	constructor() {
		super("Project not found");
		this.name = "KnowledgeProjectNotFoundError";
	}
}

async function requireTenancy(projectId: string): Promise<KnowledgeTenancy> {
	const tenancy = await getKnowledgeProjectTenancy(projectId);
	if (!tenancy) {
		throw new KnowledgeProjectNotFoundError();
	}
	return tenancy;
}

// ---------------------------------------------------------------------------
// Field validation: the subset of JSON Schema a type's fieldSchema may use
// (object with typed properties, `required`, `enum`). Enough for templates
// like { status: enum, severity: enum, affectedArea: string }.
// ---------------------------------------------------------------------------

type FieldSchema = {
	type?: string;
	properties?: Record<string, { type?: string; enum?: unknown[] }>;
	required?: string[];
	additionalProperties?: boolean;
};

function validateKnowledgeFields(
	schemaValue: Prisma.JsonValue,
	fields: Prisma.InputJsonValue | null | undefined,
): string | null {
	const schema = schemaValue as FieldSchema | null;
	if (!schema || typeof schema !== "object") {
		return null;
	}
	const value = (fields ?? {}) as Record<string, unknown>;
	if (typeof value !== "object" || Array.isArray(value)) {
		return "fields must be an object";
	}
	for (const name of schema.required ?? []) {
		if (
			value[name] === undefined ||
			value[name] === null ||
			value[name] === ""
		) {
			return `fields.${name} is required for this type`;
		}
	}
	for (const [name, item] of Object.entries(value)) {
		const rule = schema.properties?.[name];
		if (!rule) {
			if (schema.additionalProperties === false) {
				return `fields.${name} is not a field of this type`;
			}
			continue;
		}
		if (rule.enum && !rule.enum.includes(item)) {
			return `fields.${name} must be one of: ${rule.enum.join(", ")}`;
		}
		if (rule.type) {
			const actual = Array.isArray(item) ? "array" : typeof item;
			const expected = rule.type === "integer" ? "number" : rule.type;
			if (actual !== expected) {
				return `fields.${name} must be a ${rule.type}`;
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type AddKnowledgeParams = Omit<AddKnowledgeEntryInput, "tenancy">;

export async function addProjectKnowledge(params: AddKnowledgeParams) {
	const tenancy = await requireTenancy(params.projectId);
	const result = await addKnowledgeEntry(
		{ ...params, tenancy },
		validateKnowledgeFields,
	);
	if (!result.duplicate) {
		await embedKnowledgeEntry(
			result.entry,
			result.topic,
			result.type.key,
			tenancy,
		);
		startTopicSummary(params.projectId, result.topic.id);
	}
	return result;
}

/** Retries embedding for entries that were stored without a vector. */
export async function embedPendingKnowledgeEntries(
	projectId: string,
	limit = 50,
): Promise<number> {
	const tenancy = await requireTenancy(projectId);
	const pending = await listUnembeddedKnowledgeEntries(projectId, limit);
	let done = 0;
	for (const entry of pending) {
		const [topic, type] = await Promise.all([
			db.knowledgeTopic.findUnique({ where: { id: entry.topicId } }),
			db.knowledgeArtifactType.findUnique({
				where: { id: entry.typeId },
			}),
		]);
		if (
			topic &&
			type &&
			(await embedKnowledgeEntry(entry, topic, type.key, tenancy))
		) {
			done++;
		}
	}
	return done;
}

/** Starts (or joins) the topic's debounced summary run. Fire-and-forget. */
export function startTopicSummary(projectId: string, topicId: string): void {
	(async () => {
		try {
			const client = await getTemporalClient();
			await startKnowledgeTopicSummaryWorkflow(
				client,
				{ projectId, topicId },
				{ decorateStartOptions: withCorrelationMemo },
			);
		} catch (error) {
			logger.error("[Knowledge] could not start the topic summary run", {
				topicId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	})();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listProjectKnowledgeTypes(
	projectId: string,
	options: { includeArchived?: boolean } = {},
) {
	const tenancy = await requireTenancy(projectId);
	return listKnowledgeTypes(projectId, tenancy, options);
}

export type KnowledgeSearchHit = {
	entryId: string;
	topicId: string;
	topicKey: string;
	topicTitle: string;
	type: string;
	title: string;
	snippet: string;
	authorUserId: string;
	role: string | null;
	createdAt: string;
	score: number | null;
};

/**
 * Semantic search over the project's knowledge entries, with keyword search
 * as the fallback when the query cannot be embedded (no embedding provider,
 * vector store down) or semantic search finds nothing.
 */
export async function searchProjectKnowledgeEntries(params: {
	projectId: string;
	userId: string;
	query: string;
	topic?: string;
	types?: string[];
	authorUserId?: string;
	since?: Date;
	limit?: number;
}): Promise<{ hits: KnowledgeSearchHit[]; mode: "semantic" | "keyword" }> {
	const tenancy = await requireTenancy(params.projectId);
	const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
	const topic = params.topic
		? await findKnowledgeTopic(params.projectId, params.topic)
		: null;
	if (params.topic && !topic) {
		return { hits: [], mode: "keyword" };
	}

	let semantic: KnowledgeVectorHit[] = [];
	try {
		const { embedding } = await generateQueryEmbedding(params.query, {
			userId: params.userId,
			organizationId: tenancy.organizationId ?? undefined,
			projectId: params.projectId,
			jobType: "context-enrichment",
		});
		semantic = await searchKnowledgeVectors(
			embedding,
			{
				projectId: params.projectId,
				topicId: topic?.id,
				typeKeys: params.types,
				authorUserId: params.authorUserId,
				sinceMs: params.since?.getTime(),
			},
			limit,
		);
	} catch (error) {
		logger.warn("[Knowledge] semantic search unavailable; using keywords", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (semantic.length > 0) {
		return {
			mode: "semantic",
			hits: semantic.map((hit) => ({
				entryId: hit.entryId,
				topicId: hit.topicId,
				topicKey: hit.topicKey,
				topicTitle: hit.topicTitle,
				type: hit.typeKey,
				title: hit.title,
				snippet: hit.text.slice(0, 600),
				authorUserId: hit.authorUserId,
				role: hit.role,
				createdAt: new Date(hit.createdAtMs).toISOString(),
				score: hit.score,
			})),
		};
	}

	const words = params.query
		.split(/\s+/)
		.filter((w) => w.length > 2)
		.slice(0, 6);
	const rows = await db.knowledgeEntry.findMany({
		where: {
			projectId: params.projectId,
			...(topic ? { topicId: topic.id } : {}),
			...(params.types?.length
				? { type: { key: { in: params.types } } }
				: {}),
			...(params.authorUserId
				? { authorUserId: params.authorUserId }
				: {}),
			...(params.since ? { createdAt: { gte: params.since } } : {}),
			...(words.length
				? {
						OR: words.flatMap((w) => [
							{
								title: {
									contains: w,
									mode: "insensitive" as const,
								},
							},
							{
								body: {
									contains: w,
									mode: "insensitive" as const,
								},
							},
						]),
					}
				: {}),
		},
		include: { topic: true, type: { select: { key: true } } },
		orderBy: { createdAt: "desc" },
		take: limit,
	});
	return {
		mode: "keyword",
		hits: rows.map((row) => ({
			entryId: row.id,
			topicId: row.topicId,
			topicKey: row.topic.key,
			topicTitle: row.topic.title,
			type: row.type.key,
			title: row.title,
			snippet: row.body.slice(0, 600),
			authorUserId: row.authorUserId,
			role: row.role,
			createdAt: row.createdAt.toISOString(),
			score: null,
		})),
	};
}

/** A topic with its latest summary and a page of its timeline. */
export async function getProjectKnowledgeTopic(params: {
	projectId: string;
	topic: string;
	limit?: number;
	cursor?: string;
	newestFirst?: boolean;
}) {
	await requireTenancy(params.projectId);
	const topic = await findKnowledgeTopic(params.projectId, params.topic);
	if (!topic) {
		return null;
	}
	const [summary, timeline] = await Promise.all([
		getLatestKnowledgeTopicSummary(params.projectId, topic.id),
		getKnowledgeTimeline(params.projectId, topic.id, {
			limit: params.limit,
			cursor: params.cursor,
			newestFirst: params.newestFirst,
		}),
	]);
	const pending = await db.knowledgeTopicSummary.findFirst({
		where: { topicId: topic.id, status: { in: ["PENDING", "RUNNING"] } },
		select: { id: true },
	});
	return {
		topic,
		summary,
		summaryInProgress: Boolean(pending),
		summaryStale: Boolean(
			topic.lastEntryAt &&
				(!summary?.coveredThrough ||
					summary.coveredThrough < topic.lastEntryAt),
		),
		...timeline,
	};
}

export async function listProjectKnowledgeTopics(params: {
	projectId: string;
	query?: string;
	authorUserId?: string;
	limit?: number;
	cursor?: string;
}) {
	await requireTenancy(params.projectId);
	return listKnowledgeTopics(params.projectId, params);
}

/** Display names for author ids (for timelines and search results). */
export async function knowledgeAuthorNames(
	userIds: string[],
): Promise<Record<string, string>> {
	const unique = [...new Set(userIds)];
	if (unique.length === 0) {
		return {};
	}
	const users = await db.user.findMany({
		where: { id: { in: unique } },
		select: { id: true, name: true, email: true },
	});
	return Object.fromEntries(
		users.map((u) => [u.id, u.name || u.email || "Unknown"]),
	);
}
