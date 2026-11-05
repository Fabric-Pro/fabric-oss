/**
 * Living Memory decision extraction: read one confirmed content version of a
 * synced knowledge file and record the decisions it holds, for the Decisions
 * tab to offer as review candidates.
 *
 * Runs once per (contextId, contentHash). The version is recorded even when
 * it holds no decision, so the same version is never read twice; a version
 * that no longer is the row's current one is skipped, because the newer one
 * gets its own extraction when its embedding confirms it.
 *
 * The instructions come from the Prompt Library (agent key
 * `living_memory_decision_extractor`, seeded as a SYSTEM prompt) with the
 * seeded body as the fallback; only the file itself is assembled here, fenced
 * as untrusted data.
 *
 * A project with no usable AI provider is skipped without a record, so a
 * later version extracts once a provider exists. Other model failures throw,
 * for the workflow's retry policy.
 */

import {
	AIProviderNotConfiguredError,
	generateText,
	getAIModelWithMetadata,
	Output,
} from "@repo/ai";
// Imported from the SUBPATH (not @repo/ai root) so it stays UNMOCKED in tests
// that mock the @repo/ai root module.
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { requireStructuredOutput } from "@repo/ai/lib/structured-output";
import {
	createDecisionCandidatesReadyNotifications,
	db,
	type LivingMemoryDecision,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	LIVING_MEMORY_DECISIONS_FALLBACK_BODY,
	LIVING_MEMORY_DECISIONS_PROMPT_AGENT_KEY,
} from "@repo/utils/living-memory-decisions-prompt";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
import { resolveBoundPromptText } from "../lib/bound-prompt";

/** How much of a file is read; the rest is cut with a marker. */
const FILE_CHAR_CAP = 60_000;
/** A file listing more than this is not a decision log; keep the first ones. */
const MAX_DECISIONS = 50;

const ExtractedDecisionsSchema = z.object({
	decisions: z.array(
		z.object({
			text: z.string(),
			rationale: z.string().optional(),
			sourceQuote: z.string().optional(),
		}),
	),
});

export interface ExtractLivingMemoryDecisionsInput {
	contextId: string;
	contentHash: string;
	/** False for a scan a member asked for; the default is to notify. */
	notify?: boolean;
}

export type ExtractLivingMemoryDecisionsResult =
	| { status: "recorded"; extractionId: string; decisionCount: number }
	| {
			status: "skipped";
			reason:
				| "not_eligible"
				| "content_changed"
				| "already_extracted"
				| "no_ai_provider";
	  };

export async function extractLivingMemoryDecisionsActivity(
	input: ExtractLivingMemoryDecisionsInput,
): Promise<ExtractLivingMemoryDecisionsResult> {
	const context = await db.projectContext.findUnique({
		where: { id: input.contextId },
		select: {
			id: true,
			projectId: true,
			userId: true,
			organizationId: true,
			sourcePath: true,
			contentHash: true,
			indexingExcluded: true,
			content: true,
			project: { select: { userId: true } },
		},
	});
	if (!context?.sourcePath || context.indexingExcluded) {
		return { status: "skipped", reason: "not_eligible" };
	}
	if (context.contentHash !== input.contentHash) {
		return { status: "skipped", reason: "content_changed" };
	}
	const existing = await db.projectContextDecisionExtraction.findUnique({
		where: {
			contextId_contentHash: {
				contextId: context.id,
				contentHash: input.contentHash,
			},
		},
		select: { id: true },
	});
	if (existing) {
		return { status: "skipped", reason: "already_extracted" };
	}

	heartbeat(`extractLivingMemoryDecisions: ${context.id}`);

	const sourcePath = context.sourcePath;
	const organizationId = context.organizationId ?? undefined;
	// The project owner is who background work on a project runs as.
	const actorUserId = context.project.userId;
	let decisions: LivingMemoryDecision[] = [];
	let model: string | null = null;

	if (context.content.trim().length > 0) {
		let resolved: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
		try {
			resolved = await getAIModelWithMetadata(
				{ taskType: "COMPLEX" },
				{
					userId: actorUserId,
					organizationId,
					projectId: context.projectId,
					jobType: "context-summarization",
				},
			);
		} catch (error) {
			if (error instanceof AIProviderNotConfiguredError) {
				return { status: "skipped", reason: "no_ai_provider" };
			}
			throw error;
		}

		const instructions = await resolveBoundPromptText({
			agentKey: LIVING_MEMORY_DECISIONS_PROMPT_AGENT_KEY,
			fallbackBody: LIVING_MEMORY_DECISIONS_FALLBACK_BODY,
			variables: {},
			scope: {
				userId: actorUserId,
				organizationId,
				projectId: context.projectId,
			},
			escape: false,
		});
		const prompt = buildFilePrompt(sourcePath, context.content);
		const maxOutputTokens = computeScaledOutputTokenBudget(
			resolved.metadata,
			{
				inputChars: Math.min(context.content.length, FILE_CHAR_CAP),
				promptChars: prompt.length + instructions.text.length,
			},
		);

		const result = await requireStructuredOutput(
			generateText({
				model: resolved.model,
				system: instructions.text,
				prompt,
				output: Output.object({ schema: ExtractedDecisionsSchema }),
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			}),
		);
		resolved.trackUsage();
		decisions = normalizeDecisions(result.output.decisions);
		model = resolved.metadata.modelString;
	}

	heartbeat(`extractLivingMemoryDecisions: recording ${context.id}`);

	let extractionId: string;
	try {
		const row = await db.projectContextDecisionExtraction.create({
			data: {
				contextId: context.id,
				projectId: context.projectId,
				contentHash: input.contentHash,
				sourcePath,
				decisions,
				model,
				userId: context.userId,
				organizationId: context.organizationId,
			},
			select: { id: true },
		});
		extractionId = row.id;
	} catch (error) {
		// A concurrent run recorded the same version first.
		if (isUniqueViolation(error)) {
			return { status: "skipped", reason: "already_extracted" };
		}
		throw error;
	}

	logger.info("[LivingMemoryDecisions] extraction recorded", {
		contextId: context.id,
		extractionId,
		decisionCount: decisions.length,
	});

	if (decisions.length > 0 && input.notify !== false) {
		await createDecisionCandidatesReadyNotifications({ extractionId });
	}
	return {
		status: "recorded",
		extractionId,
		decisionCount: decisions.length,
	};
}

/** The file, fenced as data. The instructions travel as the system prompt. */
function buildFilePrompt(sourcePath: string, content: string): string {
	const body =
		content.length > FILE_CHAR_CAP
			? `${content.slice(0, FILE_CHAR_CAP)}\n[truncated at ${FILE_CHAR_CAP} characters]`
			: content;
	return `List the decisions recorded in this file.

File path: ${sourcePath}

<file>
${body}
</file>`;
}

/** Trim, drop blanks and repeats, and cap the list. */
function normalizeDecisions(
	raw: z.infer<typeof ExtractedDecisionsSchema>["decisions"],
): LivingMemoryDecision[] {
	const seen = new Set<string>();
	const out: LivingMemoryDecision[] = [];
	for (const entry of raw) {
		const text = entry.text.trim();
		const key = text.toLowerCase();
		if (!text || seen.has(key)) {
			continue;
		}
		seen.add(key);
		const rationale = entry.rationale?.trim();
		const sourceQuote = entry.sourceQuote?.trim();
		out.push({
			text,
			...(rationale ? { rationale } : {}),
			...(sourceQuote ? { sourceQuote } : {}),
		});
		if (out.length === MAX_DECISIONS) {
			break;
		}
	}
	return out;
}

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "P2002"
	);
}
