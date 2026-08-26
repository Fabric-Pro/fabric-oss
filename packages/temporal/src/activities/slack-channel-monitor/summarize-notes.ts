/**
 * Shared >50k-char LLM summarization fallback for long notes/transcripts.
 *
 * Mirrors the meeting-transcript-sync summarizer (same threshold, same
 * centralized model resolution + usage logging, same fail-soft to truncated
 * content). Kept small and self-contained so the huddle-notes activity reuses it
 * without coupling to the Teams activity module.
 *
 * Per ai/llm-integration.md: resolve the model via getAIModelWithMetadata
 * (taskType "SIMPLE") — usage is recorded by the global interceptor — and
 * never let a summarizer failure block storage; fall back to truncated
 * content.
 */

import { generateText, getAIModelWithMetadata } from "@repo/ai";
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { logger } from "@repo/logs";

/** Maximum content length before LLM summarization kicks in. */
export const NOTES_SUMMARIZATION_THRESHOLD = 50_000;

export interface SummarizeNotesParams {
	/** The raw notes body (without the markdown header). */
	notes: string;
	/** Human-readable title used in the prompt + logging. */
	title: string;
	userId: string;
	organizationId?: string;
	projectId?: string;
}

/**
 * Summarize long notes via an LLM. Returns a `**Summary:**`-prefixed markdown
 * block on success; on empty output or any error, returns the notes truncated to
 * the threshold (fail-soft — storage is never blocked).
 */
export async function summarizeNotes(
	params: SummarizeNotesParams,
): Promise<string> {
	const { notes, title, userId, organizationId, projectId } = params;

	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE", complexity: "simple" },
			{
				userId,
				organizationId,
				projectId,
				jobType: "slack-channel-monitor",
			},
		);

		const summarySystem = `You are a meeting-notes summarizer. Create a concise, structured summary of the notes.
Focus on:
- Key decisions made
- Action items and who is responsible
- Important discussion topics and conclusions
- Any deadlines or commitments mentioned

Keep the summary under 3000 words. Use bullet points and clear headings.`;
		const summaryPrompt = `Notes: ${title}

${notes}

Provide a structured summary of these notes.`;

		// Bounded ~3,000-word summary — but that still exceeds the 4,096 Anthropic
		// unrecognized-model fallback and can clip under Databricks' 8,192 default.
		// Scaled mode with inputChars 0 requests the floor (16,384), clamped to the
		// provider cap and context window. `undefined` leaves other providers on
		// their SDK defaults.
		const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
			inputChars: 0,
			promptChars: summarySystem.length + summaryPrompt.length,
		});
		const response = await generateText({
			model,
			system: summarySystem,
			prompt: summaryPrompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});

		trackUsage();

		const summary = response.text || "";
		if (summary.trim().length === 0) {
			logger.warn(
				"[SlackHuddleIngest] LLM returned empty summary, using truncated notes",
			);
			return notes.substring(0, NOTES_SUMMARIZATION_THRESHOLD);
		}

		return `**Summary:**\n\n${summary}`;
	} catch (error) {
		logger.error("[SlackHuddleIngest] Failed to summarize notes", {
			error: error instanceof Error ? error.message : String(error),
		});
		return notes.substring(0, NOTES_SUMMARIZATION_THRESHOLD);
	}
}
