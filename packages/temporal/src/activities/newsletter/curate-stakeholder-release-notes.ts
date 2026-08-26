import {
	generateObject,
	getAIModelWithMetadata,
	getCurrentDateContext,
} from "@repo/ai";
// Imported from the SUBPATH (not @repo/ai root) so it stays UNMOCKED in tests
// that mock the @repo/ai root module (uniform rule across the budget sites).
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	type GithubItem,
	isCurrentOrgMember,
	NEWSLETTER_SCHEMA_VERSION,
	type NewsletterContent,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";

export interface CurateStakeholderReleaseNotesInput {
	projectId: string;
	organizationId: string | null;
	userId: string; // AI-attribution user (triggeredByUserId)
	projectName: string;
	prodPrs: GithubItem[];
}
export interface CurateStakeholderReleaseNotesOutput {
	content: NewsletterContent;
	aiUsageTokens: number | null;
}

const LlmOutputSchema = z.object({
	headline: z
		.string()
		.describe("Short, friendly headline for the update email."),
	intro: z
		.string()
		.describe(
			"1-2 sentence plain-language intro for external stakeholders.",
		),
	hasMajorFeatures: z
		.boolean()
		.describe(
			"True ONLY if there is at least one major user-facing feature worth announcing.",
		),
	highlights: z
		.array(
			z.object({
				title: z.string().describe("Short feature name, no jargon."),
				description: z
					.string()
					.describe("1-2 sentences on the user-facing benefit."),
				prUrl: z.string().optional(),
			}),
		)
		.describe(
			"Major user-facing features ONLY. Empty if nothing qualifies.",
		),
});

const PROMPT_PR_LIMIT = 40;
const PROMPT_TITLE_CAP = 160;

function buildPrompt(projectName: string, prs: GithubItem[]): string {
	const lines = prs.slice(0, PROMPT_PR_LIMIT).map((p) => {
		const title = p.title.slice(0, PROMPT_TITLE_CAP);
		const body = p.body ? ` — ${p.body.slice(0, 300)}` : "";
		return `- (#${p.prNumber}) ${title}${body}`;
	});
	return [
		"You are writing an external-stakeholder release-notes newsletter for a software project.",
		"Include ONLY major, user-facing feature additions and significant changes.",
		"EXCLUDE bug fixes, refactors, chores, CI, dependency bumps, tests, and internal/granular work.",
		"Write in a friendly, non-technical tone for customers and partners.",
		"If NOTHING qualifies as a major user-facing change, set hasMajorFeatures=false and return an empty highlights array.",
		"",
		getCurrentDateContext(),
		`Project: "${projectName}"`,
		"",
		"Merged-to-production pull requests in this period:",
		...lines,
	].join("\n");
}

export async function curateStakeholderReleaseNotesActivity(
	input: CurateStakeholderReleaseNotesInput,
): Promise<CurateStakeholderReleaseNotesOutput> {
	const { projectId, organizationId, userId, projectName, prodPrs } = input;
	heartbeat("curateStakeholderReleaseNotes: starting");

	const emptyResult: CurateStakeholderReleaseNotesOutput = {
		content: {
			schemaVersion: NEWSLETTER_SCHEMA_VERSION as 1,
			headline: "",
			intro: "",
			highlights: [],
			hasMajorFeatures: false,
		},
		aiUsageTokens: null,
	};

	if (prodPrs.length === 0) {
		return emptyResult;
	}

	// Point-of-use actor re-validation (TOCTOU): the sweep and dispatch already
	// checked, but model resolution prefers THIS user's PERSONAL provider, so
	// re-verify org membership right before resolving the model. An admin removed
	// between dispatch and now must not power the org send under their identity or
	// personal AI credits. Returning empty => the send finalizes SKIPPED_EMPTY
	// (no email), which is the observable, safe outcome.
	if (organizationId && !(await isCurrentOrgMember(userId, organizationId))) {
		logger.warn(
			"[Newsletter] Skipping AI curation: configuring admin is no longer a valid member of the organization",
			{ projectId, organizationId, userId },
		);
		return emptyResult;
	}

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "SIMPLE" },
		{
			userId,
			organizationId: organizationId ?? undefined,
			projectId,
			jobType: "newsletter-curation",
		},
	);

	const prompt = buildPrompt(projectName, prodPrs);
	heartbeat("curateStakeholderReleaseNotes: waiting for LLM response");
	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat(
				"curateStakeholderReleaseNotes: waiting for LLM response",
			);
		} catch {
			// activity may have been cancelled
		}
	}, 30_000);

	// Bounded curated stakeholder notes — but that still exceeds the 4,096
	// Anthropic unrecognized-model fallback and can clip under Databricks' 8,192
	// default. Scaled mode with inputChars 0 requests the floor (16,384), clamped
	// to the provider cap and context window. `undefined` leaves other providers
	// on their SDK defaults.
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

	const o = llmResult.object;
	const content: NewsletterContent = {
		schemaVersion: NEWSLETTER_SCHEMA_VERSION as 1,
		headline: o.headline,
		intro: o.intro,
		hasMajorFeatures: o.hasMajorFeatures && o.highlights.length > 0,
		highlights: o.highlights.map((h) => ({
			title: h.title,
			description: h.description,
			...(h.prUrl ? { prUrl: h.prUrl } : {}),
		})),
	};

	const aiUsageTokens =
		(llmResult.usage?.totalTokens as number | undefined) ??
		(llmResult.usage?.inputTokens ?? 0) +
			(llmResult.usage?.outputTokens ?? 0);

	return { content, aiUsageTokens: aiUsageTokens || null };
}
