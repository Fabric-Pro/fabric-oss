/**
 * Daily Brief — Release Notes Summarizer
 *
 * One LLM call per regenerate. Reads the merged-PR titles and (truncated)
 * bodies for prod and staging, returns a 2-3 sentence plain-language
 * description of each environment's release suitable for non-engineers.
 *
 * Output is structured: { prod?: string, staging?: string }. Either field is
 * omitted when its bucket is empty or the LLM returned an empty string.
 *
 * Failure semantics: LLM errors propagate. The workflow wraps this activity
 * in Promise.allSettled and records a partialFailure(source: 'releaseNotes')
 * on rejection, so the rest of the brief still ships and the UI can surface
 * "summary unavailable."
 */
import {
	generateObject,
	getAIModelWithMetadata,
	getCurrentDateContext,
} from "@repo/ai";
// Imported from the SUBPATH (not @repo/ai root) so it stays UNMOCKED in tests
// that mock the @repo/ai root module (uniform rule across the budget sites).
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import type { GithubItem, ReleaseNotesSummary } from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";

const PROMPT_PR_LIMIT = 40;
const PROMPT_TITLE_CAP = 160;

export interface SummarizeReleaseNotesInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	prodPrs: GithubItem[];
	stagingPrs: GithubItem[];
}

export interface SummarizeReleaseNotesOutput {
	summary: ReleaseNotesSummary;
	aiUsageTokens: number | null;
}

const LlmOutputSchema = z.object({
	prod: z
		.string()
		.optional()
		.describe(
			"2-3 sentence plain-language description of what shipped to prod. Empty string if the prod bucket has nothing notable.",
		),
	staging: z
		.string()
		.optional()
		.describe(
			"2-3 sentence plain-language description of what's currently merged to staging. Empty string if the staging bucket has nothing notable.",
		),
});

interface PromptPr {
	prNumber: number;
	repoFullName: string;
	title: string;
	author?: string;
	body?: string;
}

function toPromptPr(item: GithubItem): PromptPr {
	const title =
		item.title.length > PROMPT_TITLE_CAP
			? `${item.title.slice(0, PROMPT_TITLE_CAP)}…`
			: item.title;
	return {
		prNumber: item.prNumber,
		repoFullName: item.repoFullName,
		title,
		...(item.author ? { author: item.author } : {}),
		...(item.body ? { body: item.body } : {}),
	};
}

export function buildReleaseNotesPrompt(input: {
	prodPrs: PromptPr[];
	stagingPrs: PromptPr[];
}): string {
	const dateContext = getCurrentDateContext();
	return `You are writing short release notes for a daily project brief read by a mix of engineers and non-engineers. For each environment's pull/merge request list, write a 2-3 sentence plain-language description of what shipped. Cite specific behavior changes by what they do (e.g. "fixes scroll position when reading documents"), not by pull/merge request number. Group related work where natural.

Rules:
- Do NOT invent. Only describe changes evidenced by the titles or bodies.
- Skip routine maintenance, dependency bumps, CI tweaks, and pure refactors UNLESS they enable a user-visible change worth mentioning.
- If an environment has nothing user-notable, return an empty string for that field — do not pad with fluff.
- Plain language: short sentences, no marketing tone, no emoji.
- Don't start with "This release..." or similar boilerplate. Lead with the change.

${dateContext}

Prod pull/merge requests (${input.prodPrs.length}) — already deployed to production:
${JSON.stringify(input.prodPrs)}

Staging pull/merge requests (${input.stagingPrs.length}) — merged to main, currently on staging:
${JSON.stringify(input.stagingPrs)}
`;
}

export async function summarizeReleaseNotesActivity(
	input: SummarizeReleaseNotesInput,
): Promise<SummarizeReleaseNotesOutput> {
	const { projectId, organizationId, userId, prodPrs, stagingPrs } = input;

	heartbeat("summarizeReleaseNotes: starting");

	if (prodPrs.length === 0 && stagingPrs.length === 0) {
		return { summary: {}, aiUsageTokens: null };
	}

	const promptProd = prodPrs.slice(0, PROMPT_PR_LIMIT).map(toPromptPr);
	const promptStaging = stagingPrs.slice(0, PROMPT_PR_LIMIT).map(toPromptPr);

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "SIMPLE" },
		{
			userId,
			organizationId: organizationId ?? undefined,
			projectId,
			jobType: "daily-brief",
		},
	);

	logger.info("[Daily Brief] Release notes summarizer model", {
		projectId,
		modelString: metadata.modelString,
		provider: metadata.provider,
		prodCount: prodPrs.length,
		stagingCount: stagingPrs.length,
	});

	const prompt = buildReleaseNotesPrompt({
		prodPrs: promptProd,
		stagingPrs: promptStaging,
	});

	heartbeat("summarizeReleaseNotes: waiting for LLM response");
	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat("summarizeReleaseNotes: waiting for LLM response");
		} catch {
			// activity may have been cancelled
		}
	}, 30_000);

	// Bounded 2-3 sentence per-environment summary — but that still exceeds the
	// 4,096 Anthropic unrecognized-model fallback and can clip under Databricks'
	// 8,192 default. Scaled mode with inputChars 0 requests the floor (16,384),
	// clamped to the provider cap and context window. `undefined` leaves other
	// providers on their SDK defaults.
	const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
		inputChars: 0,
		promptChars: prompt.length,
	});

	let llmResult: Awaited<
		ReturnType<typeof generateObject<typeof LlmOutputSchema>>
	>;
	try {
		llmResult = await generateObject({
			model,
			schema: LlmOutputSchema,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});
	} finally {
		clearInterval(heartbeatInterval);
	}

	trackUsage();

	const summary: ReleaseNotesSummary = {
		...(llmResult.object.prod && llmResult.object.prod.trim().length > 0
			? { prod: llmResult.object.prod.trim() }
			: {}),
		...(llmResult.object.staging &&
		llmResult.object.staging.trim().length > 0
			? { staging: llmResult.object.staging.trim() }
			: {}),
	};

	const aiUsageTokens =
		(llmResult.usage?.totalTokens as number | undefined) ??
		(llmResult.usage?.inputTokens ?? 0) +
			(llmResult.usage?.outputTokens ?? 0);

	return {
		summary,
		aiUsageTokens: aiUsageTokens || null,
	};
}
