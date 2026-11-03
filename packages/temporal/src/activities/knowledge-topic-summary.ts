/**
 * Knowledge hub: regenerates a topic's living document from its entries
 * (specs/2026-10-21-ai-artifacts-hub §5.5).
 *
 * Every entry of the topic that still counts (not superseded, its type not
 * EXCLUDED, within retention, only the newest of a LATEST_WINS type) is folded
 * into one summary written for a person picking the topic up. Each run writes
 * a new KnowledgeTopicSummary row; older rows stay as history.
 */

import { generateText, getAIModelWithMetadata } from "@repo/ai";
import {
	completeKnowledgeTopicSummary,
	createKnowledgeTopicSummary,
	db,
	getKnowledgeEntriesForSummary,
	getKnowledgeProjectTenancy,
} from "@repo/database";
import { logger } from "@repo/logs";

export interface KnowledgeTopicSummaryInput {
	projectId: string;
	topicId: string;
}

export interface KnowledgeTopicSummaryResult {
	summaryId: string | null;
	status: "COMPLETED" | "FAILED" | "SKIPPED";
	/** True when entries newer than the summary arrived while it ran. */
	stale: boolean;
}

/** Characters of entry text sent to the model; older entries are trimmed first. */
const MAX_INPUT_CHARS = 60_000;

const SYSTEM_PROMPT = `You maintain the living document of one topic in a software project's knowledge base.
The topic gathers entries written by several engineers and their AI tools: notes, specs, investigations, decisions, journals, handoffs, test plans.
Write one markdown document that a person picking the topic up reads first:
- "## Current state": where things stand now (prefer the newest information; the newest handoff describes the current state).
- "## Key decisions": decisions and their reasons.
- "## Findings": important facts, investigations and gotchas.
- "## Open questions and next steps".
- "## Contributors": who contributed what, by role when given.
Cite entries as [E1], [E2]… using the markers given. Never invent facts. When entries contradict each other, say so and prefer the newer one. Keep it under 900 words.`;

export async function generateKnowledgeTopicSummaryActivity(
	input: KnowledgeTopicSummaryInput,
): Promise<KnowledgeTopicSummaryResult> {
	const tenancy = await getKnowledgeProjectTenancy(input.projectId);
	if (!tenancy) {
		return { summaryId: null, status: "SKIPPED", stale: false };
	}
	const topic = await db.knowledgeTopic.findFirst({
		where: { id: input.topicId, projectId: input.projectId },
	});
	if (!topic) {
		return { summaryId: null, status: "SKIPPED", stale: false };
	}
	const entries = await getKnowledgeEntriesForSummary(
		input.projectId,
		input.topicId,
	);
	if (entries.length === 0) {
		return { summaryId: null, status: "SKIPPED", stale: false };
	}

	const authorIds = [...new Set(entries.map((e) => e.authorUserId))];
	const authors = await db.user.findMany({
		where: { id: { in: authorIds } },
		select: { id: true, name: true },
	});
	const authorName = new Map(authors.map((a) => [a.id, a.name ?? "Unknown"]));

	// Newest entries are kept whole; older ones are dropped when over budget.
	const blocks: string[] = [];
	let used = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) {
			continue;
		}
		const block = [
			`[E${i + 1}] ${entry.type.name} — "${entry.title}"`,
			`by ${authorName.get(entry.authorUserId) ?? "Unknown"}${entry.role ? ` (${entry.role})` : ""}, ${entry.createdAt.toISOString()}`,
			entry.body,
		].join("\n");
		if (used + block.length > MAX_INPUT_CHARS && blocks.length > 0) {
			break;
		}
		blocks.unshift(block);
		used += block.length;
	}

	const summary = await createKnowledgeTopicSummary(
		input.projectId,
		input.topicId,
		tenancy,
	);
	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE", complexity: "medium" },
			{
				userId: tenancy.userId,
				organizationId: tenancy.organizationId ?? undefined,
				projectId: input.projectId,
				jobType: "context-summarization",
			},
		);
		const result = await generateText({
			model,
			instructions: SYSTEM_PROMPT,
			prompt: `Topic: ${topic.title}\n\nEntries (oldest first):\n\n${blocks.join("\n\n---\n\n")}`,
		});
		trackUsage();
		const newest = entries[entries.length - 1];
		await completeKnowledgeTopicSummary(summary.id, {
			ok: true,
			content: result.text.trim(),
			coveredThrough: newest?.createdAt ?? null,
			entryCount: entries.length,
			references: entries.map((e, i) => ({
				marker: `E${i + 1}`,
				entryId: e.id,
				title: e.title,
				authorUserId: e.authorUserId,
				createdAt: e.createdAt.toISOString(),
			})),
			model: metadata.modelString,
		});
		const newer = await db.knowledgeEntry.count({
			where: {
				topicId: input.topicId,
				createdAt: { gt: newest?.createdAt ?? new Date(0) },
			},
		});
		return { summaryId: summary.id, status: "COMPLETED", stale: newer > 0 };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("[KnowledgeSummary] generation failed", {
			topicId: input.topicId,
			error: message,
		});
		await completeKnowledgeTopicSummary(summary.id, {
			ok: false,
			error: message,
		});
		return { summaryId: summary.id, status: "FAILED", stale: false };
	}
}
