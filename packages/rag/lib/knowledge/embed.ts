/**
 * Embedding one knowledge entry for semantic search: generate the vector,
 * store it with the entry's topic and type, and mark the entry embedded.
 * Shared by the API (an entry saved through Fabric or the plugin) and the
 * repository import (entries created from a repository's notes), so both
 * index the same way.
 *
 * Never throws: an entry that cannot be embedded stays keyword-searchable,
 * and `embedPendingKnowledgeEntries` retries it later.
 */
import {
	type KnowledgeEntry,
	type KnowledgeTenancy,
	type KnowledgeTopic,
	markKnowledgeEntryEmbedded,
} from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbedding } from "../embedding/generator";
import { upsertKnowledgeVector } from "./store";

function embeddingText(entry: Pick<KnowledgeEntry, "title" | "body">): string {
	return `${entry.title}\n\n${entry.body}`.slice(0, 24_000);
}

export async function embedKnowledgeEntry(
	entry: KnowledgeEntry,
	topic: Pick<KnowledgeTopic, "id" | "key" | "title">,
	typeKey: string,
	tenancy: KnowledgeTenancy,
): Promise<boolean> {
	try {
		const text = embeddingText(entry);
		const { embedding } = await generateEmbedding(text, {
			userId: entry.authorUserId,
			organizationId: tenancy.organizationId ?? undefined,
			projectId: entry.projectId,
			jobType: "context-enrichment",
		});
		const pointId = await upsertKnowledgeVector(embedding, {
			entryId: entry.id,
			projectId: entry.projectId,
			organizationId: tenancy.organizationId,
			topicId: topic.id,
			topicKey: topic.key,
			topicTitle: topic.title,
			typeKey,
			authorUserId: entry.authorUserId,
			role: entry.role,
			title: entry.title,
			text: text.slice(0, 2_000),
			createdAtMs: entry.createdAt.getTime(),
		});
		await markKnowledgeEntryEmbedded(entry.id, pointId);
		return true;
	} catch (error) {
		logger.warn(
			"[Knowledge] embedding failed; entry stays keyword-searchable",
			{
				entryId: entry.id,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return false;
	}
}
