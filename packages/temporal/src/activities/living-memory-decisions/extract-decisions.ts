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
 *
 * The record says whether the file met a limit: longer than the model reads
 * (`contentTruncated`), or listing more decisions than are kept
 * (`decisionsCapped`), so the Decisions tab can say the file was only partly
 * read. A decision that names one of the project's features or bugs is linked
 * to it (`workItem`).
 *
 * The extraction announces its candidates to the project's reviewers. For a
 * scan a member asked for, that member is left out: they are already looking.
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
	type LivingMemoryDecisionWorkItem,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	LIVING_MEMORY_DECISION_FILE_CHAR_CAP as FILE_CHAR_CAP,
	LIVING_MEMORY_DECISION_MAX_PER_FILE as MAX_DECISIONS,
} from "@repo/utils/living-memory-decision-limits";
import {
	LIVING_MEMORY_DECISIONS_FALLBACK_BODY,
	LIVING_MEMORY_DECISIONS_PROMPT_AGENT_KEY,
} from "@repo/utils/living-memory-decisions-prompt";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
import { resolveBoundPromptText } from "../lib/bound-prompt";
import { resolveProjectFeatureRef } from "../shared/project-feature-reads";

/** A feature or bug identifier as a file writes it: "F-012", "B-7", "US-3". */
const WORK_ITEM_REF = /\b(F|B|US)-(\d+)\b/g;

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
	/**
	 * False records without notifying. Extractions started by a requested
	 * scan before scans notified reviewers still carry it.
	 */
	notify?: boolean;
	/** The member whose own scan started this extraction; not notified. */
	requestedByUserId?: string;
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
	let contentTruncated = false;
	let decisionsCapped = false;

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
		const normalized = normalizeDecisions(result.output.decisions);
		decisions = await linkWorkItems(normalized.decisions, {
			projectId: context.projectId,
			sourcePath,
			content: context.content,
		});
		decisionsCapped = normalized.capped;
		contentTruncated = context.content.length > FILE_CHAR_CAP;
		model = resolved.metadata.modelString;
	}

	if (contentTruncated || decisionsCapped) {
		logger.warn("[LivingMemoryDecisions] file only partly read", {
			contextId: context.id,
			contentLength: context.content.length,
			contentTruncated,
			decisionsCapped,
		});
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
				contentTruncated,
				decisionsCapped,
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
		await createDecisionCandidatesReadyNotifications({
			extractionId,
			...(input.requestedByUserId
				? { excludeUserIds: [input.requestedByUserId] }
				: {}),
		});
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

/**
 * Trim, drop blanks and repeats, and cap the list. `capped` when a distinct
 * decision past the cap was dropped.
 */
function normalizeDecisions(
	raw: z.infer<typeof ExtractedDecisionsSchema>["decisions"],
): { decisions: LivingMemoryDecision[]; capped: boolean } {
	const seen = new Set<string>();
	const out: LivingMemoryDecision[] = [];
	for (const entry of raw) {
		const text = entry.text.trim();
		const key = text.toLowerCase();
		if (!text || seen.has(key)) {
			continue;
		}
		seen.add(key);
		if (out.length === MAX_DECISIONS) {
			return { decisions: out, capped: true };
		}
		const rationale = entry.rationale?.trim();
		const sourceQuote = entry.sourceQuote?.trim();
		out.push({
			text,
			...(rationale ? { rationale } : {}),
			...(sourceQuote ? { sourceQuote } : {}),
		});
	}
	return { decisions: out, capped: false };
}

/**
 * Link each decision to the project's feature or bug it came from, where
 * that can be told: the one identifier its quote names, else the one its
 * text names, else the one the whole file (path and content) names. Two or
 * more distinct identifiers in the same place name no single work item, so
 * none is linked. Only a work item of this project is ever linked.
 */
async function linkWorkItems(
	decisions: LivingMemoryDecision[],
	file: { projectId: string; sourcePath: string; content: string },
): Promise<LivingMemoryDecision[]> {
	if (decisions.length === 0) {
		return decisions;
	}
	const fileRef = soleRef(
		workItemRefs(`${file.sourcePath}\n${file.content}`),
	);
	const resolved = new Map<string, LivingMemoryDecisionWorkItem | null>();
	const linked: LivingMemoryDecision[] = [];
	for (const decision of decisions) {
		const quoteRefs = workItemRefs(decision.sourceQuote ?? "");
		const ownRefs =
			quoteRefs.length > 0 ? quoteRefs : workItemRefs(decision.text);
		const ref = ownRefs.length === 0 ? fileRef : soleRef(ownRefs);
		if (!ref) {
			linked.push(decision);
			continue;
		}
		let workItem = resolved.get(ref);
		if (workItem === undefined) {
			const row = await resolveProjectFeatureRef(ref, file.projectId);
			workItem = row ? { id: row.id, identifier: row.identifier } : null;
			resolved.set(ref, workItem);
		}
		linked.push(workItem ? { ...decision, workItem } : decision);
	}
	return linked;
}

/** The distinct identifiers `text` names, normalized ("F-012" is "F-12"). */
function workItemRefs(text: string): string[] {
	const refs = new Set<string>();
	for (const [, prefix, digits] of text.matchAll(WORK_ITEM_REF)) {
		if (prefix && digits) {
			refs.add(`${prefix}-${Number(digits)}`);
		}
	}
	return [...refs];
}

/** The identifier, when exactly one is named. */
function soleRef(refs: string[]): string | undefined {
	return refs.length === 1 ? refs[0] : undefined;
}

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "P2002"
	);
}
